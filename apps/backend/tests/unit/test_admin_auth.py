"""Guardia de administracion: X-Admin-Token (legacy) y sesion Bearer del dashboard."""

import time

import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.services import sesion_dashboard as sesion
from app.services.admin_auth import verificar_token_admin
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

ENTREGA = "44444444-4444-4444-4444-444444444444"
TOKEN = "token-admin-de-prueba"


# --------------------------------------------------------------------------
# verificar_token_admin
# --------------------------------------------------------------------------


def test_token_correcto_pasa():
    assert verificar_token_admin(TOKEN) is None


@pytest.mark.parametrize("enviado", [None, "", "otro", TOKEN + "x", TOKEN.upper(), " " + TOKEN])
def test_token_ausente_o_incorrecto_da_401(enviado):
    with pytest.raises(HTTPException) as info:
        verificar_token_admin(enviado)
    assert info.value.status_code == 401


def test_sin_token_configurado_falla_cerrado_con_503(monkeypatch):
    monkeypatch.delenv("ADMIN_DELETE_TOKEN")
    get_settings.cache_clear()
    with pytest.raises(HTTPException) as info:
        verificar_token_admin(TOKEN)
    assert info.value.status_code == 503
    # Tampoco acepta "ningun token" como valido.
    with pytest.raises(HTTPException) as info:
        verificar_token_admin(None)
    assert info.value.status_code == 503


def test_token_con_caracteres_no_ascii_no_revienta():
    with pytest.raises(HTTPException) as info:
        verificar_token_admin("clave-ñandú")
    assert info.value.status_code == 401


# --------------------------------------------------------------------------
# Endpoints protegidos por token
# --------------------------------------------------------------------------

SEDE = {"nombre": "Sede Norte", "codigo": "SEDE-09"}
EMPLEADO_NUEVO = {"nombre": "Luis", "sede_id": "sede-1", "rol": "operador", "pin": "1234"}

PROTEGIDOS = [
    ("DELETE", "/entregas/todas", None),
    ("DELETE", f"/entregas/{ENTREGA}/definitivo", None),
    ("POST", "/sedes", SEDE),
    ("POST", "/empleados", EMPLEADO_NUEVO),
    ("GET", "/sedes?incluir_inactivas=true", None),
    ("GET", "/empleados?incluir_inactivos=true", None),
]


@pytest.mark.parametrize("metodo, ruta, cuerpo", PROTEGIDOS)
async def test_sin_credenciales_da_401_y_no_toca_la_base(cliente, pool, conn, metodo, ruta, cuerpo):
    res = await cliente.request(metodo, ruta, json=cuerpo)
    assert res.status_code == 401
    assert conn.llamadas == []


@pytest.mark.parametrize("metodo, ruta, cuerpo", PROTEGIDOS)
async def test_token_incorrecto_da_401_y_no_toca_la_base(cliente, pool, conn, metodo, ruta, cuerpo):
    res = await cliente.request(metodo, ruta, json=cuerpo, headers={"X-Admin-Token": "equivocado"})
    assert res.status_code == 401
    assert conn.llamadas == []


@pytest.mark.parametrize("metodo, ruta, cuerpo", PROTEGIDOS)
async def test_sin_token_configurado_el_endpoint_queda_cerrado(cliente, pool, conn, monkeypatch, metodo, ruta, cuerpo):
    monkeypatch.delenv("ADMIN_DELETE_TOKEN")
    get_settings.cache_clear()
    res = await cliente.request(metodo, ruta, json=cuerpo, headers={"X-Admin-Token": TOKEN})
    assert res.status_code == 503
    assert conn.llamadas == []


async def test_vaciar_todo_con_token_correcto_borra_y_deja_constancia(cliente, pool, conn, admin_headers):
    conn.responder("fetchval", "select count(*) from entregas", 7)
    conn.responder("fetchval", "select count(*) from logs", 40)
    res = await cliente.delete("/entregas/todas", headers=admin_headers)
    assert res.status_code == 200
    assert res.json() == {"entregas_borradas": 7, "logs_borrados": 40}
    # El evento de auditoria se escribe DESPUES de vaciar logs.
    ejecutados = [c[1] for c in conn.llamadas if c[0] == "execute"]
    assert ejecutados.index("delete from logs") < next(i for i, s in enumerate(ejecutados) if "insert into logs" in s)
    assert conn.eventos_log() == ["limpieza_total"]


async def test_borrado_definitivo_de_entrega_inexistente_da_404(cliente, pool, conn, admin_headers):
    res = await cliente.delete(f"/entregas/{ENTREGA}/definitivo", headers=admin_headers)
    assert res.status_code == 404
    assert conn.sql_ejecutado("delete from entregas") == []


async def test_borrado_definitivo_con_token_correcto(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "select * from entregas", {"estado": "procesada", "sede_origen_id": "s1", "tipo": "FEI", "indicativo_numero": "1"})
    conn.responder("fetchval", "select exists", False)
    res = await cliente.delete(f"/entregas/{ENTREGA}/definitivo", params={"actor_id": "erika"}, headers=admin_headers)
    assert res.status_code == 200 and res.json() == {"eliminado": True}
    assert conn.sql_ejecutado("delete from entregas")
    evento = conn.inserts_log()[0]
    assert evento[0] == "entrega_eliminada"
    assert evento[3] == "erika"  # con el token legacy se respeta el actor que manda el dashboard
    assert evento[6]["estaba_completa"] is True


async def test_crear_sede_con_token_correcto(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "insert into sedes", {"id": "55555555-5555-5555-5555-555555555555", **SEDE})
    res = await cliente.post("/sedes", json=SEDE, headers=admin_headers)
    assert res.status_code == 201
    assert res.json() == {"id": "55555555-5555-5555-5555-555555555555"}
    assert conn.inserts_log()[0][5] == "creado"
    assert conn.inserts_log()[0][3] == "dashboard:token"


async def test_crear_empleado_no_guarda_ni_loguea_el_pin(cliente, pool, conn, admin_headers):
    conn.responder("fetchval", "select exists", True)
    conn.responder("fetchrow", "insert into empleados", {"id": "66666666-6666-6666-6666-666666666666", "nombre": "Luis"})
    res = await cliente.post("/empleados", json=EMPLEADO_NUEVO, headers=admin_headers)
    assert res.status_code == 201
    _, _, args = conn.sql_ejecutado("insert into empleados")[0]
    assert "1234" not in args  # solo viaja el hash
    assert "1234" not in str(conn.inserts_log())
    assert "pin_hash" not in res.text and "pin_salt" not in res.text


async def test_crear_empleado_valida_el_pin_y_la_sede(cliente, pool, conn, admin_headers):
    res = await cliente.post("/empleados", json={**EMPLEADO_NUEVO, "pin": "12"}, headers=admin_headers)
    assert res.status_code == 422
    conn.responder("fetchval", "select exists", False)
    res = await cliente.post("/empleados", json=EMPLEADO_NUEVO, headers=admin_headers)
    assert res.status_code == 400


async def test_listado_publico_solo_trae_activos_y_el_completo_exige_credencial(cliente, pool, conn, admin_headers):
    conn.responder("fetch", "from empleados", [])
    publico = await cliente.get("/empleados")
    assert publico.status_code == 200
    assert "estado = 'activo'" in conn.llamadas[-1][1]

    completo = await cliente.get("/empleados", params={"incluir_inactivos": "true"}, headers=admin_headers)
    assert completo.status_code == 200
    assert "estado = 'activo'" not in conn.llamadas[-1][1]


async def test_listado_de_sedes_publico_solo_activas(cliente, pool, conn, admin_headers):
    conn.responder("fetch", "from sedes", [])
    assert (await cliente.get("/sedes")).status_code == 200
    assert "where activa = true" in conn.llamadas[-1][1]
    todas = await cliente.get("/sedes", params={"incluir_inactivas": "true"}, headers=admin_headers)
    assert todas.status_code == 200
    assert "where activa = true" not in conn.llamadas[-1][1]


# --------------------------------------------------------------------------
# Tokens de sesion
# --------------------------------------------------------------------------


def test_token_de_sesion_ida_y_vuelta():
    token, exp = sesion.crear_token("usuario-1", "secreto", ahora=1_000)
    assert exp == 1_000 + sesion.TTL_SEGUNDOS == 1_000 + 8 * 3600
    assert sesion.verificar(token, "secreto", ahora=1_001)["sub"] == "usuario-1"


def test_token_vencido_se_rechaza_justo_en_el_limite():
    token, exp = sesion.crear_token("u", "s", ahora=1_000)
    assert sesion.verificar(token, "s", ahora=exp - 1) is not None
    assert sesion.verificar(token, "s", ahora=exp) is None


@pytest.mark.parametrize("alterar", ["payload", "firma", "secreto"])
def test_token_alterado_o_con_otro_secreto_se_rechaza(alterar):
    token, _ = sesion.crear_token("u", "s", ahora=time.time())
    carga, firma = token.split(".")
    if alterar == "payload":
        falso = sesion._b64(b'{"sub":"admin","exp":99999999999}')
        token = f"{falso}.{firma}"
    elif alterar == "firma":
        token = f"{carga}.{firma[:-2]}AA"
    assert sesion.verificar(token, "otro" if alterar == "secreto" else "s") is None


@pytest.mark.parametrize("basura", ["", "abc", "a.b.c", "....", "!!!.???", "e30.e30", "ñ.ñ"])
def test_token_con_formato_roto_nunca_lanza(basura):
    assert sesion.verificar(basura, "s") is None


def test_payload_sin_sub_o_sin_exp_valido_se_rechaza():
    for payload in ({"exp": 9e12}, {"sub": 5, "exp": 9e12}, {"sub": "u"}, {"sub": "u", "exp": "x"}):
        assert sesion.verificar(sesion.firmar(payload, "s"), "s", ahora=1) is None


def test_secreto_explicito_tiene_prioridad_y_si_no_se_deriva_del_token_admin(monkeypatch):
    assert sesion.obtener_secreto() == "secreto-de-sesion-de-prueba"

    monkeypatch.delenv("DASHBOARD_SESSION_SECRET")
    get_settings.cache_clear()
    derivado = sesion.obtener_secreto()
    assert derivado and derivado != TOKEN  # no es el mismo valor del header

    monkeypatch.delenv("ADMIN_DELETE_TOKEN")
    get_settings.cache_clear()
    with pytest.raises(HTTPException) as info:
        sesion.obtener_secreto()
    assert info.value.status_code == 503


# --------------------------------------------------------------------------
# POST /dashboard/auth/login
# --------------------------------------------------------------------------


async def test_login_correcto_devuelve_token_usable(cliente, pool, conn):
    fila = fila_usuario_dashboard("clave-segura-1")
    conn.responder("fetchrow", "from usuarios_dashboard where usuario", fila)
    res = await cliente.post("/dashboard/auth/login", json={"usuario": " ANA ", "password": "clave-segura-1"})
    assert res.status_code == 200
    cuerpo = res.json()
    assert cuerpo["usuario"] == {"id": fila["id"], "usuario": "ana", "nombre": "Ana Prueba", "rol": "admin", "area": "todo"}
    assert sesion.verificar(cuerpo["token"], sesion.obtener_secreto())["sub"] == fila["id"]
    # Consulta normalizada y resultado registrado sin contrasena.
    assert conn.llamadas[0][2] == ("ana",)
    assert conn.inserts_log()[0][5] == "ok"
    assert "clave-segura-1" not in str(conn.llamadas)


async def test_login_con_contrasena_incorrecta_cuenta_el_intento(cliente, pool, conn):
    conn.responder("fetchrow", "from usuarios_dashboard where usuario", fila_usuario_dashboard("clave-segura-1"))
    conn.responder("fetchval", "update usuarios_dashboard", False)
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "mala"})
    assert res.status_code == 401
    assert res.json()["detail"] == "Usuario o contraseña incorrectos"
    assert conn.sql_ejecutado("intentos_fallidos")
    assert conn.inserts_log()[0][5] == "fallido"


async def test_login_que_agota_los_intentos_queda_registrado_como_bloqueado(cliente, pool, conn):
    conn.responder("fetchrow", "from usuarios_dashboard where usuario", fila_usuario_dashboard("clave-segura-1"))
    conn.responder("fetchval", "update usuarios_dashboard", True)
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "mala"})
    assert res.status_code == 401
    assert conn.inserts_log()[0][5] == "bloqueado"


async def test_login_de_usuario_inexistente_da_la_misma_respuesta(cliente, pool, conn):
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "nadie", "password": "lo-que-sea"})
    assert res.status_code == 401
    assert res.json()["detail"] == "Usuario o contraseña incorrectos"
    assert conn.inserts_log()[0][5] == "fallido"


async def test_login_de_usuario_inactivo_no_se_distingue_y_no_suma_intentos(cliente, pool, conn):
    conn.responder("fetchrow", "from usuarios_dashboard where usuario", fila_usuario_dashboard("clave-segura-1", activo=False))
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "clave-segura-1"})
    assert res.status_code == 401
    assert conn.sql_ejecutado("intentos_fallidos") == []


async def test_login_con_cuenta_bloqueada_da_423_aunque_la_clave_sea_correcta(cliente, pool, conn):
    fila = fila_usuario_dashboard("clave-segura-1", bloqueado=True, segundos_bloqueo=600)
    conn.responder("fetchrow", "from usuarios_dashboard where usuario", fila)
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "clave-segura-1"})
    assert res.status_code == 423
    assert "10 minutos" in res.json()["detail"]
    assert conn.inserts_log()[0][5] == "bloqueado"


@pytest.mark.parametrize("cuerpo", [{}, {"usuario": "ana"}, {"usuario": "", "password": "x"}, {"usuario": "ana", "password": ""}])
async def test_login_con_cuerpo_invalido_da_422(cliente, pool, conn, cuerpo):
    assert (await cliente.post("/dashboard/auth/login", json=cuerpo)).status_code == 422


async def test_login_sin_secreto_configurado_da_503(cliente, pool, conn, monkeypatch):
    monkeypatch.delenv("DASHBOARD_SESSION_SECRET")
    monkeypatch.delenv("ADMIN_DELETE_TOKEN")
    get_settings.cache_clear()
    res = await cliente.post("/dashboard/auth/login", json={"usuario": "ana", "password": "x"})
    assert res.status_code == 503
    assert conn.llamadas == []


# --------------------------------------------------------------------------
# Autorizacion con Bearer
# --------------------------------------------------------------------------


async def test_yo_con_sesion_valida(cliente, pool, conn):
    fila = fila_usuario_dashboard(rol="supervisor", area="bodega")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.get("/dashboard/auth/yo", headers=encabezado_bearer(fila))
    assert res.status_code == 200
    assert res.json()["rol"] == "supervisor" and res.json()["area"] == "bodega"


async def test_yo_sin_sesion_da_401(cliente, pool, conn):
    assert (await cliente.get("/dashboard/auth/yo")).status_code == 401


@pytest.mark.parametrize("cabecera", ["Bearer", "Basic abc", "Bearer basura", "Bearer a.b", "token-pelado"])
async def test_encabezados_authorization_invalidos_dan_401(cliente, pool, conn, cabecera):
    res = await cliente.get("/dashboard/auth/yo", headers={"Authorization": cabecera})
    assert res.status_code == 401


async def test_sesion_de_un_usuario_dado_de_baja_deja_de_valer_de_inmediato(cliente, pool, conn):
    fila = fila_usuario_dashboard()
    conn.responder("fetchrow", "from usuarios_dashboard where id", None)  # activo = false / borrado
    res = await cliente.get("/dashboard/auth/yo", headers=encabezado_bearer(fila))
    assert res.status_code == 401


async def test_sesion_vencida_da_401(cliente, pool, conn):
    fila = fila_usuario_dashboard()
    token, _ = sesion.crear_token(fila["id"], sesion.obtener_secreto(), ahora=time.time() - 9 * 3600)
    res = await cliente.get("/dashboard/auth/yo", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401


async def test_sesion_con_sub_que_no_es_uuid_da_401(cliente, pool, conn):
    token, _ = sesion.crear_token("no-es-uuid", sesion.obtener_secreto())
    res = await cliente.get("/dashboard/auth/yo", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401


async def test_sesion_admin_puede_vaciar_entregas_sin_token_legacy(cliente, pool, conn):
    fila = fila_usuario_dashboard(rol="admin", usuario="ana")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.delete("/entregas/todas", headers=encabezado_bearer(fila))
    assert res.status_code == 200
    assert conn.inserts_log()[0][3] == "dashboard:ana"


@pytest.mark.parametrize("rol", ["supervisor", "consulta"])
async def test_sesion_sin_rol_admin_recibe_403_en_endpoints_de_admin(cliente, pool, conn, rol):
    fila = fila_usuario_dashboard(rol=rol)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.delete("/entregas/todas", headers=encabezado_bearer(fila))
    assert res.status_code == 403
    assert conn.sql_ejecutado("delete from entregas") == []


async def test_sesion_sin_permiso_pero_con_token_legacy_valido_pasa(cliente, pool, conn, admin_headers):
    """Transicion documentada: el token legacy se trata como admin."""
    fila = fila_usuario_dashboard(rol="consulta")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.delete("/entregas/todas", headers={**encabezado_bearer(fila), **admin_headers})
    assert res.status_code == 200


async def test_gestion_de_usuarios_exige_sesion_admin_y_no_acepta_el_token_legacy(cliente, pool, conn, admin_headers):
    assert (await cliente.get("/dashboard/usuarios", headers=admin_headers)).status_code == 401
    assert (await cliente.get("/dashboard/usuarios")).status_code == 401
