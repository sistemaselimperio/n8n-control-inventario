"""procesar_extraccion(): alta, documento ya existente, carrera entre sedes y
compuertas previas al insert. La base es un doble guionado (tests/fakes.py);
la barrera real contra duplicados se prueba contra Postgres en tests/integration."""

from datetime import datetime, timezone

import pytest

from app.models.entrega import EstadoEntrega, SituacionEntrega
from app.services.duplicates import (
    DespachoEnRemisiones,
    EntregaDuplicada,
    ExtraccionIlegible,
    FacturaYaRegistrada,
    FacturacionRequerida,
    RemisionEnDespachos,
    RolNoAutorizado,
    _concepto_referencia_factura,
    procesar_extraccion,
)
from tests.fakes import violacion_unica
from tests.helpers import fila_item

KW = dict(
    hash_evidencia="hash-1",
    sede_origen_id="sede-1",
    operador_id="operador-1",
    capturado_at=datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc),
    evidencia_url="https://storage.prueba/foto.webp",
    min_confidence=0.75,
    min_confidence_rechazo=0.35,
)


def extraccion(tipo="XYZ", numero="100", conf_tipo=0.95, conf_num=0.95, items=None, conf_items=0.9) -> dict:
    return {
        "tipo": tipo,
        "indicativo_numero": numero,
        "items": items if items is not None else [{"descripcion": "75936  SAL BLANCA", "cantidad": 5}],
        "confianza": {"tipo": conf_tipo, "indicativo_numero": conf_num, "items": conf_items},
    }


def guionar_alta(conn, entrega_id="entrega-1"):
    conn.responder("fetchval", "insert into entregas", entrega_id)
    conn.responder("fetchval", "insert into entrega_items", "item-1", "item-2", "item-3")
    return conn


def guionar_existente(conn, pendientes=(2,), constraint="entregas_tipo_indicativo_numero_key"):
    """El insert choca contra el unique y la fila existente tiene esos items."""
    conn.responder("fetchval", "insert into entregas", violacion_unica(constraint))
    conn.responder(
        "fetchrow",
        "select id, tipo, indicativo_numero, es_faia, nota_general, firma_url",
        {
            "id": "entrega-existente",
            "tipo": "XYZ",
            "indicativo_numero": "100",
            "es_faia": True,
            "nota_general": "nota previa",
            "firma_url": "https://firma",
        },
    )
    conn.responder(
        "fetch", "from entrega_items i", [fila_item(f"i{n}", pendiente=p) for n, p in enumerate(pendientes)]
    )
    return conn


# --------------------------------------------------------------------------
# Documento nuevo
# --------------------------------------------------------------------------


async def test_documento_nuevo_se_inserta_con_items_en_pendiente(pool, conn):
    guionar_alta(conn)
    situacion, entrega_id, items, estado, tipo, numero, es_faia, nota, firma = await procesar_extraccion(
        extraccion(), **KW
    )
    assert situacion is SituacionEntrega.NUEVA
    assert entrega_id == "entrega-1"
    assert estado is EstadoEntrega.PROCESADA
    assert (tipo, numero) == ("XYZ", "100")
    assert (es_faia, nota, firma) == (False, None, None)
    # Lo leido por la IA queda como pendiente; nadie entrego nada todavia.
    assert [(i.cantidad_pendiente, i.cantidad_entregada, i.confirmado) for i in items] == [(5, 0, False)]
    assert conn.eventos_log() == ["entrega_insertada"]


async def test_tipo_se_normaliza_a_mayusculas_y_sin_espacios(pool, conn):
    guionar_alta(conn)
    await procesar_extraccion(extraccion(tipo="  xyz ", numero=" 100 "), **KW)
    _, _, args = conn.sql_ejecutado("insert into entregas")[0]
    assert args[0] == "XYZ"
    assert args[1] == "100"


async def test_cantidad_negativa_se_limita_a_cero(pool, conn):
    guionar_alta(conn)
    await procesar_extraccion(extraccion(items=[{"descripcion": "A", "cantidad": -3}]), **KW)
    _, _, args = conn.sql_ejecutado("insert into entrega_items")[0]
    assert args[2] == 0


async def test_confianza_baja_pero_legible_se_guarda_como_pendiente_revision(pool, conn):
    guionar_alta(conn)
    situacion, _, _, estado, *_ = await procesar_extraccion(extraccion(conf_num=0.5), **KW)
    assert situacion is SituacionEntrega.NUEVA
    assert estado is EstadoEntrega.PENDIENTE_REVISION
    _, _, args = conn.sql_ejecutado("insert into entregas")[0]
    assert args[4] == "pendiente_revision"


async def test_cierra_el_reporte_de_factura_faltante_y_lo_registra(pool, conn):
    guionar_alta(conn)
    conn.responder("fetch", "update facturas_faltantes", [{"id": "ff-1"}])
    await procesar_extraccion(extraccion(), **KW)
    assert conn.eventos_log() == ["entrega_insertada", "factura_faltante_resuelta"]


async def test_sincroniza_el_catalogo_de_productos(pool, conn):
    guionar_alta(conn)
    await procesar_extraccion(extraccion(items=[{"descripcion": "75936  SAL BLANCA", "cantidad": 1}]), **KW)
    _, _, args = conn.sql_ejecutado("insert into productos")[0]
    assert args == ("75936", "SAL BLANCA")


# --------------------------------------------------------------------------
# Documento ya existente
# --------------------------------------------------------------------------


async def test_existente_con_pendiente_es_actualizable_desde_cualquier_sede(pool, conn):
    guionar_existente(conn, pendientes=(0, 2))
    for sede in ("sede-1", "sede-2", "sede-que-no-existe"):
        kw = {**KW, "sede_origen_id": sede}
        situacion, entrega_id, items, _, tipo, numero, es_faia, nota, firma = await procesar_extraccion(
            extraccion(), **kw
        )
        assert situacion is SituacionEntrega.ACTUALIZABLE
        assert entrega_id == "entrega-existente"
        assert [i.cantidad_pendiente for i in items] == [0, 2]
        # Conserva lo que ya tenia el documento; no lo reinicia.
        assert (es_faia, nota, firma) == (True, "nota previa", "https://firma")
    # Re-fotografiar no escribe nada: ni log de insercion ni items nuevos.
    assert conn.eventos_log() == []
    assert conn.sql_ejecutado("insert into entrega_items") == []


async def test_existente_totalmente_entregado_es_duplicado_y_queda_en_log(pool, conn):
    guionar_existente(conn, pendientes=(0, 0))
    with pytest.raises(EntregaDuplicada) as info:
        await procesar_extraccion(extraccion(), **KW)
    assert info.value.identificador == "XYZ 100"
    assert conn.eventos_log() == ["duplicado_bloqueado"]
    evento = conn.inserts_log()[0]
    assert evento[5] == "bloqueado"
    assert evento[6] == {"tipo": "XYZ", "indicativo_numero": "100"}


async def test_carrera_por_hash_busca_la_fila_por_hash_evidencia(pool, conn):
    guionar_existente(conn, constraint="entregas_hash_evidencia_key")
    situacion, *_ = await procesar_extraccion(extraccion(), **KW)
    assert situacion is SituacionEntrega.ACTUALIZABLE
    consulta = conn.sql_ejecutado("select id, tipo, indicativo_numero, es_faia")[0]
    assert "where hash_evidencia = $1" in consulta[1]
    assert consulta[2] == ("hash-1",)


async def test_carrera_por_tipo_e_indicativo_busca_por_ese_par(pool, conn):
    guionar_existente(conn)
    await procesar_extraccion(extraccion(), **KW)
    consulta = conn.sql_ejecutado("select id, tipo, indicativo_numero, es_faia")[0]
    assert "where tipo = $1 and indicativo_numero = $2" in consulta[1]
    assert consulta[2] == ("XYZ", "100")


async def test_violacion_unica_sin_fila_existente_se_propaga(pool, conn):
    import asyncpg

    conn.responder("fetchval", "insert into entregas", violacion_unica("entregas_tipo_indicativo_numero_key"))
    with pytest.raises(asyncpg.UniqueViolationError):
        await procesar_extraccion(extraccion(), **KW)


# --------------------------------------------------------------------------
# Compuertas previas al insert
# --------------------------------------------------------------------------


@pytest.mark.parametrize("conf, rechaza", [(0.34, True), (0.35, False), (0.2, True), (0.36, False)])
async def test_foto_ilegible_se_rechaza_antes_de_tocar_la_base(pool, conn, conf, rechaza):
    guionar_alta(conn)
    llamada = procesar_extraccion(extraccion(conf_tipo=conf), **KW)
    if rechaza:
        with pytest.raises(ExtraccionIlegible):
            await llamada
        assert conn.llamadas == []
    else:
        await llamada
        assert conn.sql_ejecutado("insert into entregas")


async def test_remision_en_flujo_despacho_se_rechaza(pool, conn):
    with pytest.raises(RemisionEnDespachos):
        await procesar_extraccion(extraccion(tipo="RM3"), **KW)
    assert conn.llamadas == []


async def test_despacho_en_flujo_remision_se_rechaza(pool, conn):
    with pytest.raises(DespachoEnRemisiones):
        await procesar_extraccion(extraccion(tipo="FEI"), **{**KW, "flujo": "remision"})
    assert conn.llamadas == []


async def test_remision_en_su_flujo_se_procesa(pool, conn):
    guionar_alta(conn)
    situacion, *_ = await procesar_extraccion(extraccion(tipo="rm2"), **{**KW, "flujo": "remision"})
    assert situacion is SituacionEntrega.NUEVA


def con_rol(conn, rol):
    conn.responder("fetchrow", "select rol from empleados", {"rol": rol})


async def test_faia_viewer_no_puede_procesar(pool, conn):
    con_rol(conn, "faia_viewer")
    with pytest.raises(RolNoAutorizado):
        await procesar_extraccion(extraccion(), **KW)
    assert conn.sql_ejecutado("insert into entregas") == []


async def test_punto_venta_no_puede_procesar_remisiones(pool, conn):
    con_rol(conn, "punto_venta")
    with pytest.raises(RolNoAutorizado):
        await procesar_extraccion(extraccion(tipo="RSF"), **{**KW, "flujo": "remision"})


async def test_operador_no_puede_crear_un_documento_nuevo(pool, conn):
    con_rol(conn, "operador")  # "select 1 from entregas" -> None: el documento no existe
    with pytest.raises(FacturacionRequerida):
        await procesar_extraccion(extraccion(), **KW)
    assert conn.sql_ejecutado("insert into entregas") == []


async def test_operador_si_puede_reescanear_un_documento_ya_facturado(pool, conn):
    con_rol(conn, "operador")
    conn.responder("fetchval", "select 1 from entregas", 1)
    guionar_existente(conn)
    situacion, *_ = await procesar_extraccion(extraccion(), **KW)
    assert situacion is SituacionEntrega.ACTUALIZABLE


async def test_operador_puede_crear_en_el_flujo_de_remision(pool, conn):
    con_rol(conn, "operador")
    guionar_alta(conn)
    situacion, *_ = await procesar_extraccion(extraccion(tipo="RM3"), **{**KW, "flujo": "remision"})
    assert situacion is SituacionEntrega.NUEVA


async def test_punto_venta_crea_pero_no_re_toca_un_documento_existente(pool, conn):
    con_rol(conn, "punto_venta")
    guionar_alta(conn)
    situacion, *_ = await procesar_extraccion(extraccion(), **KW)
    assert situacion is SituacionEntrega.NUEVA

    conn.responder("fetchval", "select 1 from entregas", 1)
    with pytest.raises(FacturaYaRegistrada):
        await procesar_extraccion(extraccion(), **KW)


# --------------------------------------------------------------------------
# Tipos con sede duena (traslado requerido)
# --------------------------------------------------------------------------


def con_sede(conn, codigo):
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": codigo} if codigo else None)


async def test_tipo_de_otra_sede_sin_traslado_no_inserta_nada(pool, conn):
    guionar_alta(conn)
    con_sede(conn, "SEDE-02")  # FEI le pertenece a SEDE-01
    situacion, entrega_id, items, *_ = await procesar_extraccion(extraccion(tipo="FEI"), **KW)
    assert situacion is SituacionEntrega.NECESITA_TRASLADO
    assert entrega_id is None
    assert [i.cantidad_pendiente for i in items] == [5]
    assert conn.eventos_log() == []
    assert conn.sql_ejecutado("insert into entrega_items") == []


async def test_tipo_con_sede_duena_correcta_se_inserta(pool, conn):
    guionar_alta(conn)
    con_sede(conn, "SEDE-01")
    situacion, *_ = await procesar_extraccion(extraccion(tipo="FEI"), **KW)
    assert situacion is SituacionEntrega.NUEVA


async def test_sede_desconocida_cuenta_como_otra_sede(pool, conn):
    guionar_alta(conn)
    con_sede(conn, None)
    situacion, *_ = await procesar_extraccion(extraccion(tipo="EDP"), **KW)
    assert situacion is SituacionEntrega.NECESITA_TRASLADO


async def test_traslado_cuyo_concepto_menciona_la_factura_destraba(pool, conn):
    guionar_alta(conn)
    con_sede(conn, "SEDE-02")
    situacion, *_ = await procesar_extraccion(
        extraccion(tipo="FEI", numero="21542"),
        **KW,
        traslado_url="https://traslado.webp",
        concepto_traslado="Factura FEI-21542",
    )
    assert situacion is SituacionEntrega.NUEVA


async def test_traslado_que_no_menciona_la_factura_no_destraba(pool, conn):
    guionar_alta(conn)
    con_sede(conn, "SEDE-02")
    situacion, *_ = await procesar_extraccion(
        extraccion(tipo="FEI", numero="21542"),
        **KW,
        traslado_url="https://traslado.webp",
        concepto_traslado="Factura FEI-99999",
    )
    assert situacion is SituacionEntrega.NECESITA_TRASLADO


async def test_factura_poco_legible_usa_los_items_del_traslado(pool, conn):
    guionar_alta(conn)
    con_sede(conn, "SEDE-02")
    situacion, _, items, *_ = await procesar_extraccion(
        extraccion(tipo="FEI", numero="21542", conf_items=0.4),
        **KW,
        traslado_url="https://traslado.webp",
        concepto_traslado="FEI 21542",
        items_traslado=[{"descripcion": "DEL TRASLADO", "cantidad": 9}],
    )
    assert situacion is SituacionEntrega.NUEVA
    assert [(i.descripcion, i.cantidad_pendiente) for i in items] == [("DEL TRASLADO", 9)]


# --------------------------------------------------------------------------
# _concepto_referencia_factura
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tipo, numero, concepto, esperado",
    [
        ("FEI", "21542", "Factura FEI 21542", True),
        ("FEI", "21542", "FEI-21542", True),
        ("FEI", "21542", "fei 21542", True),
        ("FEI", "21542", "Traslado por factura FEI-21542 a bodega central", True),
        ("FEI", "21542", "FEI - 21542", True),  # ruido tipico de OCR
        ("FEI", "21542", "FEI   21542", True),
        # Solo el numero suelto no alcanza: debe venir pegado al tipo.
        ("FEI", "21542", "Factura 21542", False),
        ("FEI", "21542", "FV1 21542", False),
        ("FEI", "21542", "FEI 99999", False),
        ("FEI", "21542", "", False),
        ("FEI", "", "FEI ", False),
        ("FEI", "   ", "FEI", False),
    ],
)
def test_concepto_referencia_factura(tipo, numero, concepto, esperado):
    assert _concepto_referencia_factura(tipo, numero, concepto) is esperado

