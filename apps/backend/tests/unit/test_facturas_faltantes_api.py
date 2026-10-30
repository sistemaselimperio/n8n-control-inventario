"""Facturas faltantes: traduccion de errores a HTTP, validacion de entrada y
reglas de autorizacion del servicio (app/services/facturas_faltantes.py)."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.routers import facturas_faltantes as router_ff
from app.services import facturas_faltantes as servicio
from app.services.facturas_faltantes import (
    FacturaNoRegistrada,
    FacturaYaReportada,
    FacturaYaSubida,
    ReporteNoAutorizado,
    ReporteNoEncontrado,
    ReporteYaCerrado,
    descartar,
    marcar_subida,
    reportar,
    resolver_por_entrega,
)
from tests.fakes import violacion_unica

REPORTE = "55555555-5555-5555-5555-555555555555"
AHORA = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)


def respuesta(**extra) -> dict:
    fila = {
        "id": REPORTE, "tipo": "FEI", "indicativo_numero": "100", "sede_id": "s-centro",
        "sede_reporta_id": "s-bodega", "sede_nombre": "Centro", "sede_reporta_nombre": "Bodega",
        "reportado_por": "emp-1", "reportado_por_nombre": "Luis", "reportado_at": AHORA,
        "estado": "pendiente", "entrega_id": None, "cerrada_at": None, "cerrada_por": None,
        "cerrada_por_nombre": None,
    }
    fila.update(extra)
    return fila


CUERPO = {"tipo": "FEI", "indicativo_numero": "100", "empleado_id": "emp-1", "sede_id": "s-bodega"}


# --------------------------------------------------------------------------
# Router: errores del servicio -> codigos HTTP
# --------------------------------------------------------------------------


def _lanzar(exc: BaseException):
    async def _falso(*args, **kwargs):
        raise exc

    return _falso


@pytest.mark.parametrize(
    "excepcion, status, texto",
    [
        (ReporteNoAutorizado(), 403, "No tienes permiso para reportar"),
        (FacturaYaSubida(), 409, "ya fue subida"),
        (FacturaYaReportada(), 409, "ya fue reportada"),
    ],
)
async def test_reportar_traduce_los_errores(cliente, monkeypatch, excepcion, status, texto):
    monkeypatch.setattr(router_ff, "reportar", _lanzar(excepcion))
    res = await cliente.post("/facturas-faltantes", json=CUERPO)
    assert res.status_code == status and texto in res.json()["detail"]


@pytest.mark.parametrize("accion", ["descartar", "marcar-subida"])
@pytest.mark.parametrize(
    "excepcion, status",
    [(ReporteNoEncontrado(), 404), (ReporteNoAutorizado(), 403), (ReporteYaCerrado(), 409), (FacturaNoRegistrada(), 409)],
)
async def test_descartar_y_marcar_subida_traducen_los_errores(cliente, monkeypatch, accion, excepcion, status):
    if isinstance(excepcion, FacturaNoRegistrada) and accion == "descartar":
        return  # descartar no verifica la factura: el caso no aplica
    nombre = "descartar" if accion == "descartar" else "marcar_subida"
    monkeypatch.setattr(router_ff, nombre, _lanzar(excepcion))
    res = await cliente.post(f"/facturas-faltantes/{REPORTE}/{accion}", json={"empleado_id": "emp-1"})
    assert res.status_code == status


async def test_factura_no_registrada_explica_que_hay_que_subir_la_foto_primero(cliente, monkeypatch):
    monkeypatch.setattr(router_ff, "marcar_subida", _lanzar(FacturaNoRegistrada()))
    res = await cliente.post(f"/facturas-faltantes/{REPORTE}/marcar-subida", json={"empleado_id": "emp-1"})
    assert "Sube la foto de la factura primero" in res.json()["detail"]


async def test_reportar_correcto_devuelve_201_con_el_modelo(cliente, monkeypatch):
    llamado = {}

    async def _falso(**kwargs):
        llamado.update(kwargs)
        return respuesta()

    monkeypatch.setattr(router_ff, "reportar", _falso)
    res = await cliente.post("/facturas-faltantes", json={**CUERPO, "tipo": "  FEI ", "indicativo_numero": " 100 "})
    assert res.status_code == 201
    assert res.json()["id"] == REPORTE and res.json()["estado"] == "pendiente"
    # El modelo recorta los espacios antes de llegar al servicio.
    assert llamado == {"tipo": "FEI", "indicativo_numero": "100", "empleado_id": "emp-1", "sede_id": "s-bodega"}


# --------------------------------------------------------------------------
# Router: validacion
# --------------------------------------------------------------------------


@pytest.mark.parametrize("campo", ["tipo", "indicativo_numero", "empleado_id", "sede_id"])
@pytest.mark.parametrize("valor", ["", "   ", None])
async def test_reportar_rechaza_campos_vacios(cliente, pool, conn, campo, valor):
    res = await cliente.post("/facturas-faltantes", json={**CUERPO, campo: valor})
    assert res.status_code == 422
    assert conn.llamadas == []


async def test_reportar_rechaza_campos_ausentes(cliente, pool, conn):
    assert (await cliente.post("/facturas-faltantes", json={})).status_code == 422


@pytest.mark.parametrize("accion", ["descartar", "marcar-subida"])
@pytest.mark.parametrize("cuerpo", [{}, {"empleado_id": ""}, {"empleado_id": "  "}])
async def test_acciones_exigen_empleado(cliente, pool, conn, accion, cuerpo):
    res = await cliente.post(f"/facturas-faltantes/{REPORTE}/{accion}", json=cuerpo)
    assert res.status_code == 422 and conn.llamadas == []


async def test_listar_exige_la_sede(cliente, pool, conn):
    assert (await cliente.get("/facturas-faltantes")).status_code == 422


async def test_listar_usa_los_valores_por_defecto(cliente, monkeypatch):
    llamado = {}

    async def _falso(sede_id, estado, vista, horas):
        llamado.update(sede_id=sede_id, estado=estado, vista=vista, horas=horas)
        return [respuesta()]

    monkeypatch.setattr(router_ff, "listar", _falso)
    res = await cliente.get("/facturas-faltantes", params={"sede_id": "s1"})
    assert res.status_code == 200 and len(res.json()) == 1
    assert llamado == {"sede_id": "s1", "estado": "pendiente", "vista": "destino", "horas": None}


@pytest.mark.parametrize("params", [{"estado": "inventado"}, {"vista": "otra"}, {"horas": 0}, {"horas": 721}, {"horas": -5}, {"horas": "x"}])
async def test_listar_rechaza_parametros_invalidos_sin_consultar(cliente, pool, conn, params):
    res = await cliente.get("/facturas-faltantes", params={"sede_id": "s1", **params})
    assert res.status_code == 422 and conn.llamadas == []


@pytest.mark.parametrize("horas", [1, 720])
async def test_listar_acepta_los_limites_de_horas(cliente, monkeypatch, horas):
    async def _falso(sede_id, estado, vista, h):
        return []

    monkeypatch.setattr(router_ff, "listar", _falso)
    assert (await cliente.get("/facturas-faltantes", params={"sede_id": "s", "horas": horas})).status_code == 200


# --------------------------------------------------------------------------
# listar: SQL segun la vista, el estado y las horas
# --------------------------------------------------------------------------


async def test_listar_vista_destino_filtra_solo_por_sede_destino(pool, conn):
    conn.responder("fetch", "from facturas_faltantes f", [])
    await servicio.listar("s1")
    (_, sql, args) = conn.llamadas[0]
    assert "where f.sede_id = $1 and f.estado = $2" in sql
    assert "order by f.reportado_at asc" in sql  # pendientes: del mas antiguo
    assert args == ("s1", "pendiente")


async def test_listar_vista_sede_incluye_lo_que_la_sede_reporto(pool, conn):
    conn.responder("fetch", "from facturas_faltantes f", [])
    await servicio.listar("s1", vista="sede")
    sql = conn.llamadas[0][1]
    assert "coalesce(f.sede_reporta_id, f.sede_id) = $1" in sql


@pytest.mark.parametrize("estado", ["resuelta", "descartada"])
async def test_listar_cerradas_del_mas_reciente_al_mas_viejo_y_con_ventana_de_horas(pool, conn, estado):
    conn.responder("fetch", "from facturas_faltantes f", [])
    await servicio.listar("s1", estado, horas=24)
    (_, sql, args) = conn.llamadas[0]
    assert "order by f.cerrada_at desc" in sql
    assert "make_interval(hours => $3)" in sql
    assert args == ("s1", estado, 24)


async def test_listar_devuelve_ids_como_texto(pool, conn):
    conn.responder("fetch", "from facturas_faltantes f", [respuesta(id=uuid4(), entrega_id=uuid4())])
    (fila,) = await servicio.listar("s1")
    assert isinstance(fila["id"], str) and isinstance(fila["entrega_id"], str)


# --------------------------------------------------------------------------
# reportar
# --------------------------------------------------------------------------


def empleado(rol="operador", sede="s-bodega") -> dict:
    return {"id": "emp-1", "sede_id": sede, "rol": rol}


def guionar_reporte(conn, emp=None, ya_subida=None, duena=None, nuevo_id=REPORTE) -> None:
    conn.responder("fetchrow", "from empleados", emp if emp is not None else empleado())
    conn.responder("fetchval", "from entregas where tipo", ya_subida)
    conn.responder("fetchval", "from sedes where codigo", duena)
    conn.responder("fetchval", "insert into facturas_faltantes", nuevo_id)
    conn.responder("fetchrow", "from facturas_faltantes f", respuesta())


@pytest.mark.parametrize(
    "emp",
    [None, empleado("punto_venta"), empleado("faia_viewer"), empleado("operador", sede="otra-sede")],
    ids=["inexistente-o-inactivo", "punto_venta", "faia_viewer", "otra-sede"],
)
async def test_reportar_sin_autorizacion_no_inserta_nada(pool, conn, emp):
    conn.responder("fetchrow", "from empleados", emp)
    with pytest.raises(ReporteNoAutorizado):
        await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    assert conn.sql_ejecutado("insert into facturas_faltantes") == [] and conn.inserts_log() == []


@pytest.mark.parametrize("rol", ["operador", "supervisor", "admin"])
async def test_reportar_pueden_bodega_y_sus_superiores(pool, conn, rol):
    guionar_reporte(conn, emp=empleado(rol))
    resultado = await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    assert resultado["id"] == REPORTE


async def test_reportar_solo_empleados_activos(pool, conn):
    guionar_reporte(conn)
    await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    assert "estado = 'activo'" in conn.sql_ejecutado("from empleados")[0][1]


async def test_reportar_normaliza_el_tipo_y_recorta_el_numero(pool, conn):
    guionar_reporte(conn)
    await reportar(tipo=" fei ", indicativo_numero=" 100 ", empleado_id="emp-1", sede_id="s-bodega")
    assert conn.sql_ejecutado("from entregas where tipo")[0][2] == ("FEI", "100")
    assert conn.sql_ejecutado("insert into facturas_faltantes")[0][2][:2] == ("FEI", "100")


async def test_reportar_una_factura_ya_subida_da_error_sin_insertar(pool, conn):
    guionar_reporte(conn, ya_subida=1)
    with pytest.raises(FacturaYaSubida):
        await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    assert conn.sql_ejecutado("insert into facturas_faltantes") == [] and conn.inserts_log() == []


async def test_reportar_dirige_al_mostrador_de_la_sede_duena_del_tipo(pool, conn):
    guionar_reporte(conn, duena="id-sede-centro")
    await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    (_, _, args) = conn.sql_ejecutado("insert into facturas_faltantes")[0]
    # (tipo, numero, sede destino, sede que reporta, quien reporta)
    assert args == ("FEI", "100", "id-sede-centro", "s-bodega", "emp-1")
    assert conn.sql_ejecutado("from sedes where codigo")[0][2] == ("SEDE-01",)
    assert conn.inserts_log()[0][6]["sede_destino_id"] == "id-sede-centro"


async def test_reportar_un_tipo_sin_duena_se_queda_en_la_sede_de_quien_reporta(pool, conn):
    guionar_reporte(conn)
    await reportar(tipo="RM3", indicativo_numero="9", empleado_id="emp-1", sede_id="s-bodega")
    assert conn.sql_ejecutado("from sedes where codigo") == []
    assert conn.sql_ejecutado("insert into facturas_faltantes")[0][2][2] == "s-bodega"


async def test_reportar_con_duena_que_no_existe_en_sedes_cae_a_la_sede_de_quien_reporta(pool, conn):
    guionar_reporte(conn, duena=None)
    await reportar(tipo="EDP", indicativo_numero="9", empleado_id="emp-1", sede_id="s-bodega")
    assert conn.sql_ejecutado("insert into facturas_faltantes")[0][2][2] == "s-bodega"


async def test_reportar_dos_veces_el_mismo_documento_lo_frena_el_unique_parcial(pool, conn):
    guionar_reporte(conn, nuevo_id=violacion_unica("facturas_faltantes_pendiente_key"))
    with pytest.raises(FacturaYaReportada):
        await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    assert conn.inserts_log() == []


async def test_reportar_deja_un_evento_con_el_actor_y_la_sede(pool, conn):
    guionar_reporte(conn)
    await reportar(tipo="FEI", indicativo_numero="100", empleado_id="emp-1", sede_id="s-bodega")
    (evento,) = conn.inserts_log()
    assert evento[:6] == ("factura_faltante_reportada", "factura_faltante", REPORTE, "emp-1", "s-bodega", "ok")


# --------------------------------------------------------------------------
# descartar
# --------------------------------------------------------------------------


def reporte_pendiente(**extra) -> dict:
    fila = {"id": REPORTE, "tipo": "FEI", "indicativo_numero": "100", "sede_id": "s-centro",
            "reportado_por": "emp-1", "estado": "pendiente"}
    fila.update(extra)
    return fila


def guionar_descartar(conn, emp, reporte=None, actualizado=REPORTE) -> None:
    conn.responder("fetchrow", "from facturas_faltantes where id::text", reporte)
    conn.responder("fetchrow", "from empleados", emp)
    conn.responder("fetchval", "update facturas_faltantes", actualizado)
    conn.responder("fetchrow", "from facturas_faltantes f", respuesta(estado="descartada"))


async def test_descartar_un_reporte_inexistente(pool, conn):
    guionar_descartar(conn, empleado(), reporte=None)
    with pytest.raises(ReporteNoEncontrado):
        await descartar(REPORTE, "emp-1")
    assert conn.sql_ejecutado("update facturas_faltantes") == []


@pytest.mark.parametrize(
    "quien, emp",
    [
        ("inactivo-o-inexistente", None),
        ("otro operador de otra sede", {"id": "emp-9", "sede_id": "s-otra", "rol": "operador"}),
        ("operador de la sede destino que no reporto", {"id": "emp-9", "sede_id": "s-centro", "rol": "operador"}),
        ("punto_venta de la sede destino", {"id": "emp-9", "sede_id": "s-centro", "rol": "punto_venta"}),
        ("supervisor de OTRA sede", {"id": "emp-9", "sede_id": "s-otra", "rol": "supervisor"}),
    ],
)
async def test_descartar_sin_permiso(pool, conn, quien, emp):
    guionar_descartar(conn, emp, reporte=reporte_pendiente())
    with pytest.raises(ReporteNoAutorizado):
        await descartar(REPORTE, "emp-9")
    assert conn.sql_ejecutado("update facturas_faltantes") == [] and conn.inserts_log() == []


@pytest.mark.parametrize(
    "emp, empleado_id",
    [
        ({"id": "emp-1", "sede_id": "s-bodega", "rol": "operador"}, "emp-1"),  # quien lo reporto
        ({"id": "emp-9", "sede_id": "s-centro", "rol": "supervisor"}, "emp-9"),
        ({"id": "emp-9", "sede_id": "s-centro", "rol": "admin"}, "emp-9"),
    ],
)
async def test_descartar_con_permiso(pool, conn, emp, empleado_id):
    guionar_descartar(conn, emp, reporte=reporte_pendiente())
    resultado = await descartar(REPORTE, empleado_id)
    assert resultado["estado"] == "descartada"
    (_, sql, args) = conn.sql_ejecutado("update facturas_faltantes")[0]
    assert "estado = 'descartada'" in sql and "estado = 'pendiente'" in sql  # solo desde pendiente
    assert args == (REPORTE, empleado_id)
    assert conn.eventos_log() == ["factura_faltante_descartada"]


async def test_descartar_un_reporte_ya_cerrado_o_cerrado_en_carrera(pool, conn):
    guionar_descartar(conn, empleado(), reporte=reporte_pendiente(), actualizado=None)
    with pytest.raises(ReporteYaCerrado):
        await descartar(REPORTE, "emp-1")
    assert conn.inserts_log() == []


# --------------------------------------------------------------------------
# marcar_subida
# --------------------------------------------------------------------------


def guionar_subida(conn, emp, reporte, entrega="entrega-1", actualizado=REPORTE, final="resuelta") -> None:
    conn.responder("fetchrow", "from facturas_faltantes where id::text", reporte)
    conn.responder("fetchrow", "from empleados", emp)
    conn.responder("fetchval", "from entregas where tipo", entrega)
    conn.responder("fetchval", "update facturas_faltantes", actualizado)
    conn.responder("fetchrow", "from facturas_faltantes f", respuesta(estado=final))


MOSTRADOR = {"id": "emp-9", "sede_id": "s-centro", "rol": "punto_venta"}


async def test_marcar_subida_inexistente(pool, conn):
    guionar_subida(conn, MOSTRADOR, None)
    with pytest.raises(ReporteNoEncontrado):
        await marcar_subida(REPORTE, "emp-9")


@pytest.mark.parametrize(
    "emp",
    [None, {"id": "x", "sede_id": "s-centro", "rol": "operador"}, {"id": "x", "sede_id": "s-otra", "rol": "punto_venta"}],
    ids=["inactivo", "operador-de-bodega", "mostrador-de-otra-sede"],
)
async def test_marcar_subida_sin_permiso(pool, conn, emp):
    guionar_subida(conn, emp, reporte_pendiente())
    with pytest.raises(ReporteNoAutorizado):
        await marcar_subida(REPORTE, "x")
    assert conn.sql_ejecutado("update facturas_faltantes") == []


@pytest.mark.parametrize("rol", ["punto_venta", "supervisor", "admin"])
async def test_marcar_subida_pueden_el_mostrador_y_los_superiores_de_la_sede_destino(pool, conn, rol):
    guionar_subida(conn, {"id": "emp-9", "sede_id": "s-centro", "rol": rol}, reporte_pendiente())
    resultado = await marcar_subida(REPORTE, "emp-9")
    assert resultado["estado"] == "resuelta"
    (_, _, args) = conn.sql_ejecutado("update facturas_faltantes")[0]
    assert args == (REPORTE, "entrega-1", "emp-9")
    (evento,) = conn.inserts_log()
    assert evento[0] == "factura_faltante_resuelta" and evento[5] == "manual"


async def test_marcar_subida_si_la_factura_no_esta_en_entregas_no_cierra_nada(pool, conn):
    guionar_subida(conn, MOSTRADOR, reporte_pendiente(), entrega=None)
    with pytest.raises(FacturaNoRegistrada):
        await marcar_subida(REPORTE, "emp-9")
    assert conn.sql_ejecutado("update facturas_faltantes") == [] and conn.inserts_log() == []


async def test_marcar_subida_de_un_reporte_ya_resuelto_es_idempotente(pool, conn):
    guionar_subida(conn, MOSTRADOR, reporte_pendiente(estado="resuelta"))
    resultado = await marcar_subida(REPORTE, "emp-9")
    assert resultado["estado"] == "resuelta"
    assert conn.sql_ejecutado("update facturas_faltantes") == [] and conn.inserts_log() == []


async def test_marcar_subida_de_un_reporte_descartado_da_ya_cerrado(pool, conn):
    guionar_subida(conn, MOSTRADOR, reporte_pendiente(estado="descartada"))
    with pytest.raises(ReporteYaCerrado):
        await marcar_subida(REPORTE, "emp-9")


async def test_marcar_subida_que_pierde_la_carrera_contra_el_cierre_automatico_es_exito_si_quedo_resuelta(pool, conn):
    guionar_subida(conn, MOSTRADOR, reporte_pendiente(), actualizado=None, final="resuelta")
    assert (await marcar_subida(REPORTE, "emp-9"))["estado"] == "resuelta"
    assert conn.inserts_log() == []  # el log lo escribio el cierre automatico, no esta llamada


async def test_marcar_subida_que_pierde_la_carrera_contra_un_descarte_falla(pool, conn):
    guionar_subida(conn, MOSTRADOR, reporte_pendiente(), actualizado=None, final="descartada")
    with pytest.raises(ReporteYaCerrado):
        await marcar_subida(REPORTE, "emp-9")


# --------------------------------------------------------------------------
# resolver_por_entrega
# --------------------------------------------------------------------------


async def test_resolver_por_entrega_cierra_solo_los_pendientes_de_ese_documento(conn):
    conn.responder("fetch", "update facturas_faltantes", [{"id": uuid4()}, {"id": uuid4()}])
    ids = await resolver_por_entrega(conn, "FEI", "100", "entrega-1")
    assert len(ids) == 2 and all(isinstance(i, str) for i in ids)
    (_, sql, args) = conn.llamadas[0]
    assert "estado = 'pendiente'" in sql and "tipo = $1 and indicativo_numero = $2" in sql
    assert args == ("FEI", "100", "entrega-1")


async def test_resolver_por_entrega_sin_reporte_no_devuelve_nada(conn):
    assert await resolver_por_entrega(conn, "FEI", "100", "e1") == []
