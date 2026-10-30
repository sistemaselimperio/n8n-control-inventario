"""Devoluciones (app/services/devoluciones.py) y unidades no entregadas
(app/services/no_entregados.py): el UPDATE condicionado es la validacion real,
y cada operacion deja su fila y su evento en la bitacora."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.models.devolucion import DevolucionCreate
from app.models.no_entregado import NoEntregadoCreate
from app.services.devoluciones import DevolucionInvalida, registrar_devolucion
from app.services.duplicates import RolNoAutorizado
from app.services.no_entregados import NoEntregadoInvalido, registrar_no_entregado

ENTREGA = "33333333-3333-3333-3333-333333333333"
ITEM = "44444444-4444-4444-4444-444444444444"


def devolucion(**extra) -> DevolucionCreate:
    cuerpo = {
        "item_id": ITEM, "cantidad": 2, "motivo": "danado", "resolucion": "reposicion",
        "operador_id": "op-1", "sede_id": "sede-1",
    }
    cuerpo.update(extra)
    return DevolucionCreate(**cuerpo)


def no_entregado(**extra) -> NoEntregadoCreate:
    cuerpo = {"item_id": ITEM, "cantidad": 2, "motivo": "facturado_de_mas", "operador_id": "op-1", "sede_id": "sede-1"}
    cuerpo.update(extra)
    return NoEntregadoCreate(**cuerpo)


def fila_actualizada(entregada: int = 3, pendiente: int = 2, no_entregada: int = 0, **extra) -> dict:
    fila = {
        "id": ITEM, "descripcion": "SAL", "cantidad_entregada": entregada,
        "cantidad_pendiente": pendiente, "cantidad_no_entregada": no_entregada, "nota": None,
    }
    fila.update(extra)
    return fila


# --------------------------------------------------------------------------
# Modelos
# --------------------------------------------------------------------------


@pytest.mark.parametrize("cantidad", [0, -1])
def test_la_cantidad_debe_ser_positiva(cantidad):
    with pytest.raises(ValidationError):
        devolucion(cantidad=cantidad)
    with pytest.raises(ValidationError):
        no_entregado(cantidad=cantidad)


def test_el_motivo_otro_exige_detalle_y_se_limpia():
    for fabrica, motivo in ((devolucion, "otro"), (no_entregado, "otro")):
        with pytest.raises(ValidationError):
            fabrica(motivo=motivo)
        with pytest.raises(ValidationError):
            fabrica(motivo=motivo, motivo_detalle="   ")
        assert fabrica(motivo=motivo, motivo_detalle="  se cayo  ").motivo_detalle == "se cayo"


def test_el_detalle_se_descarta_si_el_motivo_no_es_otro():
    assert devolucion(motivo="danado", motivo_detalle="texto suelto").motivo_detalle is None
    assert no_entregado(motivo="facturado_de_mas", motivo_detalle="texto suelto").motivo_detalle is None


@pytest.mark.parametrize("campo, valor", [("motivo", "inventado"), ("resolucion", "inventada")])
def test_valores_fuera_de_la_lista_se_rechazan(campo, valor):
    with pytest.raises(ValidationError):
        devolucion(**{campo: valor})


# --------------------------------------------------------------------------
# registrar_devolucion
# --------------------------------------------------------------------------


async def test_reposicion_baja_lo_entregado_y_sube_lo_pendiente(pool, conn):
    conn.responder("fetchrow", "update entrega_items", fila_actualizada(entregada=3, pendiente=4))
    item = await registrar_devolucion(ENTREGA, devolucion(resolucion="reposicion", cantidad=2))

    (_, sql, args) = conn.sql_ejecutado("update entrega_items")[0]
    assert "cantidad_entregada = cantidad_entregada - $2" in sql
    assert "cantidad_pendiente = cantidad_pendiente + $2" in sql
    # La validacion real vive en el UPDATE: no se puede devolver mas de lo entregado...
    assert "cantidad_entregada >= $2" in sql
    # ...ni de algo que nunca se confirmo.
    assert "actualizado_at > creado_at" in sql
    assert args == (ITEM, 2, ENTREGA)
    assert (item.cantidad_entregada, item.cantidad_pendiente, item.confirmado) == (3, 4, True)


@pytest.mark.parametrize("resolucion", ["reembolso", "no_lo_lleva"])
async def test_reembolso_y_no_lo_lleva_cierran_las_unidades_sin_tocar_lo_pendiente(pool, conn, resolucion):
    conn.responder("fetchrow", "update entrega_items", fila_actualizada(entregada=1, pendiente=0))
    await registrar_devolucion(ENTREGA, devolucion(resolucion=resolucion))
    (_, sql, _) = conn.sql_ejecutado("update entrega_items")[0]
    assert "cantidad_entregada = cantidad_entregada - $2" in sql
    assert "cantidad_pendiente" not in sql.split("returning")[0]  # el pendiente queda igual
    assert "cantidad_entregada >= $2" in sql and "actualizado_at > creado_at" in sql


async def test_una_devolucion_valida_deja_su_fila_y_su_evento(pool, conn):
    conn.responder("fetchrow", "update entrega_items", fila_actualizada())
    await registrar_devolucion(
        ENTREGA, devolucion(motivo="otro", motivo_detalle="no era el color", resolucion="reembolso", cantidad=1)
    )
    (_, _, args) = conn.sql_ejecutado("insert into devoluciones")[0]
    assert args == (ENTREGA, ITEM, 1, "otro", "no era el color", "reembolso", "op-1", "sede-1")

    (evento,) = conn.inserts_log()
    assert evento[:6] == ("devolucion_registrada", "entrega", ENTREGA, "op-1", "sede-1", "ok")
    assert evento[6] == {
        "item_id": ITEM, "cantidad": 1, "motivo": "otro", "motivo_detalle": "no era el color", "resolucion": "reembolso",
    }


async def test_item_inexistente_en_la_entrega(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_entregada", None)
    with pytest.raises(DevolucionInvalida, match="no existe en esta entrega"):
        await registrar_devolucion(ENTREGA, devolucion())
    assert conn.sql_ejecutado("insert into devoluciones") == [] and conn.inserts_log() == []


async def test_item_sin_confirmar_no_se_puede_devolver(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_entregada", {"descripcion": "SAL", "cantidad_entregada": 5, "confirmado": False})
    with pytest.raises(DevolucionInvalida, match="todavia no fue confirmado"):
        await registrar_devolucion(ENTREGA, devolucion())
    assert conn.sql_ejecutado("insert into devoluciones") == [] and conn.inserts_log() == []


async def test_no_se_puede_devolver_mas_de_lo_entregado(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_entregada", {"descripcion": "SAL", "cantidad_entregada": 1, "confirmado": True})
    with pytest.raises(DevolucionInvalida, match="solo tiene 1 entregado, no se puede devolver 2"):
        await registrar_devolucion(ENTREGA, devolucion(cantidad=2))
    assert conn.sql_ejecutado("insert into devoluciones") == [] and conn.inserts_log() == []


async def test_si_falla_el_insert_de_la_devolucion_no_se_deja_evento(pool, conn):
    conn.responder("fetchrow", "update entrega_items", fila_actualizada())
    conn.responder("execute", "insert into devoluciones", RuntimeError("caida"))
    with pytest.raises(RuntimeError):
        await registrar_devolucion(ENTREGA, devolucion())
    assert conn.inserts_log() == []


# --------------------------------------------------------------------------
# registrar_no_entregado
# --------------------------------------------------------------------------


async def test_no_entregado_mueve_de_pendiente_a_no_entregada_de_forma_condicionada(pool, conn):
    conn.responder("fetchrow", "update entrega_items", fila_actualizada(pendiente=1, no_entregada=2, confirmado=False))
    item = await registrar_no_entregado(ENTREGA, no_entregado(cantidad=2))

    (_, sql, args) = conn.sql_ejecutado("update entrega_items")[0]
    assert "cantidad_pendiente = cantidad_pendiente - $2" in sql
    assert "cantidad_no_entregada = cantidad_no_entregada + $2" in sql
    assert "cantidad_pendiente >= $2" in sql
    # No toca actualizado_at: esta accion no cuenta como "confirmar cantidades".
    assert "actualizado_at =" not in sql
    assert args == (ITEM, 2, ENTREGA)
    assert (item.cantidad_pendiente, item.cantidad_no_entregada, item.confirmado) == (1, 2, False)


async def test_no_entregado_deja_su_fila_y_su_evento_con_el_producto(pool, conn):
    conn.responder("fetchrow", "update entrega_items", fila_actualizada(confirmado=True))
    await registrar_no_entregado(ENTREGA, no_entregado(motivo="otro", motivo_detalle="  sobraba  "))
    (_, _, args) = conn.sql_ejecutado("insert into items_no_entregados")[0]
    assert args == (ENTREGA, ITEM, 2, "otro", "sobraba", "op-1", "sede-1")
    (evento,) = conn.inserts_log()
    assert evento[:6] == ("item_no_entregado", "entrega", ENTREGA, "op-1", "sede-1", "ok")
    assert evento[6]["producto"] == "SAL" and evento[6]["motivo_detalle"] == "sobraba"


@pytest.mark.parametrize("rol", ["faia_viewer", "punto_venta"])
async def test_roles_de_solo_lectura_o_mostrador_no_pueden_marcar_no_entregados(pool, conn, rol):
    conn.responder("fetchrow", "select rol from empleados", {"rol": rol})
    with pytest.raises(RolNoAutorizado):
        await registrar_no_entregado(ENTREGA, no_entregado())
    assert conn.sql_ejecutado("update entrega_items") == [] and conn.inserts_log() == []


@pytest.mark.parametrize("rol", ["operador", "supervisor", "admin"])
async def test_roles_de_bodega_si_pueden(pool, conn, rol):
    conn.responder("fetchrow", "select rol from empleados", {"rol": rol})
    conn.responder("fetchrow", "update entrega_items", fila_actualizada(confirmado=True))
    await registrar_no_entregado(ENTREGA, no_entregado())
    assert len(conn.inserts_log()) == 1


async def test_un_operador_desconocido_como_el_supervisor_del_dashboard_nunca_se_bloquea(pool, conn):
    conn.responder("fetchrow", "select rol from empleados", None)
    conn.responder("fetchrow", "update entrega_items", fila_actualizada(confirmado=True))
    await registrar_no_entregado(ENTREGA, no_entregado(operador_id="dashboard:ana"))
    assert conn.inserts_log()[0][3] == "dashboard:ana"


async def test_no_entregado_de_item_inexistente(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_pendiente", None)
    with pytest.raises(NoEntregadoInvalido, match="no existe en esta entrega"):
        await registrar_no_entregado(ENTREGA, no_entregado())
    assert conn.inserts_log() == []


async def test_no_entregado_mayor_a_lo_pendiente(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_pendiente", {"descripcion": "SAL", "cantidad_pendiente": 1})
    with pytest.raises(NoEntregadoInvalido, match="solo tiene 1 pendiente, no se pueden marcar 2"):
        await registrar_no_entregado(ENTREGA, no_entregado(cantidad=2))
    assert conn.sql_ejecutado("insert into items_no_entregados") == [] and conn.inserts_log() == []


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

CUERPO_DEV = {
    "item_id": ITEM, "cantidad": 1, "motivo": "danado", "resolucion": "reposicion", "operador_id": "op", "sede_id": "s",
}
CUERPO_NO = {"item_id": ITEM, "cantidad": 1, "motivo": "producto_equivocado", "operador_id": "op", "sede_id": "s"}


@pytest.mark.parametrize("ruta, cuerpo", [("devoluciones", CUERPO_DEV), ("no-entregados", CUERPO_NO)])
async def test_http_entrega_inexistente_da_404(cliente, pool, conn, ruta, cuerpo):
    conn.responder("fetchrow", "select id from entregas", None)
    res = await cliente.post(f"/entregas/{ENTREGA}/{ruta}", json=cuerpo)
    assert res.status_code == 404
    assert conn.sql_ejecutado("update entrega_items") == []


@pytest.mark.parametrize(
    "ruta, cuerpo, detalle",
    [("devoluciones", CUERPO_DEV, "no existe en esta entrega"), ("no-entregados", CUERPO_NO, "no existe en esta entrega")],
)
async def test_http_item_invalido_da_422_y_no_502(cliente, pool, conn, ruta, cuerpo, detalle):
    conn.responder("fetchrow", "select id from entregas", {"id": ENTREGA})
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion", None)
    res = await cliente.post(f"/entregas/{ENTREGA}/{ruta}", json=cuerpo)
    assert res.status_code == 422
    assert detalle in res.json()["detail"]


async def test_http_devolucion_correcta_devuelve_el_item(cliente, pool, conn):
    conn.responder("fetchrow", "select id from entregas", {"id": ENTREGA})
    conn.responder("fetchrow", "update entrega_items", fila_actualizada())
    res = await cliente.post(f"/entregas/{ENTREGA}/devoluciones", json=CUERPO_DEV)
    assert res.status_code == 200
    assert res.json()["item"]["id"] == ITEM and res.json()["item"]["confirmado"] is True


async def test_http_no_entregado_de_un_rol_no_autorizado_da_403(cliente, pool, conn):
    conn.responder("fetchrow", "select id from entregas", {"id": ENTREGA})
    conn.responder("fetchrow", "select rol from empleados", {"rol": "punto_venta"})
    res = await cliente.post(f"/entregas/{ENTREGA}/no-entregados", json=CUERPO_NO)
    assert res.status_code == 403


@pytest.mark.parametrize("ruta", ["devoluciones", "no-entregados"])
@pytest.mark.parametrize(
    "cambio",
    [{"cantidad": 0}, {"cantidad": -3}, {"cantidad": "x"}, {"motivo": "otro"}, {"operador_id": None}],
)
async def test_http_cuerpo_invalido_da_422_sin_tocar_la_base(cliente, pool, conn, ruta, cambio):
    base = CUERPO_DEV if ruta == "devoluciones" else CUERPO_NO
    res = await cliente.post(f"/entregas/{ENTREGA}/{ruta}", json={**base, **cambio})
    assert res.status_code == 422
    assert conn.llamadas == []
