"""puntos.es_interna en los endpoints de administracion de /creador (lectura y
edicion) y su efecto en el borrado de puntos y usuarios del dashboard."""

import uuid

from app.services import borrado_admin as borrado
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

PUNTO = "22222222-2222-2222-2222-222222222222"


def _sesion(conn, rol="admin", area="todo") -> dict:
    fila = fila_usuario_dashboard(rol=rol, area=area)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


async def test_listado_de_administracion_incluye_es_interna(cliente, pool, conn):
    conn.responder(
        "fetch",
        "from puntos order by activo",
        [{"id": uuid.UUID(PUNTO), "nombre": "TB9 — Bodega", "codigo": "TB9", "activo": True, "es_interna": True, "alias": []}],
    )
    res = await cliente.get("/puntos", params={"incluir_inactivos": "true"}, headers=_sesion(conn))
    assert res.json()[0]["es_interna"] is True
    (_, sql, _) = conn.sql_ejecutado("from puntos order by activo")[0]
    assert "es_interna" in sql


async def test_listado_publico_para_el_movil_no_cambia(cliente, pool, conn):
    conn.responder("fetch", "from puntos where activo = true", [{"id": uuid.UUID(PUNTO), "nombre": "CFC", "codigo": "CFC"}])
    res = await cliente.get("/puntos")
    assert res.json() == [{"id": PUNTO, "nombre": "CFC", "codigo": "CFC"}]


async def test_editar_es_interna_exige_admin(cliente, pool, conn):
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"es_interna": True}, headers=_sesion(conn, "supervisor", "traslados"))
    assert res.status_code == 403
    assert conn.sql_ejecutado("update puntos") == []


async def test_editar_es_interna_actualiza_la_columna_y_deja_log(cliente, pool, conn):
    conn.responder(
        "fetchrow",
        "update puntos set",
        {"id": uuid.UUID(PUNTO), "nombre": "TB9", "codigo": "TB9", "activo": True, "es_interna": True},
    )
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"es_interna": True}, headers=_sesion(conn))
    assert res.status_code == 200 and res.json()["es_interna"] is True
    (_, sql, args) = conn.sql_ejecutado("update puntos set")[0]
    assert "es_interna = $2" in sql and args[1] is True
    assert conn.eventos_log() == ["admin_cambio"]


async def test_es_interna_false_tambien_se_aplica(cliente, pool, conn):
    conn.responder("fetchrow", "update puntos set", {"id": uuid.UUID(PUNTO), "nombre": "X", "codigo": "X", "es_interna": False})
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"es_interna": False}, headers=_sesion(conn))
    assert res.status_code == 200
    (_, _, args) = conn.sql_ejecutado("update puntos set")[0]
    assert args[1] is False


# --------------------------- borrado ---------------------------


def test_un_punto_con_comprobantes_o_usuarios_del_dashboard_no_se_puede_borrar():
    sqls = dict(borrado._CHEQUEOS_PUNTO)
    assert "traslado_comprobantes" in sqls["comprobantes de traslados"] and "$1::uuid" in sqls["comprobantes de traslados"]
    assert "traslados" in sqls["traslados nuevos sin comprobantes"]
    assert "usuarios_dashboard" in sqls["usuarios del dashboard asignados"]


def test_un_usuario_del_dashboard_que_firmo_comprobantes_no_se_puede_borrar():
    sql = dict(borrado._CHEQUEOS_USUARIO_DASHBOARD)["comprobantes firmados"]
    assert "responsable_usuario_id = $1::uuid" in sql
