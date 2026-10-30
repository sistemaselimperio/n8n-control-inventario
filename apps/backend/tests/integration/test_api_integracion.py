"""Flujos HTTP completos contra Postgres real (la IA sigue simulada)."""

import pytest

from app.services.auth_pin import generar_sal, hashear_password, hashear_pin
from tests import respuestas_vision as r
from tests.helpers import payload_entrega
from tests.integration.conftest import eventos_en_logs

pytestmark = pytest.mark.integration

DOCUMENTO = {**r.ALTA_CONFIANZA, "tipo": "XYZ", "indicativo_numero": "10254"}


async def test_flujo_completo_nueva_actualizable_confirmacion_y_duplicado(cliente, pg, vision):
    vision.responder(DOCUMENTO)

    nueva = await cliente.post("/entregas/procesar", json=payload_entrega(hash_evidencia="h1"))
    assert nueva.status_code == 201
    entrega_id = nueva.json()["id"]
    item_id = nueva.json()["items"][0]["id"]

    otra_sede = await cliente.post(
        "/entregas/procesar", json=payload_entrega(hash_evidencia="h2", sede_origen_id="sede-2")
    )
    assert otra_sede.status_code == 200
    assert (otra_sede.json()["situacion"], otra_sede.json()["id"]) == ("actualizable", entrega_id)

    confirmar = await cliente.patch(
        f"/entregas/{entrega_id}/items",
        json={"items": [{"id": item_id, "entregado_hoy": 3}], "operador_id": "op1", "sede_id": "sede-2"},
    )
    assert confirmar.status_code == 200
    assert confirmar.json()["items"][0]["cantidad_pendiente"] == 0

    duplicada = await cliente.post("/entregas/procesar", json=payload_entrega(hash_evidencia="h3"))
    assert duplicada.status_code == 409

    # Bitacora: cada paso deja su evento, en orden, y nada se reescribe.
    assert await eventos_en_logs(pg) == [
        "foto_capturada", "extraccion_ia", "chequeo_duplicado", "entrega_insertada", "validacion", "sync_tiempo_real",
        "foto_capturada", "extraccion_ia", "chequeo_duplicado", "validacion", "sync_tiempo_real",
        "entrega_actualizada",
        "foto_capturada", "extraccion_ia", "chequeo_duplicado", "duplicado_bloqueado",
    ]
    assert await pg.fetchval("select count(*) from entregas") == 1


async def test_confirmar_mas_de_lo_pendiente_responde_422_y_no_cambia_nada(cliente, pg, vision):
    vision.responder(DOCUMENTO)
    nueva = (await cliente.post("/entregas/procesar", json=payload_entrega())).json()
    res = await cliente.patch(
        f"/entregas/{nueva['id']}/items",
        json={"items": [{"id": nueva["items"][0]["id"], "entregado_hoy": 99}], "operador_id": "op", "sede_id": "s"},
    )
    assert res.status_code == 422
    assert await pg.fetchval("select cantidad_pendiente from entrega_items") == 3


async def test_login_con_pin_contra_la_base(cliente, pg):
    sal = generar_sal()
    empleado_id = str(
        await pg.fetchval(
            "insert into empleados (nombre, sede_id, pin_hash, pin_salt) values ('Ana', 'sede-1', $1, $2) returning id",
            hashear_pin("4321", sal), sal,
        )
    )
    ok = await cliente.post("/auth/pin", json={"pin": "4321", "empleado_id": empleado_id})
    assert ok.status_code == 200 and ok.json()["nombre"] == "Ana"
    mal = await cliente.post("/auth/pin", json={"pin": "1111", "empleado_id": empleado_id})
    assert mal.status_code == 401

    await pg.execute("update empleados set estado = 'inactivo' where id = $1::uuid", empleado_id)
    inactivo = await cliente.post("/auth/pin", json={"pin": "4321", "empleado_id": empleado_id})
    assert inactivo.status_code == 401


async def crear_usuario_dashboard(pg, password="clave-segura-1", rol="admin") -> str:
    sal = generar_sal()
    return str(
        await pg.fetchval(
            "insert into usuarios_dashboard (usuario, nombre, rol, pass_hash, pass_salt)"
            " values ('ana', 'Ana', $1, $2, $3) returning id",
            rol, hashear_password(password, sal), sal,
        )
    )


async def test_login_del_dashboard_y_sesion_bearer(cliente, pg):
    await crear_usuario_dashboard(pg)
    login = await cliente.post("/dashboard/auth/login", json={"usuario": "ANA", "password": "clave-segura-1"})
    assert login.status_code == 200
    cabecera = {"Authorization": f"Bearer {login.json()['token']}"}

    assert (await cliente.get("/dashboard/auth/yo", headers=cabecera)).json()["usuario"] == "ana"

    # La baja rige al instante, aunque el token siga vigente.
    await pg.execute("update usuarios_dashboard set activo = false")
    assert (await cliente.get("/dashboard/auth/yo", headers=cabecera)).status_code == 401


async def test_cinco_intentos_fallidos_bloquean_la_cuenta(cliente, pg):
    await crear_usuario_dashboard(pg)
    for _ in range(5):
        res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "mala-clave"})
        assert res.status_code == 401
    bloqueada = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "clave-segura-1"})
    assert bloqueada.status_code == 423
    resultados = [
        f["resultado"]
        for f in await pg.fetch("select resultado from logs where evento = 'dashboard_login' order by \"timestamp\"")
    ]
    assert resultados == ["fallido"] * 4 + ["bloqueado", "bloqueado"]


async def test_vaciar_todo_exige_token_y_deja_solo_su_propia_constancia(cliente, pg, vision, admin_headers):
    vision.responder(DOCUMENTO)
    await cliente.post("/entregas/procesar", json=payload_entrega())

    sin_token = await cliente.delete("/entregas/todas")
    assert sin_token.status_code == 401
    assert await pg.fetchval("select count(*) from entregas") == 1

    res = await cliente.delete("/entregas/todas", headers=admin_headers)
    assert res.status_code == 200 and res.json()["entregas_borradas"] == 1
    assert await pg.fetchval("select count(*) from entregas") == 0
    assert await eventos_en_logs(pg) == ["limpieza_total"]
