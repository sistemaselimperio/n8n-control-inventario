"""Autenticacion por PIN: hashing PBKDF2, validacion de formato y POST /auth/pin."""

import pytest
from pydantic import ValidationError

from app.models.empleado import EmpleadoCreate, PinLogin, PinNuevo
from app.services.auth_pin import (
    generar_sal,
    hashear_password,
    hashear_pin,
    verificar_password,
    verificar_pin,
)

EMPLEADO = "33333333-3333-3333-3333-333333333333"


# --------------------------------------------------------------------------
# Hash
# --------------------------------------------------------------------------


def test_el_hash_es_pbkdf2_sha256_determinista_por_sal():
    import hashlib

    sal = "sal-fija"
    esperado = hashlib.pbkdf2_hmac("sha256", b"1234", sal.encode(), 200_000).hex()
    assert hashear_pin("1234", sal) == esperado
    assert hashear_pin("1234", sal) == hashear_pin("1234", sal)


def test_el_hash_no_contiene_el_pin_en_claro():
    assert "1234" not in hashear_pin("1234", "sal")


def test_sal_distinta_da_hash_distinto():
    assert hashear_pin("1234", "a") != hashear_pin("1234", "b")


def test_las_sales_generadas_son_unicas_y_hex():
    sales = {generar_sal() for _ in range(20)}
    assert len(sales) == 20
    assert all(len(s) == 32 and int(s, 16) >= 0 for s in sales)


def test_verificar_pin_correcto_e_incorrecto():
    sal = generar_sal()
    guardado = hashear_pin("4321", sal)
    assert verificar_pin("4321", sal, guardado) is True
    assert verificar_pin("4322", sal, guardado) is False
    assert verificar_pin("4321", generar_sal(), guardado) is False
    assert verificar_pin("", sal, guardado) is False


def test_contrasenas_del_dashboard_usan_la_misma_derivacion():
    sal = generar_sal()
    assert hashear_password("clave larga", sal) == hashear_pin("clave larga", sal)
    assert verificar_password("clave larga", sal, hashear_password("clave larga", sal)) is True
    assert verificar_password("otra", sal, hashear_password("clave larga", sal)) is False


# --------------------------------------------------------------------------
# Formato del PIN (4 a 6 digitos)
# --------------------------------------------------------------------------


@pytest.mark.parametrize("pin", ["1234", "12345", "123456", "0000", "000000"])
def test_pin_valido(pin):
    assert PinLogin(pin=pin, empleado_id=EMPLEADO).pin == pin
    assert PinNuevo(pin=pin).pin == pin
    assert EmpleadoCreate(nombre="Ana", sede_id="s", pin=pin).pin == pin


@pytest.mark.parametrize("pin", ["", "1", "123", "1234567", "12a4", "abcd", "12 34", " 1234", "1234 ", "-123", "1.23", "12\n34"])
def test_pin_invalido(pin):
    with pytest.raises(ValidationError, match="entre 4 y 6 digitos"):
        PinLogin(pin=pin, empleado_id=EMPLEADO)
    with pytest.raises(ValidationError):
        PinNuevo(pin=pin)
    with pytest.raises(ValidationError):
        EmpleadoCreate(nombre="Ana", sede_id="s", pin=pin)


# --------------------------------------------------------------------------
# POST /auth/pin
# --------------------------------------------------------------------------


def empleado(pin="1234", **extra):
    sal = generar_sal()
    fila = {
        "id": EMPLEADO,
        "nombre": "Ana Bodega",
        "sede_id": "sede-1",
        "rol": "operador",
        "estado": "activo",
        "pin_salt": sal,
        "pin_hash": hashear_pin(pin, sal),
    }
    fila.update(extra)
    return fila


async def test_login_con_pin_correcto(cliente, pool, conn):
    conn.responder("fetchrow", "from empleados", empleado("1234"))
    res = await cliente.post("/auth/pin", json={"pin": "1234", "empleado_id": EMPLEADO})
    assert res.status_code == 200
    assert res.json() == {"id": EMPLEADO, "nombre": "Ana Bodega", "sede_id": "sede-1", "rol": "operador"}
    # Nunca se devuelve nada del hash.
    assert "pin_hash" not in res.text and "pin_salt" not in res.text


async def test_login_con_pin_incorrecto(cliente, pool, conn):
    conn.responder("fetchrow", "from empleados", empleado("1234"))
    res = await cliente.post("/auth/pin", json={"pin": "9999", "empleado_id": EMPLEADO})
    assert res.status_code == 401
    assert res.json()["detail"] == "PIN incorrecto"


async def test_login_de_empleado_inexistente_o_inactivo_da_el_mismo_401(cliente, pool, conn):
    conn.responder("fetchrow", "from empleados", None)  # el select ya filtra activo y con pin
    res = await cliente.post("/auth/pin", json={"pin": "1234", "empleado_id": EMPLEADO})
    assert res.status_code == 401
    assert res.json()["detail"] == "PIN incorrecto"
    _, sql, _ = conn.llamadas[0]
    assert "estado = 'activo'" in sql and "pin_hash is not null" in sql


@pytest.mark.parametrize("pin", ["12", "1234567", "abcd", ""])
async def test_login_con_formato_invalido_da_422_sin_consultar(cliente, pool, conn, pin):
    res = await cliente.post("/auth/pin", json={"pin": pin, "empleado_id": EMPLEADO})
    assert res.status_code == 422
    assert conn.llamadas == []
