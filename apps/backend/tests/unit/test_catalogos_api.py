"""Catalogos administrables: /productos y /tipos-documento (router + servicio)."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from uuid import uuid4

import asyncpg
import pytest

from app.services import tipos_documento as servicio_tipos
from tests.fakes import violacion_unica
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

PRODUCTO = "66666666-6666-6666-6666-666666666666"
AHORA = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)


def sesion(conn, rol="admin", area="todo", usuario="ana") -> dict[str, str]:
    fila = fila_usuario_dashboard(rol=rol, area=area, usuario=usuario)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def fila_producto(**extra) -> dict:
    fila = {"id": uuid4(), "codigo": "12345", "nombre": "SAL", "creado_at": AHORA}
    fila.update(extra)
    return fila


@pytest.fixture(autouse=True)
def _cache_limpia():
    servicio_tipos.invalidar_cache()
    yield
    servicio_tipos.invalidar_cache()


# --------------------------------------------------------------------------
# GET /productos
# --------------------------------------------------------------------------


async def test_listar_productos_es_publico_ordenado_y_con_id_como_texto(cliente, pool, conn):
    conn.responder("fetch", "from productos", [fila_producto(), fila_producto(codigo="999")])
    res = await cliente.get("/productos")
    assert res.status_code == 200
    assert all(isinstance(p["id"], str) for p in res.json())
    sql = conn.llamadas[0][1]
    assert "order by codigo" in sql and "ilike" not in sql


async def test_buscar_usa_parametro_con_comodines_y_busca_en_codigo_y_nombre(cliente, pool, conn):
    conn.responder("fetch", "from productos", [])
    peligroso = "x'; drop table productos; --"
    res = await cliente.get("/productos", params={"buscar": peligroso})
    assert res.status_code == 200
    (_, sql, args) = conn.llamadas[0]
    assert "codigo ilike $1 or nombre ilike $1" in sql
    assert args == (f"%{peligroso}%",) and "drop table" not in sql


async def test_buscar_vacio_lista_todo(cliente, pool, conn):
    conn.responder("fetch", "from productos", [])
    await cliente.get("/productos", params={"buscar": ""})
    assert "ilike" not in conn.llamadas[0][1]


# --------------------------------------------------------------------------
# POST / PATCH / DELETE /productos
# --------------------------------------------------------------------------


async def test_crear_producto_devuelve_201_y_el_registro(cliente, pool, conn):
    conn.responder("fetchrow", "insert into productos", fila_producto(codigo="12345", nombre="SAL"))
    res = await cliente.post(
        "/productos", json={"codigo": "12345", "nombre": "SAL"}, headers=sesion(conn, "supervisor", "bodega")
    )
    assert res.status_code == 201
    assert res.json()["codigo"] == "12345"
    assert conn.sql_ejecutado("insert into productos")[0][2] == ("12345", "SAL")


async def test_crear_producto_repetido_da_409(cliente, pool, conn):
    conn.responder("fetchrow", "insert into productos", violacion_unica("productos_codigo_key"))
    res = await cliente.post("/productos", json={"codigo": "12345", "nombre": "SAL"}, headers=sesion(conn))
    assert res.status_code == 409 and "Ya existe un producto" in res.json()["detail"]


@pytest.mark.parametrize("cuerpo", [{}, {"codigo": "1"}, {"nombre": "SAL"}, {"codigo": None, "nombre": "SAL"}])
async def test_crear_producto_exige_codigo_y_nombre(cliente, pool, conn, cuerpo):
    res = await cliente.post("/productos", json=cuerpo, headers=sesion(conn))
    assert res.status_code == 422
    assert conn.sql_ejecutado("insert into productos") == []


async def test_actualizar_producto_recorta_y_solo_cambia_lo_enviado(cliente, pool, conn):
    conn.responder("fetchrow", "update productos", fila_producto(nombre="NUEVO"))
    res = await cliente.patch(f"/productos/{PRODUCTO}", json={"nombre": "  NUEVO  "}, headers=sesion(conn))
    assert res.status_code == 200
    (_, sql, args) = conn.sql_ejecutado("update productos")[0]
    assert "coalesce($2, codigo)" in sql and "coalesce($3, nombre)" in sql
    assert args == (PRODUCTO, None, "NUEVO")


@pytest.mark.parametrize(
    "cuerpo, detalle",
    [
        ({"codigo": ""}, "no pueden quedar vacíos"),
        ({"nombre": "   "}, "no pueden quedar vacíos"),
        ({"codigo": "1", "nombre": ""}, "no pueden quedar vacíos"),
        ({}, "No hay cambios"),
        ({"codigo": None, "nombre": None}, "No hay cambios"),
    ],
)
async def test_actualizar_producto_rechaza_vacios_y_peticiones_sin_cambios(cliente, pool, conn, cuerpo, detalle):
    res = await cliente.patch(f"/productos/{PRODUCTO}", json=cuerpo, headers=sesion(conn))
    assert res.status_code == 422 and detalle in res.json()["detail"]
    assert conn.sql_ejecutado("update productos") == []


async def test_actualizar_producto_inexistente_da_404_y_repetido_da_409(cliente, pool, conn):
    headers = sesion(conn)
    conn.responder("fetchrow", "update productos", None, violacion_unica("productos_codigo_key"))
    assert (await cliente.patch(f"/productos/{PRODUCTO}", json={"nombre": "X"}, headers=headers)).status_code == 404
    assert (await cliente.patch(f"/productos/{PRODUCTO}", json={"codigo": "9"}, headers=headers)).status_code == 409


@pytest.mark.parametrize("metodo", ["post", "patch", "delete"])
async def test_el_catalogo_exige_credenciales(cliente, pool, conn, metodo):
    ruta = "/productos" if metodo == "post" else f"/productos/{PRODUCTO}"
    res = await cliente.request(metodo.upper(), ruta, json={"codigo": "1", "nombre": "X"})
    assert res.status_code == 401 and conn.llamadas == []


# --------------------------------------------------------------------------
# GET /tipos-documento
# --------------------------------------------------------------------------


def fila_tipo(codigo="FEI", descripcion="factura", activo=True) -> dict:
    return {"codigo": codigo, "descripcion": descripcion, "activo": activo, "created_at": AHORA}


async def test_listar_tipos_publico_solo_activos(cliente, pool, conn):
    conn.responder("fetch", "from tipos_documento", [fila_tipo()])
    res = await cliente.get("/tipos-documento")
    assert res.status_code == 200 and res.json()[0]["codigo"] == "FEI"
    assert "where activo = true" in conn.llamadas[0][1]


async def test_listar_tipos_con_inactivos_exige_admin(cliente, pool, conn, admin_headers):
    conn.responder("fetch", "from tipos_documento", [])
    assert (await cliente.get("/tipos-documento", params={"incluir_inactivos": "true"})).status_code == 401
    assert conn.llamadas == []
    for rol in ("supervisor", "consulta"):
        res = await cliente.get(
            "/tipos-documento", params={"incluir_inactivos": "true"}, headers=sesion(conn, rol)
        )
        assert res.status_code == 403
    conn.llamadas.clear()
    ok = await cliente.get("/tipos-documento", params={"incluir_inactivos": "true"}, headers=admin_headers)
    assert ok.status_code == 200 and "where activo" not in conn.llamadas[0][1]


# --------------------------------------------------------------------------
# POST /tipos-documento
# --------------------------------------------------------------------------


async def test_crear_tipo_normaliza_el_codigo_deja_evento_e_invalida_la_cache(cliente, pool, conn, admin_headers):
    servicio_tipos._cache = (time.monotonic(), "viejo")
    conn.responder("fetchrow", "insert into tipos_documento", fila_tipo("ABC", "x"))
    res = await cliente.post("/tipos-documento", json={"codigo": " abc ", "descripcion": "  x  "}, headers=admin_headers)
    assert res.status_code == 201
    assert conn.sql_ejecutado("insert into tipos_documento")[0][2] == ("ABC", "x")
    assert servicio_tipos._cache is None
    (evento,) = conn.inserts_log()
    assert evento[:3] == ("admin_cambio", "tipo_documento", "ABC") and evento[5] == "creado"


@pytest.mark.parametrize("codigo", ["", "   ", "ABCDEFGHIJKLM", "FE-1", "F E", "FEI!"])
async def test_crear_tipo_rechaza_codigos_invalidos(cliente, pool, conn, admin_headers, codigo):
    res = await cliente.post("/tipos-documento", json={"codigo": codigo}, headers=admin_headers)
    assert res.status_code == 422 and conn.sql_ejecutado("insert into tipos_documento") == []


async def test_crear_tipo_acepta_el_largo_maximo_y_digitos(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "insert into tipos_documento", fila_tipo("AB1234567890"))
    res = await cliente.post("/tipos-documento", json={"codigo": "ab1234567890"}, headers=admin_headers)
    assert res.status_code == 201


async def test_crear_tipo_repetido_da_409_y_no_deja_evento(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "insert into tipos_documento", asyncpg.UniqueViolationError("dup"))
    res = await cliente.post("/tipos-documento", json={"codigo": "FEI"}, headers=admin_headers)
    assert res.status_code == 409 and "Ya existe" in res.json()["detail"]
    assert conn.inserts_log() == []


# --------------------------------------------------------------------------
# PATCH /tipos-documento/{codigo}
# --------------------------------------------------------------------------


async def test_actualizar_tipo_desactiva_deja_evento_e_invalida_la_cache(cliente, pool, conn, admin_headers):
    servicio_tipos._cache = (time.monotonic(), "viejo")
    conn.responder("fetchrow", "update tipos_documento", fila_tipo(activo=False))
    res = await cliente.patch("/tipos-documento/fei", json={"activo": False}, headers=admin_headers)
    assert res.status_code == 200 and res.json()["activo"] is False
    (_, sql, args) = conn.sql_ejecutado("update tipos_documento")[0]
    assert "activo = $2" in sql and args == ("FEI", False)
    assert servicio_tipos._cache is None
    assert conn.inserts_log()[0][5] == "actualizado"


async def test_actualizar_tipo_sin_cambios_devuelve_la_fila_sin_evento_ni_cache(cliente, pool, conn, admin_headers):
    servicio_tipos._cache = (time.monotonic(), "viejo")
    conn.responder("fetchrow", "select * from tipos_documento", fila_tipo())
    res = await cliente.patch("/tipos-documento/FEI", json={}, headers=admin_headers)
    assert res.status_code == 200
    assert conn.inserts_log() == [] and servicio_tipos._cache is not None


async def test_actualizar_tipo_inexistente_da_404_y_codigo_invalido_da_422(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "update tipos_documento", None)
    assert (await cliente.patch("/tipos-documento/ZZZ", json={"activo": True}, headers=admin_headers)).status_code == 404
    assert (await cliente.patch("/tipos-documento/F-1", json={"activo": True}, headers=admin_headers)).status_code == 422


# --------------------------------------------------------------------------
# Frase de ejemplos del prompt de vision
# --------------------------------------------------------------------------


def filas(*pares) -> list[dict]:
    return [{"codigo": c, "descripcion": d} for c, d in pares]


def test_la_frase_agrupa_codigos_con_la_misma_descripcion_en_orden_de_aparicion():
    frase = servicio_tipos._armar_frase(filas(("FEI", "factura"), ("TB9", "traslado"), ("FV1", "factura"), ("EDP", "")))
    assert frase == "FEI o FV1 (factura), TB9 (traslado), o EDP"


def test_la_frase_con_un_solo_grupo_no_lleva_coma_final():
    assert servicio_tipos._armar_frase(filas(("FEI", "factura"), ("FV1", "factura"))) == "FEI o FV1 (factura)"


def test_la_frase_con_dos_grupos():
    assert servicio_tipos._armar_frase(filas(("FEI", "factura"), ("RM3", "remision"))) == "FEI (factura), o RM3 (remision)"


def test_descripcion_en_blanco_cuenta_como_sin_descripcion():
    assert servicio_tipos._armar_frase(filas(("A", None), ("B", "   "))) == "A o B"


async def test_frase_ejemplos_se_cachea_y_expira_a_los_60_segundos(pool, conn, monkeypatch):
    ahora = {"t": 1000.0}
    monkeypatch.setattr(servicio_tipos.time, "monotonic", lambda: ahora["t"])
    conn.responder("fetch", "from tipos_documento", filas(("FEI", "factura")), filas(("FEI", "factura"), ("EDP", "")))

    assert await servicio_tipos.frase_ejemplos() == "FEI (factura)"
    ahora["t"] += 59
    assert await servicio_tipos.frase_ejemplos() == "FEI (factura)"
    assert len(conn.llamadas) == 1  # sigue en cache
    ahora["t"] += 2
    assert await servicio_tipos.frase_ejemplos() == "FEI (factura), o EDP"
    assert len(conn.llamadas) == 2


async def test_frase_ejemplos_sin_tipos_activos_usa_la_lista_de_respaldo(pool, conn):
    conn.responder("fetch", "from tipos_documento", [])
    assert await servicio_tipos.frase_ejemplos() == servicio_tipos._FRASE_RESPALDO


async def test_frase_ejemplos_si_la_base_falla_no_tumba_la_extraccion(pool, conn):
    conn.responder("fetch", "from tipos_documento", RuntimeError("base caida"))
    assert await servicio_tipos.frase_ejemplos() == servicio_tipos._FRASE_RESPALDO


async def test_frase_ejemplos_solo_lee_tipos_activos(pool, conn):
    conn.responder("fetch", "from tipos_documento", filas(("FEI", "factura")))
    await servicio_tipos.frase_ejemplos()
    assert "where activo = true" in conn.llamadas[0][1]


# --------------------------------------------------------------------------
# Regresion: un id de producto que no es uuid no debe llegar a la base
# --------------------------------------------------------------------------


@pytest.mark.parametrize("metodo", ["patch", "delete"])
@pytest.mark.parametrize("id_", ["no-es-uuid", "123", "11111111-1111-1111-1111-11111111111", "x' or '1'='1"])
async def test_producto_con_id_invalido_da_422_sin_tocar_la_base(cliente, pool, conn, metodo, id_):
    """Antes el id viajaba como texto al cast `$1::uuid` y asyncpg lanzaba
    DataError: HTTP 500 en vez de un error de validacion."""
    res = await cliente.request(metodo.upper(), f"/productos/{id_}", json={"nombre": "X"}, headers=sesion(conn))
    assert res.status_code == 422
    assert conn.sql_ejecutado("productos") == []


async def test_producto_con_id_invalido_sin_credenciales_sigue_dando_401(cliente, pool, conn):
    assert (await cliente.delete("/productos/no-es-uuid")).status_code == 401
