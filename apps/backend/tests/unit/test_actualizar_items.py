"""aplicar_actualizacion_items() y cancelar_entrega_no_confirmada() (paso 2).

Aqui se verifica la logica de Python y el SQL que se emite; que el delta sea
realmente atomico entre dos conexiones concurrentes lo prueba
tests/integration/test_items_concurrencia.py contra Postgres."""

import pytest

from app.models.entrega import ItemActualizacion, RetiradoPor
from app.services.duplicates import (
    CantidadInvalida,
    NecesitaTrasladoParaConfirmar,
    RolNoAutorizado,
    aplicar_actualizacion_items,
    cancelar_entrega_no_confirmada,
    requiere_traslado,
)
from tests.helpers import fila_item

ENTREGA = "11111111-1111-1111-1111-111111111111"
BASE = dict(operador_id="operador-1", sede_id="sede-1")


def item(**campos) -> ItemActualizacion:
    return ItemActualizacion(id="item-1", **campos)


def con_resultado(conn, *filas):
    conn.responder("fetch", "from entrega_items i", list(filas) or [fila_item(pendiente=0)])


# --------------------------------------------------------------------------
# entregado_hoy: delta atomico validado en SQL
# --------------------------------------------------------------------------


async def test_delta_emite_update_condicionado_al_pendiente(pool, conn):
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn, fila_item(pendiente=2, entregada=3))
    items = await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=3)], **BASE)

    _, sql, args = conn.sql_ejecutado("update entrega_items")[0]
    # La validacion "no se entrega mas de lo pendiente" y el calculo viven en el SQL.
    assert "cantidad_pendiente >= $2" in sql
    assert "cantidad_pendiente = cantidad_pendiente - $2" in sql
    assert "cantidad_entregada + $2" in sql
    assert args[:3] == ("item-1", 3, ENTREGA)
    assert [(i.cantidad_entregada, i.cantidad_pendiente) for i in items] == [(3, 2)]
    assert conn.eventos_log() == ["entrega_actualizada"]


async def test_delta_mayor_al_pendiente_se_rechaza_sin_escribir_log(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)  # la condicion no se cumplio
    conn.responder("fetchrow", "select descripcion, cantidad_pendiente", {"descripcion": "SAL", "cantidad_pendiente": 2})
    with pytest.raises(CantidadInvalida, match="tiene 2 pendiente"):
        await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=5)], **BASE)
    assert conn.eventos_log() == []


async def test_delta_sobre_item_inexistente_se_rechaza(pool, conn):
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_pendiente", None)
    with pytest.raises(CantidadInvalida, match="no existe en esta entrega"):
        await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], **BASE)


async def test_entregado_hoy_negativo_no_pasa_el_modelo():
    with pytest.raises(ValueError):
        item(entregado_hoy=-1)


# --------------------------------------------------------------------------
# cantidad_pendiente: valor absoluto
# --------------------------------------------------------------------------


async def test_pendiente_absoluto_se_fija_y_deriva_lo_entregado(pool, conn):
    con_resultado(conn, fila_item(pendiente=4, entregada=6))
    items = await aplicar_actualizacion_items(ENTREGA, [item(cantidad_pendiente=4)], **BASE)

    # No usa la rama de delta.
    assert conn.sql_ejecutado("cantidad_pendiente >= $2") == []
    _, sql, args = conn.sql_ejecutado("update entrega_items")[0]
    assert "greatest(cantidad_pendiente - $4::int, 0)" in sql
    assert args == ("item-1", None, None, 4, ENTREGA, None)
    assert items[0].cantidad_pendiente == 4


async def test_correccion_explicita_de_cantidad_entregada_gana(pool, conn):
    con_resultado(conn)
    await aplicar_actualizacion_items(ENTREGA, [item(cantidad_entregada=9, cantidad_pendiente=1)], **BASE)
    _, _, args = conn.sql_ejecutado("update entrega_items")[0]
    assert args[2] == 9 and args[3] == 1


async def test_solo_nota_no_toca_cantidades(pool, conn):
    con_resultado(conn)
    await aplicar_actualizacion_items(ENTREGA, [item(nota="llego danado")], **BASE)
    _, _, args = conn.sql_ejecutado("update entrega_items")[0]
    assert args[2] is None and args[3] is None and args[5] == "llego danado"


def test_pendiente_y_delta_son_excluyentes():
    with pytest.raises(ValueError, match="excluyentes"):
        item(cantidad_pendiente=1, entregado_hoy=1)


def test_item_sin_cambios_se_rechaza():
    with pytest.raises(ValueError, match="ningun cambio"):
        item()


@pytest.mark.parametrize("campo", ["cantidad_pendiente", "cantidad_entregada"])
def test_cantidades_negativas_se_rechazan(campo):
    with pytest.raises(ValueError):
        item(**{campo: -1})


# --------------------------------------------------------------------------
# "Entregado en punto de venta / otra bodega"
# --------------------------------------------------------------------------


async def test_entregado_en_punto_de_venta_exige_que_no_quede_pendiente(pool, conn):
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn, fila_item(pendiente=3))
    with pytest.raises(CantidadInvalida, match="exige que no quede nada pendiente"):
        await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1, desde_punto_venta=True)], **BASE)
    assert conn.eventos_log() == []


async def test_entregado_en_punto_de_venta_con_todo_cerrado_no_acredita_a_bodega(pool, conn):
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn, fila_item(pendiente=0, entregada=2))
    await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=2, desde_punto_venta=True)], **BASE)
    assert conn.sql_ejecutado("update entregas set bodeguero_id") == []
    assert conn.inserts_log()[0][6]["desde_punto_venta"] is True


# --------------------------------------------------------------------------
# Quien confirma
# --------------------------------------------------------------------------


async def test_confirmacion_de_bodega_registra_al_bodeguero(pool, conn):
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn)
    await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], **BASE)
    _, _, args = conn.sql_ejecutado("update entregas set bodeguero_id")[0]
    assert args == (ENTREGA, "operador-1")


async def test_correccion_del_dashboard_no_pisa_al_bodeguero_y_deja_antes_despues(pool, conn):
    conn.responder(
        "fetch",
        "select id, descripcion, cantidad_entregada, cantidad_pendiente",
        [{"id": "item-1", "descripcion": "SAL", "cantidad_entregada": 0, "cantidad_pendiente": 5}],
    )
    con_resultado(conn, fila_item(descripcion="SAL", pendiente=2, entregada=3))
    await aplicar_actualizacion_items(
        ENTREGA, [item(cantidad_pendiente=2)], operador_id="dashboard:ana", sede_id="dashboard"
    )
    assert conn.sql_ejecutado("update entregas set bodeguero_id") == []
    detalle = conn.inserts_log()[0][6]
    assert detalle["correccion_dashboard"] is True
    assert {c["campo"] for c in detalle["cambios"]} == {"cantidad_entregada", "cantidad_pendiente"}


async def test_log_incluye_quien_retiro(pool, conn):
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn)
    await aplicar_actualizacion_items(
        ENTREGA, [item(entregado_hoy=1)], retirado_por=RetiradoPor(nombre="Luis", telefono="300"), **BASE
    )
    assert conn.inserts_log()[0][6]["retirado_por"] == {"nombre": "Luis", "telefono": "300"}


# --------------------------------------------------------------------------
# Roles
# --------------------------------------------------------------------------


def con_rol(conn, rol):
    conn.responder("fetchrow", "select rol from empleados", {"rol": rol})


async def test_faia_viewer_no_puede_confirmar_nada(pool, conn):
    con_rol(conn, "faia_viewer")
    with pytest.raises(RolNoAutorizado):
        await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], **BASE)
    assert conn.sql_ejecutado("update entrega_items") == []


async def test_punto_venta_no_confirma_cantidades(pool, conn):
    con_rol(conn, "punto_venta")
    with pytest.raises(RolNoAutorizado):
        await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], **BASE)


async def test_punto_venta_si_puede_cambiar_el_flag_faia_sin_items(pool, conn):
    con_rol(conn, "punto_venta")
    conn.responder("fetchrow", "select es_faia from entregas", {"es_faia": False})
    await aplicar_actualizacion_items(ENTREGA, [], es_faia=True, **BASE)
    assert conn.sql_ejecutado("set es_faia")


async def test_otro_rol_no_cambia_el_flag_faia_pero_la_confirmacion_sigue(pool, conn):
    con_rol(conn, "operador")
    conn.responder("fetchrow", "select es_faia from entregas", {"es_faia": False})
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn)
    await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], es_faia=True, **BASE)
    assert conn.sql_ejecutado("set es_faia") == []


async def test_nota_general_vacia_borra_la_nota(pool, conn):
    await aplicar_actualizacion_items(ENTREGA, [], nota_general="", **BASE)
    _, _, args = conn.sql_ejecutado("set nota_general")[0]
    assert args == (ENTREGA, "")


# --------------------------------------------------------------------------
# Compuerta de sede al confirmar
# --------------------------------------------------------------------------


def entrega_ajena(conn, traslado_url=None, tipo="FEI"):
    conn.responder(
        "fetchrow",
        "select tipo, indicativo_numero, traslado_url from entregas",
        {"tipo": tipo, "indicativo_numero": "21542", "traslado_url": traslado_url},
    )
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-02"})
    conn.responder("fetchrow", "update entrega_items", {"id": "item-1"})
    con_resultado(conn)


async def test_confirmar_cantidades_de_otra_sede_exige_traslado(pool, conn):
    con_rol(conn, "operador")
    entrega_ajena(conn)
    with pytest.raises(NecesitaTrasladoParaConfirmar) as info:
        await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], **BASE)
    assert (info.value.tipo, info.value.indicativo_numero) == ("FEI", "21542")
    assert conn.sql_ejecutado("update entrega_items") == []


@pytest.mark.parametrize("ya_tiene_traslado", [False, True])
async def test_con_traslado_adjunto_o_guardado_se_permite(pool, conn, ya_tiene_traslado):
    con_rol(conn, "operador")
    entrega_ajena(conn, traslado_url="https://t.webp" if ya_tiene_traslado else None)
    extra = {} if ya_tiene_traslado else {"traslado_url": "https://nuevo.webp"}
    await aplicar_actualizacion_items(ENTREGA, [item(entregado_hoy=1)], **BASE, **extra)
    assert conn.sql_ejecutado("update entrega_items")


async def test_solo_nota_no_dispara_la_compuerta_de_sede(pool, conn):
    con_rol(conn, "operador")
    entrega_ajena(conn)
    await aplicar_actualizacion_items(ENTREGA, [item(nota="x")], **BASE)
    assert conn.sql_ejecutado("select tipo, indicativo_numero, traslado_url") == []


async def test_el_dashboard_sin_empleado_real_no_queda_bloqueado_por_sede(pool, conn):
    entrega_ajena(conn)  # fila_empleado es None: no es un empleado de bodega
    await aplicar_actualizacion_items(ENTREGA, [item(cantidad_pendiente=0)], **BASE)
    assert conn.sql_ejecutado("update entrega_items")


# --------------------------------------------------------------------------
# requiere_traslado / cancelar
# --------------------------------------------------------------------------


async def test_requiere_traslado_es_falso_para_tipos_sin_sede_duena(pool, conn):
    assert await requiere_traslado("XYZ", "sede-1") is False
    assert conn.llamadas == []


async def test_requiere_traslado_segun_la_sede(pool, conn):
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-01"}, {"codigo": "SEDE-02"})
    assert await requiere_traslado("FEI", "s1") is False
    assert await requiere_traslado("FEI", "s2") is True


async def test_requiere_traslado_se_corta_si_la_entrega_ya_tiene_traslado(pool, conn):
    conn.responder("fetchval", "select traslado_url is not null", True)
    assert await requiere_traslado("FEI", "s2", ENTREGA) is False


async def test_cancelar_borra_solo_si_nadie_confirmo(pool, conn):
    conn.responder("execute", "delete from entregas", "DELETE 1")
    assert await cancelar_entrega_no_confirmada(ENTREGA, operador_id="op", sede_id="s") is True
    assert conn.eventos_log() == ["entrega_cancelada"]
    _, sql, _ = conn.sql_ejecutado("delete from entregas")[0]
    assert "actualizado_at > creado_at" in sql  # la guarda que protege lo ya confirmado


async def test_cancelar_es_idempotente_y_no_registra_si_no_borro(pool, conn):
    conn.responder("execute", "delete from entregas", "DELETE 0")
    assert await cancelar_entrega_no_confirmada(ENTREGA, operador_id="op", sede_id="s") is False
    assert conn.eventos_log() == []
