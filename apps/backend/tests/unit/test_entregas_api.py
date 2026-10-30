"""Endpoints de /entregas: flujo completo POST /procesar (con la IA simulada),
PATCH /{id}/items y la bitacora `logs`."""

import pytest

from tests import respuestas_vision as r
from tests.fakes import violacion_unica
from tests.helpers import encabezado_bearer, fila_item, fila_usuario_dashboard, payload_entrega

ENTREGA = "22222222-2222-2222-2222-222222222222"

FLUJO_NUEVA = [
    "foto_capturada",
    "extraccion_ia",
    "chequeo_duplicado",
    "entrega_insertada",
    "validacion",
    "sync_tiempo_real",
]


def guionar_alta(conn):
    conn.responder("fetchval", "insert into entregas", ENTREGA)
    conn.responder("fetchval", "insert into entrega_items", "i1", "i2", "i3")


def guionar_existente(conn, pendientes):
    conn.responder("fetchval", "insert into entregas", violacion_unica("entregas_tipo_indicativo_numero_key"))
    conn.responder(
        "fetchrow",
        "select id, tipo, indicativo_numero, es_faia, nota_general, firma_url",
        {"id": ENTREGA, "tipo": "FEI", "indicativo_numero": "10254", "es_faia": False,
         "nota_general": None, "firma_url": None},
    )
    conn.responder("fetch", "from entrega_items i", [fila_item(f"i{n}", pendiente=p) for n, p in enumerate(pendientes)])


# --------------------------------------------------------------------------
# POST /entregas/procesar
# --------------------------------------------------------------------------


async def test_alta_confianza_crea_la_entrega_procesada(cliente, pool, conn, vision):
    guionar_alta(conn)
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-01"})
    vision.responder(r.ALTA_CONFIANZA)
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 201
    cuerpo = res.json()
    assert (cuerpo["situacion"], cuerpo["estado"], cuerpo["id"]) == ("nueva", "procesada", ENTREGA)
    assert (cuerpo["tipo"], cuerpo["indicativo_numero"]) == ("FEI", "10254")
    assert cuerpo["items"][0]["cantidad_pendiente"] == 3
    assert conn.eventos_log() == FLUJO_NUEVA


async def test_baja_confianza_queda_en_revision_manual(cliente, pool, conn, vision):
    guionar_alta(conn)
    vision.responder(r.BAJA_CONFIANZA)
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 201
    assert res.json()["estado"] == "pendiente_revision"
    validacion = [e for e in conn.inserts_log() if e[0] == "validacion"][0]
    assert validacion[5] == "revision_manual"


async def test_foto_ilegible_se_rechaza_y_no_crea_nada(cliente, pool, conn, vision):
    vision.responder(r.ILEGIBLE)
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 422
    assert "No se pudo leer el documento" in res.json()["detail"]
    assert conn.sql_ejecutado("insert into entregas") == []
    assert "entrega_insertada" not in conn.eventos_log()
    assert [e for e in conn.inserts_log() if e[0] == "validacion"][0][5] == "rechazada_ilegible"


async def test_varios_items_se_devuelven_todos(cliente, pool, conn, vision):
    guionar_alta(conn)
    vision.responder(r.VARIOS_ITEMS)
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 201
    assert [i["cantidad_pendiente"] for i in res.json()["items"]] == [4, 10, 6]


async def test_respuesta_de_ia_malformada_da_422_y_queda_en_log(cliente, pool, conn, vision):
    vision.responder(r.MALFORMADA)
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 422
    assert "Respuesta de IA invalida" in res.json()["detail"]
    assert conn.eventos_log() == ["foto_capturada", "extraccion_ia"]
    assert conn.inserts_log()[1][5] == "error"
    assert conn.sql_ejecutado("insert into entregas") == []


async def test_documento_ya_entregado_por_completo_responde_409(cliente, pool, conn, vision):
    guionar_existente(conn, pendientes=(0, 0))
    vision.responder(r.ALTA_CONFIANZA)
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-01"})
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 409
    assert "ya fue procesado por completo" in res.json()["detail"]
    assert "duplicado_bloqueado" in conn.eventos_log()


async def test_documento_con_pendiente_responde_200_actualizable(cliente, pool, conn, vision):
    guionar_existente(conn, pendientes=(0, 3))
    vision.responder(r.ALTA_CONFIANZA)
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-01"})
    res = await cliente.post("/entregas/procesar", json=payload_entrega(sede_origen_id="otra-sede"))
    assert res.status_code == 200
    cuerpo = res.json()
    assert (cuerpo["situacion"], cuerpo["id"]) == ("actualizable", ENTREGA)
    assert cuerpo["requiere_traslado"] is False
    assert [i["cantidad_pendiente"] for i in cuerpo["items"]] == [0, 3]


async def test_con_lectura_previa_completa_no_se_vuelve_a_llamar_a_la_ia(cliente, pool, conn, vision):
    guionar_alta(conn)
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-01"})
    res = await cliente.post(
        "/entregas/procesar",
        json=payload_entrega(
            tipo_conocido="FEI",
            indicativo_numero_conocido="77",
            items_conocidos=[{"descripcion": "A", "cantidad": 1}],
            confianza_conocida={"tipo": 0.9, "indicativo_numero": 0.9, "items": 0.9},
        ),
    )
    assert res.status_code == 201
    assert vision.llamadas == []


async def test_necesita_traslado_no_inserta_y_responde_200(cliente, pool, conn, vision):
    conn.responder("fetchval", "insert into entregas", ENTREGA)
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-02"})
    vision.responder(r.ALTA_CONFIANZA)  # FEI pertenece a SEDE-01
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 200
    assert res.json()["situacion"] == "necesita_traslado"
    assert res.json()["id"] is None
    assert "entrega_insertada" not in conn.eventos_log()


async def test_remision_en_despachos_da_422_con_codigo(cliente, pool, conn, vision):
    vision.responder({**r.ALTA_CONFIANZA, "tipo": "RM3"})
    res = await cliente.post("/entregas/procesar", json=payload_entrega())
    assert res.status_code == 422
    assert res.json()["code"] == "remision_en_despachos"


@pytest.mark.parametrize(
    "cuerpo",
    [
        {},
        {"evidencia_url": "x"},
        payload_entrega(flujo="otro"),
        {k: v for k, v in payload_entrega().items() if k != "hash_evidencia"},
        payload_entrega(capturado_at="no-es-fecha"),
    ],
)
async def test_payload_invalido_da_422_sin_llamar_a_nada(cliente, pool, conn, vision, cuerpo):
    res = await cliente.post("/entregas/procesar", json=cuerpo)
    assert res.status_code == 422
    assert conn.llamadas == []
    assert vision.llamadas == []


# --------------------------------------------------------------------------
# PATCH /entregas/{id}/items
# --------------------------------------------------------------------------


def cuerpo_items(*items, **extra):
    return {"items": list(items), "operador_id": "operador-1", "sede_id": "sede-1", **extra}


def entrega_existe(conn):
    conn.responder("fetchrow", "select id from entregas where id", {"id": ENTREGA})


async def test_items_entrega_inexistente_da_404(cliente, pool, conn):
    res = await cliente.patch(f"/entregas/{ENTREGA}/items", json=cuerpo_items({"id": "i1", "entregado_hoy": 1}))
    assert res.status_code == 404


async def test_items_confirma_y_devuelve_los_items(cliente, pool, conn):
    entrega_existe(conn)
    conn.responder("fetchrow", "update entrega_items", {"id": "i1"})
    conn.responder("fetch", "from entrega_items i", [fila_item("i1", pendiente=1, entregada=2)])
    res = await cliente.patch(f"/entregas/{ENTREGA}/items", json=cuerpo_items({"id": "i1", "entregado_hoy": 2}))
    assert res.status_code == 200
    assert res.json()["items"][0]["cantidad_pendiente"] == 1
    assert "entrega_actualizada" in conn.eventos_log()


async def test_items_mas_de_lo_pendiente_da_422(cliente, pool, conn):
    entrega_existe(conn)
    conn.responder("fetchrow", "update entrega_items", None)
    conn.responder("fetchrow", "select descripcion, cantidad_pendiente", {"descripcion": "SAL", "cantidad_pendiente": 1})
    res = await cliente.patch(f"/entregas/{ENTREGA}/items", json=cuerpo_items({"id": "i1", "entregado_hoy": 9}))
    assert res.status_code == 422
    assert "no se puede entregar 9" in res.json()["detail"]


@pytest.mark.parametrize(
    "item",
    [
        {"id": "i1", "entregado_hoy": -1},
        {"id": "i1", "cantidad_pendiente": -1},
        {"id": "i1", "cantidad_pendiente": 1, "entregado_hoy": 1},
        {"id": "i1"},
        {"entregado_hoy": 1},
    ],
)
async def test_items_invalidos_dan_422_antes_de_tocar_la_base(cliente, pool, conn, item):
    res = await cliente.patch(f"/entregas/{ENTREGA}/items", json=cuerpo_items(item))
    assert res.status_code == 422
    assert conn.llamadas == []


async def test_items_faia_viewer_da_403(cliente, pool, conn):
    entrega_existe(conn)
    conn.responder("fetchrow", "select rol from empleados", {"rol": "faia_viewer"})
    res = await cliente.patch(f"/entregas/{ENTREGA}/items", json=cuerpo_items({"id": "i1", "entregado_hoy": 1}))
    assert res.status_code == 403


async def test_items_de_otra_sede_sin_traslado_da_409_estructurado(cliente, pool, conn):
    entrega_existe(conn)
    conn.responder("fetchrow", "select rol from empleados", {"rol": "operador"})
    conn.responder(
        "fetchrow",
        "select tipo, indicativo_numero, traslado_url from entregas",
        {"tipo": "FEI", "indicativo_numero": "10254", "traslado_url": None},
    )
    conn.responder("fetchrow", "select codigo from sedes", {"codigo": "SEDE-02"})
    res = await cliente.patch(f"/entregas/{ENTREGA}/items", json=cuerpo_items({"id": "i1", "entregado_hoy": 1}))
    assert res.status_code == 409
    assert res.json()["detail"] == {"situacion": "necesita_traslado", "tipo": "FEI", "indicativo_numero": "10254"}


async def test_items_con_sesion_consulta_da_403(cliente, pool, conn):
    usuario = fila_usuario_dashboard(rol="consulta")
    conn.responder("fetchrow", "from usuarios_dashboard where id", usuario)
    res = await cliente.patch(
        f"/entregas/{ENTREGA}/items",
        json=cuerpo_items({"id": "i1", "entregado_hoy": 1}),
        headers=encabezado_bearer(usuario),
    )
    assert res.status_code == 403


async def test_items_con_sesion_de_supervisor_actua_a_nombre_del_dashboard(cliente, pool, conn):
    usuario = fila_usuario_dashboard(rol="supervisor", usuario="marta")
    conn.responder("fetchrow", "from usuarios_dashboard where id", usuario)
    entrega_existe(conn)
    conn.responder("fetch", "from entrega_items i", [fila_item("i1", pendiente=0)])
    res = await cliente.patch(
        f"/entregas/{ENTREGA}/items",
        json=cuerpo_items({"id": "i1", "cantidad_pendiente": 0}, operador_id="lo-que-diga-el-cliente"),
        headers=encabezado_bearer(usuario),
    )
    assert res.status_code == 200
    assert conn.inserts_log()[-1][3] == "dashboard:marta"


# --------------------------------------------------------------------------
# DELETE /entregas/{id} (cancelar) y /revisar
# --------------------------------------------------------------------------


async def test_cancelar_es_publico_e_idempotente(cliente, pool, conn):
    conn.responder("execute", "delete from entregas", "DELETE 0")
    res = await cliente.delete(f"/entregas/{ENTREGA}")
    assert res.status_code == 200
    assert res.json() == {"cancelado": False}


@pytest.mark.parametrize("tipo", ["", "   "])
async def test_revisar_rechaza_tipo_vacio(cliente, pool, conn, admin_headers, tipo):
    res = await cliente.patch(f"/entregas/{ENTREGA}/revisar", json={"tipo": tipo}, headers=admin_headers)
    assert res.status_code == 422
