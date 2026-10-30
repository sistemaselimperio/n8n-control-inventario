"""Barrera anti-duplicado contra Postgres real: carrera entre sedes, rollback
verdadero del traslado requerido y cierre de facturas faltantes."""

import asyncio
from datetime import datetime, timezone

import pytest

from app.models.entrega import SituacionEntrega
from app.services.duplicates import (
    EntregaDuplicada,
    aplicar_actualizacion_items,
    procesar_extraccion,
)
from app.models.entrega import ItemActualizacion
from tests.integration.conftest import eventos_en_logs

pytestmark = pytest.mark.integration

KW = dict(
    operador_id="operador-sin-empleado",
    capturado_at=datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc),
    evidencia_url="https://evidencia.prueba/f.webp",
    min_confidence=0.75,
    min_confidence_rechazo=0.35,
)


def extraccion(tipo="XYZ", numero="100", cantidad=5) -> dict:
    return {
        "tipo": tipo,
        "indicativo_numero": numero,
        "items": [{"descripcion": "75936  SAL BLANCA", "cantidad": cantidad}],
        "confianza": {"tipo": 0.95, "indicativo_numero": 0.95, "items": 0.9},
    }


def procesar(i: int, **extra):
    return procesar_extraccion(
        extraccion(**extra), hash_evidencia=f"hash-{i}", sede_origen_id=f"sede-{i}", **KW
    )


async def test_cinco_sedes_suben_el_mismo_documento_a_la_vez_y_queda_una_sola_fila(pg):
    resultados = await asyncio.gather(*(procesar(i) for i in range(5)), return_exceptions=True)

    errores = [r for r in resultados if isinstance(r, BaseException)]
    assert errores == []
    situaciones = sorted(r[0].value for r in resultados)
    assert situaciones == ["actualizable"] * 4 + ["nueva"]

    # Una sola entrega, con un solo juego de items (las que perdieron la carrera no insertan nada).
    assert await pg.fetchval("select count(*) from entregas where tipo = 'XYZ' and indicativo_numero = '100'") == 1
    assert await pg.fetchval("select count(*) from entrega_items") == 1
    # Todas apuntan a la misma entrega.
    assert len({r[1] for r in resultados}) == 1
    assert (await eventos_en_logs(pg)).count("entrega_insertada") == 1


async def test_la_misma_foto_para_otro_documento_cae_en_el_documento_original(pg):
    """hash_evidencia tambien es unico: se resuelve por el hash, sin TypeError."""
    primero = await procesar_extraccion(
        extraccion(numero="1"), hash_evidencia="foto-repetida", sede_origen_id="s1", **KW
    )
    segundo = await procesar_extraccion(
        extraccion(numero="2"), hash_evidencia="foto-repetida", sede_origen_id="s2", **KW
    )
    assert primero[0] is SituacionEntrega.NUEVA
    assert segundo[0] is SituacionEntrega.ACTUALIZABLE
    assert segundo[1] == primero[1]
    assert await pg.fetchval("select count(*) from entregas") == 1


async def test_ciclo_completo_nueva_actualizable_y_duplicado(pg):
    situacion, entrega_id, items, *_ = await procesar(1)
    assert situacion is SituacionEntrega.NUEVA

    situacion, mismo_id, *_ = await procesar(2)  # otra sede, aun con pendiente
    assert (situacion, mismo_id) == (SituacionEntrega.ACTUALIZABLE, entrega_id)

    await aplicar_actualizacion_items(
        entrega_id, [ItemActualizacion(id=items[0].id, entregado_hoy=5)], operador_id="op", sede_id="sede-1"
    )
    with pytest.raises(EntregaDuplicada):
        await procesar(3)

    eventos = await eventos_en_logs(pg)
    assert eventos.count("entrega_insertada") == 1
    assert "entrega_actualizada" in eventos
    assert eventos[-1] == "duplicado_bloqueado"


async def test_traslado_requerido_hace_rollback_real_y_no_cierra_el_reporte_de_factura(pg):
    sede_polo_sur = str(await pg.fetchval("insert into sedes (nombre, codigo) values ('Polo Sur', 'SEDE-02') returning id"))
    sede_centro = str(await pg.fetchval("insert into sedes (nombre, codigo) values ('Centro', 'SEDE-01') returning id"))
    await pg.execute(
        "insert into facturas_faltantes (tipo, indicativo_numero, sede_id, reportado_por)"
        " values ('FEI', '500', $1, 'bodega')",
        sede_centro,
    )

    # Escaneada desde la sede equivocada y sin traslado: no queda nada.
    situacion, entrega_id, *_ = await procesar_extraccion(
        extraccion("FEI", "500"), hash_evidencia="h-fei", sede_origen_id=sede_polo_sur, **KW
    )
    assert situacion is SituacionEntrega.NECESITA_TRASLADO and entrega_id is None
    assert await pg.fetchval("select count(*) from entregas") == 0
    assert await pg.fetchval("select count(*) from entrega_items") == 0
    assert await pg.fetchval("select estado from facturas_faltantes") == "pendiente"

    # Desde su sede duena se crea y el reporte se resuelve solo.
    situacion, entrega_id, *_ = await procesar_extraccion(
        extraccion("FEI", "500"), hash_evidencia="h-fei", sede_origen_id=sede_centro, **KW
    )
    assert situacion is SituacionEntrega.NUEVA
    fila = await pg.fetchrow("select estado, entrega_id::text as entrega_id from facturas_faltantes")
    assert (fila["estado"], fila["entrega_id"]) == ("resuelta", entrega_id)
    assert "factura_faltante_resuelta" in await eventos_en_logs(pg)


async def test_tipo_se_normaliza_antes_de_la_barrera(pg):
    await procesar_extraccion(extraccion(tipo="tb9", numero=" 77 "), hash_evidencia="h1", sede_origen_id="s", **KW)
    situacion, *_ = await procesar_extraccion(
        extraccion(tipo="TB9", numero="77"), hash_evidencia="h2", sede_origen_id="s", **KW
    )
    assert situacion is SituacionEntrega.ACTUALIZABLE
    assert await pg.fetchval("select count(*) from entregas") == 1
