"""Facturas faltantes contra Postgres real: unique parcial, cierre automatico
al subirse la factura y reglas de autorizacion con empleados reales."""

from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest

from tests import respuestas_vision as r
from tests.helpers import payload_entrega
from tests.integration.datos_admin import entrega_con_item, nueva_sede

pytestmark = pytest.mark.integration


async def nuevo_emp(pg, sede: str, rol: str = "operador", estado: str = "activo") -> str:
    return str(
        await pg.fetchval(
            "insert into empleados (nombre, sede_id, rol, estado) values ('Emp', $1, $2, $3) returning id", sede, rol, estado
        )
    )


@pytest.fixture
async def mundo(pg):
    """Sede bodega (donde reporta el operador) y sede centro, duena de FEI/FV1."""
    bodega = await nueva_sede(pg, "BODEGA-1")
    centro = await nueva_sede(pg, "SEDE-01")
    return {
        "bodega": bodega,
        "centro": centro,
        "operador": await nuevo_emp(pg, bodega, "operador"),
        "mostrador": await nuevo_emp(pg, centro, "punto_venta"),
        "supervisor_centro": await nuevo_emp(pg, centro, "supervisor"),
    }


def cuerpo(m, **extra) -> dict:
    base = {"tipo": "FEI", "indicativo_numero": "100", "empleado_id": m["operador"], "sede_id": m["bodega"]}
    base.update(extra)
    return base


async def reportar(cliente, m, **extra):
    return await cliente.post("/facturas-faltantes", json=cuerpo(m, **extra))


# --------------------------------------------------------------------------
# Reportar
# --------------------------------------------------------------------------


async def test_el_reporte_se_dirige_al_mostrador_de_la_sede_duena_del_tipo(cliente, pg, mundo):
    res = await reportar(cliente, mundo, tipo="fei", indicativo_numero=" 100 ")
    assert res.status_code == 201
    reporte = res.json()
    assert (reporte["tipo"], reporte["indicativo_numero"]) == ("FEI", "100")
    assert reporte["sede_id"] == mundo["centro"] and reporte["sede_nombre"] == "SEDE-01"
    assert reporte["sede_reporta_id"] == mundo["bodega"] and reporte["estado"] == "pendiente"
    assert reporte["reportado_por_nombre"] == "Emp"
    assert [f["evento"] for f in await pg.fetch("select evento from logs")] == ["factura_faltante_reportada"]


async def test_un_tipo_sin_duena_queda_en_la_sede_de_quien_reporta(cliente, pg, mundo):
    res = await reportar(cliente, mundo, tipo="RM3")
    assert res.json()["sede_id"] == mundo["bodega"]


async def test_reportar_dos_veces_lo_mismo_da_409(cliente, pg, mundo):
    assert (await reportar(cliente, mundo)).status_code == 201
    segundo = await reportar(cliente, mundo, tipo="FEI")
    assert segundo.status_code == 409 and "ya fue reportada" in segundo.json()["detail"]
    assert await pg.fetchval("select count(*) from facturas_faltantes") == 1


async def test_dos_reportes_simultaneos_del_mismo_documento_dejan_uno_solo(cliente, pg, mundo):
    otro = await nuevo_emp(pg, mundo["bodega"], "operador")
    a, b = await asyncio.gather(reportar(cliente, mundo), reportar(cliente, mundo, empleado_id=otro))
    assert sorted((a.status_code, b.status_code)) == [201, 409]
    assert await pg.fetchval("select count(*) from facturas_faltantes where estado = 'pendiente'") == 1


async def test_se_puede_volver_a_reportar_despues_de_descartar(cliente, pg, mundo):
    primero = (await reportar(cliente, mundo)).json()
    await cliente.post(f"/facturas-faltantes/{primero['id']}/descartar", json={"empleado_id": mundo["operador"]})
    assert (await reportar(cliente, mundo)).status_code == 201  # el unique es parcial: solo pendientes
    assert await pg.fetchval("select count(*) from facturas_faltantes") == 2


async def test_no_se_reporta_una_factura_que_ya_esta_en_el_sistema(cliente, pg, mundo):
    await entrega_con_item(pg, tipo="FEI", indicativo_numero="100")
    res = await reportar(cliente, mundo)
    assert res.status_code == 409 and "ya fue subida" in res.json()["detail"]
    assert await pg.fetchval("select count(*) from facturas_faltantes") == 0


@pytest.mark.parametrize("quien", ["mostrador", "inactivo", "otra_sede", "inexistente", "viewer"])
async def test_quien_no_corresponde_no_puede_reportar(cliente, pg, mundo, quien):
    empleado = {
        "mostrador": mundo["mostrador"],  # punto_venta no reporta
        "inactivo": await nuevo_emp(pg, mundo["bodega"], "operador", "inactivo"),
        "otra_sede": await nuevo_emp(pg, mundo["centro"], "operador"),
        "inexistente": str(uuid4()),
        "viewer": await nuevo_emp(pg, mundo["bodega"], "faia_viewer"),
    }[quien]
    sede = mundo["centro"] if quien == "mostrador" else mundo["bodega"]
    res = await reportar(cliente, mundo, empleado_id=empleado, sede_id=sede)
    assert res.status_code == 403
    assert await pg.fetchval("select count(*) from facturas_faltantes") == 0


async def test_un_empleado_id_que_no_es_uuid_no_revienta(cliente, pg, mundo):
    res = await reportar(cliente, mundo, empleado_id="no-es-uuid'; drop table empleados;--")
    assert res.status_code == 403
    assert await pg.fetchval("select count(*) from empleados") == 3


# --------------------------------------------------------------------------
# Listar
# --------------------------------------------------------------------------


async def test_listar_vista_destino_vs_vista_sede(cliente, pg, mundo):
    await reportar(cliente, mundo)  # FEI -> destino centro, reporta bodega
    await reportar(cliente, mundo, tipo="RM3", indicativo_numero="5")  # sin duena -> destino bodega

    destino_centro = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["centro"]})).json()
    assert [f["tipo"] for f in destino_centro] == ["FEI"]
    destino_bodega = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"]})).json()
    assert [f["tipo"] for f in destino_bodega] == ["RM3"]
    # Vista de bodega: lo dirigido a la sede MAS lo que la sede reporto hacia otra.
    vista_bodega = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"], "vista": "sede"})).json()
    assert sorted(f["tipo"] for f in vista_bodega) == ["FEI", "RM3"]
    ajena = (await cliente.get("/facturas-faltantes", params={"sede_id": "otra-sede", "vista": "sede"})).json()
    assert ajena == []


async def test_listar_pendientes_del_mas_antiguo_y_cerradas_del_mas_reciente(cliente, pg, mundo):
    for numero in ("1", "2", "3"):
        await reportar(cliente, mundo, tipo="RM3", indicativo_numero=numero)
    ids = [f["id"] for f in (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"]})).json()]
    assert [f["indicativo_numero"] for f in (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"]})).json()] == ["1", "2", "3"]
    for id_ in ids:
        await cliente.post(f"/facturas-faltantes/{id_}/descartar", json={"empleado_id": mundo["operador"]})
        await asyncio.sleep(0.01)
    cerradas = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"], "estado": "descartada"})).json()
    assert [f["indicativo_numero"] for f in cerradas] == ["3", "2", "1"]
    assert (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"]})).json() == []


async def test_listar_con_ventana_de_horas(cliente, pg, mundo):
    await reportar(cliente, mundo, tipo="RM3", indicativo_numero="1")
    await reportar(cliente, mundo, tipo="RM3", indicativo_numero="2")
    await pg.execute("update facturas_faltantes set reportado_at = now() - interval '3 days' where indicativo_numero = '1'")
    reciente = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"], "horas": 24})).json()
    assert [f["indicativo_numero"] for f in reciente] == ["2"]
    amplia = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"], "horas": 100})).json()
    assert len(amplia) == 2


# --------------------------------------------------------------------------
# Descartar y marcar subida
# --------------------------------------------------------------------------


async def test_descartar_por_quien_reporto_y_por_el_supervisor_de_la_sede_destino(cliente, pg, mundo):
    a = (await reportar(cliente, mundo, indicativo_numero="1")).json()
    b = (await reportar(cliente, mundo, indicativo_numero="2")).json()
    ok_a = await cliente.post(f"/facturas-faltantes/{a['id']}/descartar", json={"empleado_id": mundo["operador"]})
    ok_b = await cliente.post(f"/facturas-faltantes/{b['id']}/descartar", json={"empleado_id": mundo["supervisor_centro"]})
    assert ok_a.status_code == ok_b.status_code == 200
    assert ok_a.json()["estado"] == "descartada" and ok_a.json()["cerrada_por"] == mundo["operador"]
    assert ok_a.json()["cerrada_por_nombre"] == "Emp"
    assert await pg.fetchval("select count(*) from logs where evento = 'factura_faltante_descartada'") == 2


async def test_el_mostrador_no_puede_descartar_solo_marcar_como_subida(cliente, pg, mundo):
    rep = (await reportar(cliente, mundo)).json()
    res = await cliente.post(f"/facturas-faltantes/{rep['id']}/descartar", json={"empleado_id": mundo["mostrador"]})
    assert res.status_code == 403
    assert await pg.fetchval("select estado from facturas_faltantes") == "pendiente"


async def test_descartar_inexistente_y_ya_cerrado(cliente, pg, mundo):
    inexistente = await cliente.post(f"/facturas-faltantes/{uuid4()}/descartar", json={"empleado_id": mundo["operador"]})
    assert inexistente.status_code == 404
    rep = (await reportar(cliente, mundo)).json()
    await cliente.post(f"/facturas-faltantes/{rep['id']}/descartar", json={"empleado_id": mundo["operador"]})
    otra_vez = await cliente.post(f"/facturas-faltantes/{rep['id']}/descartar", json={"empleado_id": mundo["operador"]})
    assert otra_vez.status_code == 409


async def test_un_id_de_reporte_que_no_es_uuid_da_404_no_500(cliente, pg, mundo):
    res = await cliente.post("/facturas-faltantes/no-es-uuid/descartar", json={"empleado_id": mundo["operador"]})
    assert res.status_code == 404
    res = await cliente.post("/facturas-faltantes/no-es-uuid/marcar-subida", json={"empleado_id": mundo["operador"]})
    assert res.status_code == 404


async def test_marcar_subida_exige_que_la_factura_exista_y_luego_es_idempotente(cliente, pg, mundo):
    rep = (await reportar(cliente, mundo)).json()
    ruta = f"/facturas-faltantes/{rep['id']}/marcar-subida"
    antes = await cliente.post(ruta, json={"empleado_id": mundo["mostrador"]})
    assert antes.status_code == 409 and "Sube la foto de la factura primero" in antes.json()["detail"]

    entrega_id, _ = await entrega_con_item(pg, tipo="FEI", indicativo_numero="100")
    ok = await cliente.post(ruta, json={"empleado_id": mundo["mostrador"]})
    assert ok.status_code == 200
    assert ok.json()["estado"] == "resuelta" and ok.json()["entrega_id"] == entrega_id
    repetido = await cliente.post(ruta, json={"empleado_id": mundo["mostrador"]})
    assert repetido.status_code == 200 and repetido.json()["estado"] == "resuelta"
    assert await pg.fetchval("select count(*) from logs where evento = 'factura_faltante_resuelta'") == 1


@pytest.mark.parametrize("quien", ["operador", "otra_sede"])
async def test_marcar_subida_solo_el_mostrador_o_superiores_de_la_sede_destino(cliente, pg, mundo, quien):
    rep = (await reportar(cliente, mundo)).json()
    await entrega_con_item(pg, tipo="FEI", indicativo_numero="100")
    empleado = mundo["operador"] if quien == "operador" else await nuevo_emp(pg, mundo["bodega"], "punto_venta")
    res = await cliente.post(f"/facturas-faltantes/{rep['id']}/marcar-subida", json={"empleado_id": empleado})
    assert res.status_code == 403
    assert await pg.fetchval("select estado from facturas_faltantes") == "pendiente"


async def test_marcar_subida_de_un_reporte_descartado_da_409(cliente, pg, mundo):
    rep = (await reportar(cliente, mundo)).json()
    await cliente.post(f"/facturas-faltantes/{rep['id']}/descartar", json={"empleado_id": mundo["operador"]})
    res = await cliente.post(f"/facturas-faltantes/{rep['id']}/marcar-subida", json={"empleado_id": mundo["mostrador"]})
    assert res.status_code == 409


# --------------------------------------------------------------------------
# Cierre automatico al subirse la factura (procesar_extraccion)
# --------------------------------------------------------------------------


async def test_subir_la_factura_cierra_sola_el_reporte_pendiente(cliente, pg, mundo, vision):
    rep = (await reportar(cliente, mundo, tipo="XYZ", indicativo_numero="5501")).json()
    vision.responder({**r.VARIOS_ITEMS, "tipo": "XYZ", "indicativo_numero": "5501"})
    alta = await cliente.post("/entregas/procesar", json=payload_entrega(hash_evidencia="h-ff", sede_origen_id=mundo["bodega"]))
    assert alta.status_code == 201, alta.text

    fila = await pg.fetchrow("select * from facturas_faltantes where id = $1::uuid", rep["id"])
    assert fila["estado"] == "resuelta" and str(fila["entrega_id"]) == alta.json()["id"]
    assert fila["cerrada_at"] is not None
    assert "factura_faltante_resuelta" in [f["evento"] for f in await pg.fetch("select evento from logs")]
    pendientes = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"]})).json()
    assert pendientes == []
    resueltas = (await cliente.get("/facturas-faltantes", params={"sede_id": mundo["bodega"], "estado": "resuelta"})).json()
    assert [f["id"] for f in resueltas] == [rep["id"]]


async def test_subir_otra_factura_no_toca_reportes_ajenos(cliente, pg, mundo, vision):
    await reportar(cliente, mundo, tipo="XYZ", indicativo_numero="9999")
    vision.responder({**r.VARIOS_ITEMS, "tipo": "XYZ", "indicativo_numero": "5501"})
    await cliente.post("/entregas/procesar", json=payload_entrega(hash_evidencia="h-ff2", sede_origen_id=mundo["bodega"]))
    assert await pg.fetchval("select estado from facturas_faltantes") == "pendiente"


async def test_borrar_la_entrega_deja_el_reporte_resuelto_sin_referencia(cliente, pg, mundo, admin_headers):
    entrega_id, _ = await entrega_con_item(pg, tipo="XYZ", indicativo_numero="1")
    await pg.execute(
        "insert into facturas_faltantes (tipo, indicativo_numero, sede_id, reportado_por, estado, entrega_id)"
        " values ('XYZ', '1', 's', 'e', 'resuelta', $1::uuid)",
        entrega_id,
    )
    assert (await cliente.delete(f"/entregas/{entrega_id}/definitivo", headers=admin_headers)).status_code == 200
    fila = await pg.fetchrow("select estado, entrega_id from facturas_faltantes")
    assert (fila["estado"], fila["entrega_id"]) == ("resuelta", None)  # on delete set null
