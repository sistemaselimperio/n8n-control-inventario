"""puntos.alias ("otros nombres" con los que el sistema contable escribe un punto):
normalizacion y validacion al crear/editar desde /creador, y su lectura en el
listado de administracion. La resolucion contra el texto del PDF esta en
test_traslados_reglas.py y test_pdf_traslado_bodega.py."""

import uuid

import pytest

from app.services import puntos_alias
from app.services.usuarios import DatoInvalido
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

PUNTO = "22222222-2222-2222-2222-222222222222"
OTRO = "33333333-3333-3333-3333-333333333333"

OTROS_PUNTOS = [
    {"nombre": "SFC — Samacá", "codigo": "SFC", "alias": ["Bodega Samaca Vieja"]},
    {"nombre": "BV — Bodega Ventas", "codigo": "BV", "alias": ["Principal", "Bodega Central"]},
]


def _sesion(conn, rol="admin", area="todo") -> dict:
    fila = fila_usuario_dashboard(rol=rol, area=area)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def _fila_actualizada(alias) -> dict:
    return {"id": uuid.UUID(PUNTO), "nombre": "X", "codigo": "X", "activo": True, "es_interna": False, "alias": alias}


# --------------------------- normalizacion (pura) ---------------------------


def test_normalizar_recorta_descarta_vacios_y_deduplica_por_clave():
    entrada = ["  Principal ", "principal", "", "   ", "BODEGA PRINCIPAL", "Bodega  Agroquímicos Estación", "agroquimicos estacion"]
    # Los espacios internos repetidos se colapsan en lo que se guarda.
    assert puntos_alias.normalizar_alias(entrada) == ["Principal", "Bodega Agroquímicos Estación"]


def test_normalizar_conserva_el_primer_texto_y_el_orden():
    assert puntos_alias.normalizar_alias(["Zeta", " alfa ", "ZETA", "Alfa"]) == ["Zeta", "alfa"]


def test_normalizar_lista_vacia_o_solo_espacios_da_lista_vacia():
    assert puntos_alias.normalizar_alias([]) == []
    assert puntos_alias.normalizar_alias(["", "  "]) == []


def test_normalizar_rechaza_un_alias_sin_clave_utilizable(monkeypatch):
    # Un texto que no vacia el recorte pero cuya clave queda vacia no sirve para resolver nada.
    monkeypatch.setattr(puntos_alias, "_clave", lambda texto: "")
    with pytest.raises(DatoInvalido, match="no es válido"):
        puntos_alias.normalizar_alias(["Algo"])


# --------------------------- editar (PATCH /puntos/{id}) ---------------------------


async def test_editar_alias_guarda_la_lista_normalizada(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    conn.responder("fetchrow", "update puntos set", _fila_actualizada(["Principal Norte"]))
    res = await cliente.patch(
        f"/puntos/{PUNTO}", json={"alias": ["  Principal Norte ", "principal norte", ""]}, headers=_sesion(conn)
    )
    assert res.status_code == 200 and res.json()["alias"] == ["Principal Norte"]
    (_, sql, args) = conn.sql_ejecutado("update puntos set")[0]
    assert "alias = $2" in sql and args[1] == ["Principal Norte"]
    assert conn.eventos_log() == ["admin_cambio"]


async def test_editar_alias_excluye_al_propio_punto_y_solo_mira_activos(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", [])
    conn.responder("fetchrow", "update puntos set", _fila_actualizada(["Nuevo"]))
    await cliente.patch(f"/puntos/{PUNTO}", json={"alias": ["Nuevo"]}, headers=_sesion(conn))
    (_, sql, args) = conn.sql_ejecutado("alias from puntos where activo")[0]
    assert "activo = true" in sql and args == (PUNTO,)


async def test_editar_alias_repetido_de_otro_punto_responde_409(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"alias": ["bodega principal"]}, headers=_sesion(conn))
    assert res.status_code == 409
    assert "bodega principal" in res.json()["detail"] and "BV — Bodega Ventas" in res.json()["detail"]
    assert conn.sql_ejecutado("update puntos set") == []


async def test_editar_alias_igual_al_nombre_de_otro_punto_responde_409(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"alias": ["Bodega Samacá"]}, headers=_sesion(conn))
    assert res.status_code == 409 and "SFC — Samacá" in res.json()["detail"]
    assert conn.sql_ejecutado("update puntos set") == []


async def test_editar_alias_vacio_limpia_los_otros_nombres(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    conn.responder("fetchrow", "update puntos set", _fila_actualizada([]))
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"alias": []}, headers=_sesion(conn))
    assert res.status_code == 200
    (_, _, args) = conn.sql_ejecutado("update puntos set")[0]
    assert args[1] == []


async def test_editar_sin_alias_no_consulta_los_otros_puntos(cliente, pool, conn):
    conn.responder("fetchrow", "update puntos set", _fila_actualizada([]))
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"es_interna": True}, headers=_sesion(conn))
    assert res.status_code == 200
    assert conn.sql_ejecutado("alias from puntos where activo") == []


@pytest.mark.parametrize(
    "alias",
    [["x"] * 21, ["a" * 81], "no-es-lista"],
)
async def test_editar_alias_fuera_de_limites_responde_422(cliente, pool, conn, alias):
    res = await cliente.patch(f"/puntos/{PUNTO}", json={"alias": alias}, headers=_sesion(conn))
    assert res.status_code == 422
    assert conn.sql_ejecutado("update puntos set") == []


async def test_editar_alias_exige_admin(cliente, pool, conn):
    res = await cliente.patch(
        f"/puntos/{PUNTO}", json={"alias": ["Algo"]}, headers=_sesion(conn, "supervisor", "traslados")
    )
    assert res.status_code == 403
    assert conn.sql_ejecutado("update puntos set") == []


# --------------------------- crear (POST /puntos) ---------------------------


async def test_crear_punto_con_alias_guarda_la_lista_normalizada(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    conn.responder("fetchrow", "insert into puntos", {"id": uuid.UUID(PUNTO), "nombre": "Nuevo", "alias": ["Otro"]})
    res = await cliente.post("/puntos", json={"nombre": "Nuevo", "alias": [" Otro ", "otro"]}, headers=_sesion(conn))
    assert res.status_code == 201
    assert res.json() == {"id": PUNTO, "nombre": "Nuevo", "alias": ["Otro"]}
    (_, sql, args) = conn.sql_ejecutado("insert into puntos")[0]
    assert "alias" in sql and args == ("Nuevo", ["Otro"])
    (_, _, args_validacion) = conn.sql_ejecutado("alias from puntos where activo")[0]
    assert args_validacion == (None,)  # punto nuevo: no hay a quien excluir


async def test_crear_punto_sin_alias_guarda_lista_vacia(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    conn.responder("fetchrow", "insert into puntos", {"id": uuid.UUID(PUNTO), "nombre": "Nuevo", "alias": []})
    res = await cliente.post("/puntos", json={"nombre": "Nuevo"}, headers=_sesion(conn))
    assert res.status_code == 201
    (_, _, args) = conn.sql_ejecutado("insert into puntos")[0]
    assert args == ("Nuevo", [])


async def test_crear_punto_con_alias_de_otro_punto_responde_409(cliente, pool, conn):
    conn.responder("fetch", "alias from puntos where activo", OTROS_PUNTOS)
    res = await cliente.post("/puntos", json={"nombre": "Nuevo", "alias": ["Principal"]}, headers=_sesion(conn))
    assert res.status_code == 409 and "BV — Bodega Ventas" in res.json()["detail"]
    assert conn.sql_ejecutado("insert into puntos") == []


# --------------------------- listado de administracion ---------------------------


async def test_listado_de_administracion_incluye_alias(cliente, pool, conn):
    conn.responder(
        "fetch",
        "from puntos order by activo",
        [
            {"id": uuid.UUID(PUNTO), "nombre": "BV — Bodega Ventas", "codigo": "BV", "activo": True,
             "es_interna": True, "alias": ["Principal"]},
            {"id": uuid.UUID(OTRO), "nombre": "CFC", "codigo": "CFC", "activo": True,
             "es_interna": False, "alias": None},
        ],
    )
    res = await cliente.get("/puntos", params={"incluir_inactivos": "true"}, headers=_sesion(conn))
    assert [p["alias"] for p in res.json()] == [["Principal"], []]
    (_, sql, _) = conn.sql_ejecutado("from puntos order by activo")[0]
    assert "alias" in sql


async def test_listado_publico_para_el_movil_no_incluye_alias(cliente, pool, conn):
    conn.responder("fetch", "from puntos where activo = true", [{"id": uuid.UUID(PUNTO), "nombre": "CFC", "codigo": "CFC"}])
    res = await cliente.get("/puntos")
    assert res.json() == [{"id": PUNTO, "nombre": "CFC", "codigo": "CFC"}]
