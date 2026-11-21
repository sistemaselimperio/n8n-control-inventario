"""Punto y cedula de los usuarios del dashboard (modulo de traslados): modelos,
sesion/login y alta/edicion desde /creador. La base se simula con FakeConn."""

import pytest
from pydantic import ValidationError

from app.models.usuario_dashboard import UsuarioDashboardActualizar, UsuarioDashboardCrear
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

PUNTO = "22222222-2222-2222-2222-222222222222"
OTRO_PUNTO = "33333333-3333-3333-3333-333333333333"


def _sesion_admin(conn) -> dict:
    fila = fila_usuario_dashboard(rol="admin")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def _crear(**extra) -> dict:
    cuerpo = {"usuario": "luisa", "nombre": "Luisa", "rol": "supervisor", "area": "traslados", "password": "12345678"}
    cuerpo.update(extra)
    return cuerpo


# --------------------------- modelos ---------------------------


def test_cedula_se_normaliza_sin_puntos_ni_espacios():
    u = UsuarioDashboardCrear(**_crear(cedula=" 1.234.567 "))
    assert u.cedula == "1234567"


@pytest.mark.parametrize("cedula", ["abc", "12", "1" * 21, "12 34a"])
def test_cedula_invalida_se_rechaza(cedula):
    with pytest.raises(ValidationError):
        UsuarioDashboardCrear(**_crear(cedula=cedula))


def test_cedula_vacia_cuenta_como_sin_cedula():
    assert UsuarioDashboardCrear(**_crear(cedula="  ")).cedula is None


def test_punto_id_debe_ser_uuid():
    assert UsuarioDashboardCrear(**_crear(punto_id=PUNTO)).punto_id == PUNTO
    with pytest.raises(ValidationError):
        UsuarioDashboardCrear(**_crear(punto_id="no-es-uuid"))


def test_actualizar_distingue_no_enviado_de_null_explicito():
    sin = UsuarioDashboardActualizar()
    assert "punto_id" not in sin.model_fields_set
    con_null = UsuarioDashboardActualizar(punto_id=None, cedula=None)
    assert {"punto_id", "cedula"} <= con_null.model_fields_set


# --------------------------- sesion y login ---------------------------


async def test_login_devuelve_punto_y_cedula(cliente, pool, conn):
    fila = fila_usuario_dashboard("clave-segura-1", rol="supervisor", area="traslados", punto_id=PUNTO, cedula="1234567")
    conn.responder("fetchrow", "from usuarios_dashboard where usuario", fila)
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "clave-segura-1"})
    assert res.json()["usuario"]["punto_id"] == PUNTO
    assert res.json()["usuario"]["cedula"] == "1234567"


async def test_yo_devuelve_punto_y_cedula_leidos_de_la_base(cliente, pool, conn):
    fila = fila_usuario_dashboard(rol="supervisor", area="traslados", punto_id=PUNTO, cedula="1234567")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.get("/dashboard/auth/yo", headers=encabezado_bearer(fila))
    assert res.json()["punto_id"] == PUNTO and res.json()["cedula"] == "1234567"
    sql = conn.llamadas[0][1]
    assert "punto_id" in sql and "cedula" in sql


async def test_yo_sin_punto_ni_cedula_los_devuelve_null(cliente, pool, conn):
    fila = fila_usuario_dashboard(rol="supervisor", area="traslados")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.get("/dashboard/auth/yo", headers=encabezado_bearer(fila))
    assert res.json()["punto_id"] is None and res.json()["cedula"] is None


# --------------------------- alta desde /creador ---------------------------


async def test_crear_guarda_punto_y_cedula(cliente, pool, conn):
    headers = _sesion_admin(conn)
    creada = fila_usuario_dashboard(
        usuario="luisa", rol="supervisor", area="traslados", punto_id=PUNTO, cedula="1234567"
    )
    conn.responder("fetchrow", "insert into usuarios_dashboard", creada)
    res = await cliente.post(
        "/dashboard/usuarios", json=_crear(punto_id=PUNTO, cedula="1.234.567"), headers=headers
    )
    assert res.status_code == 201
    assert res.json()["punto_id"] == PUNTO and res.json()["cedula"] == "1234567"
    (_, sql, args) = conn.sql_ejecutado("insert into usuarios_dashboard")[0]
    assert "punto_id" in sql and "cedula" in sql
    assert PUNTO in args and "1234567" in args


async def test_crear_con_punto_exige_area_traslados(cliente, pool, conn):
    headers = _sesion_admin(conn)
    res = await cliente.post("/dashboard/usuarios", json=_crear(area="bodega", punto_id=PUNTO), headers=headers)
    assert res.status_code == 422
    assert conn.sql_ejecutado("insert into usuarios_dashboard") == []


async def test_crear_admin_con_punto_se_rechaza(cliente, pool, conn):
    headers = _sesion_admin(conn)
    res = await cliente.post("/dashboard/usuarios", json=_crear(rol="admin", punto_id=PUNTO), headers=headers)
    assert res.status_code == 422


async def test_crear_con_punto_inexistente_responde_422(cliente, pool, conn):
    import asyncpg

    headers = _sesion_admin(conn)
    conn.responder("fetchrow", "insert into usuarios_dashboard", asyncpg.ForeignKeyViolationError("fk"))
    res = await cliente.post("/dashboard/usuarios", json=_crear(punto_id=PUNTO), headers=headers)
    assert res.status_code == 422


# --------------------------- edicion ---------------------------


def _actual(**extra) -> dict:
    fila = fila_usuario_dashboard(usuario="luisa", rol="supervisor", area="traslados", punto_id=PUNTO, cedula="1234567")
    fila.update(extra)
    return fila


async def _patch(cliente, conn, actual, cambios, devuelto=None):
    # Las reglas del FakeConn se evaluan en orden y por fragmento: las especificas
    # (con "for update") van antes que la de la sesion, que es un prefijo de ellas.
    conn.responder("fetch", "from usuarios_dashboard where rol = 'admin'", [{"id": "otro-admin"}, {"id": "otro2"}])
    conn.responder("fetchrow", "from usuarios_dashboard where id = $1::uuid for update", actual)
    conn.responder("fetchrow", "update usuarios_dashboard set", devuelto or {**actual, **cambios})
    headers = _sesion_admin(conn)
    return await cliente.patch(f"/dashboard/usuarios/{actual['id']}", json=cambios, headers=headers)


async def test_editar_cedula(cliente, pool, conn):
    res = await _patch(cliente, conn, _actual(), {"cedula": "7654321"})
    assert res.status_code == 200 and res.json()["cedula"] == "7654321"
    (_, sql, args) = conn.sql_ejecutado("update usuarios_dashboard set")[0]
    assert "cedula = " in sql and "7654321" in args


async def test_null_explicito_quita_el_punto(cliente, pool, conn):
    res = await _patch(cliente, conn, _actual(), {"punto_id": None}, {**_actual(), "punto_id": None})
    assert res.status_code == 200
    (_, sql, args) = conn.sql_ejecutado("update usuarios_dashboard set")[0]
    assert "punto_id = " in sql and None in args[1:]


async def test_cambiar_el_area_fuera_de_traslados_quita_el_punto(cliente, pool, conn):
    res = await _patch(cliente, conn, _actual(), {"area": "bodega"}, {**_actual(), "area": "bodega", "punto_id": None})
    assert res.status_code == 200
    (_, sql, args) = conn.sql_ejecutado("update usuarios_dashboard set")[0]
    assert "punto_id = " in sql and None in args[1:]


async def test_asignar_punto_a_usuario_de_otra_area_responde_422(cliente, pool, conn):
    actual = _actual(area="bodega", punto_id=None)
    res = await _patch(cliente, conn, actual, {"punto_id": OTRO_PUNTO})
    assert res.status_code == 422
    assert conn.sql_ejecutado("update usuarios_dashboard set") == []


async def test_listado_de_usuarios_trae_punto_y_cedula(cliente, pool, conn):
    headers = _sesion_admin(conn)
    conn.responder("fetch", "from usuarios_dashboard order by", [_actual()])
    res = await cliente.get("/dashboard/usuarios", headers=headers)
    (usuario,) = res.json()
    assert usuario["punto_id"] == PUNTO and usuario["cedula"] == "1234567"
    assert "pass_hash" not in usuario and "pass_salt" not in usuario
