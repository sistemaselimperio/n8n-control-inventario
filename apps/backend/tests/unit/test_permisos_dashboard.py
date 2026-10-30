"""Permisos del dashboard: quien puede hacer que.

Dos capas:
  1. Las dependencias de `permisos_dashboard` sobre una mini aplicacion propia,
     para recorrer la matriz completa rol x area x credencial sin depender de
     cada router.
  2. La aplicacion real: cada ruta que escribe o que expone datos sensibles
     tiene que estar protegida, y las unicas abiertas son las de una lista
     explicita (la app movil no tiene sesion de dashboard). Una ruta nueva sin
     guardia hace fallar la prueba: el valor por defecto es "denegar".
"""

from __future__ import annotations

import time

import httpx
import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI, HTTPException

from app.config import get_settings
from app.main import app as app_real
from app.services import permisos_dashboard as permisos
from app.services.permisos_dashboard import (
    ActorDashboard,
    actor_actual,
    actor_para_log,
    area_efectiva,
    autorizar_admin,
    autorizar_roles,
    requiere_admin,
    requiere_rol,
    requiere_supervisor,
    requiere_supervisor_area,
    usuario_dashboard,
    usuario_dashboard_opcional,
    usuario_en_areas,
)
from app.services.sesion_dashboard import crear_token, firmar, obtener_secreto
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

TOKEN_LEGACY = "token-admin-de-prueba"
LEGACY = {"X-Admin-Token": TOKEN_LEGACY}

# --------------------------------------------------------------------------
# Mini aplicacion: una ruta por cada fabrica de dependencias
# --------------------------------------------------------------------------

_mini = FastAPI()


@_mini.get("/solo-admin")
async def _solo_admin(actor: ActorDashboard = Depends(requiere_admin)) -> dict:
    return {"actor": actor.actor, "con_sesion": actor.usuario is not None}


@_mini.get("/supervisor")
async def _supervisor(actor: ActorDashboard = Depends(requiere_supervisor)) -> dict:
    return {"actor": actor.actor}


@_mini.get("/area-bodega")
async def _area_bodega(actor: ActorDashboard = Depends(requiere_supervisor_area("todo", "bodega"))) -> dict:
    return {"actor": actor.actor}


@_mini.get("/area-traslados")
async def _area_traslados(actor: ActorDashboard = Depends(requiere_supervisor_area("todo", "traslados"))) -> dict:
    return {"actor": actor.actor}


@_mini.get("/rol-admin")
async def _rol_admin(u: dict = Depends(requiere_rol("admin"))) -> dict:
    return {"usuario": u["usuario"]}


@_mini.get("/rol-consulta")
async def _rol_consulta(u: dict = Depends(requiere_rol("consulta"))) -> dict:
    return {"usuario": u["usuario"]}


@_mini.get("/cualquier-sesion")
async def _cualquier_sesion(u: dict = Depends(usuario_dashboard)) -> dict:
    return {"usuario": u["usuario"], "rol": u["rol"], "area": u["area"]}


@_mini.get("/sesion-opcional")
async def _sesion_opcional(u: dict | None = Depends(usuario_dashboard_opcional)) -> dict:
    return {"usuario": None if u is None else u["usuario"]}


@_mini.get("/admin-a-mano")
async def _admin_a_mano(authorization: str | None = None, x_admin_token: str | None = None) -> dict:
    actor = await autorizar_admin(authorization, x_admin_token)
    return {"actor": actor.actor}


@pytest_asyncio.fixture
async def mini():
    transporte = httpx.ASGITransport(app=_mini)
    async with httpx.AsyncClient(transport=transporte, base_url="http://mini") as c:
        yield c


def _sesion(conn, rol: str, area: str = "todo", usuario: str = "ana") -> dict[str, str]:
    """Registra al usuario en la base falsa y devuelve su encabezado Bearer."""
    fila = fila_usuario_dashboard(rol=rol, area=area, usuario=usuario)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


# --------------------------------------------------------------------------
# Funciones puras
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "rol, area, esperado",
    [
        ("admin", "bodega", "todo"),  # el admin siempre actua como "todo"
        ("admin", "traslados", "todo"),
        ("admin", None, "todo"),
        ("supervisor", None, "todo"),  # filas anteriores a la columna
        ("supervisor", "", "todo"),
        ("supervisor", "bodega", "bodega"),
        ("consulta", "traslados", "traslados"),
        ("consulta", "todo", "todo"),
    ],
)
def test_area_efectiva(rol, area, esperado):
    assert area_efectiva(rol, area) == esperado


@pytest.mark.parametrize(
    "usuario, areas, esperado",
    [
        ({"rol": "supervisor", "area": "bodega"}, None, True),  # sin exigencia de area
        ({"rol": "supervisor", "area": "bodega"}, ("bodega",), True),
        ({"rol": "supervisor", "area": "bodega"}, ("traslados",), False),
        ({"rol": "supervisor", "area": "bodega"}, ("todo", "traslados"), False),
        ({"rol": "supervisor", "area": "todo"}, ("todo", "bodega"), True),
        ({"rol": "supervisor", "area": "todo"}, ("bodega",), False),  # "todo" no abre un area concreta
        ({"rol": "supervisor"}, ("todo",), True),  # sin area guardada cuenta como "todo"
        ({"rol": "supervisor", "area": None}, ("bodega",), False),
        ({"rol": "admin", "area": "bodega"}, ("traslados",), True),  # el admin siempre pasa
        ({"rol": "admin"}, ("nada",), True),
        ({"rol": "consulta", "area": "bodega"}, ("traslados",), False),
    ],
)
def test_usuario_en_areas(usuario, areas, esperado):
    assert usuario_en_areas(usuario, areas) is esperado


def test_actor_para_log_prefiere_la_sesion_y_respeta_el_actor_del_dashboard_viejo():
    con_sesion = ActorDashboard("dashboard:ana", {"id": "1"})
    legacy = ActorDashboard("dashboard:token")
    # Con sesion, lo que mande el cliente no importa: no se puede suplantar a otro.
    assert actor_para_log(con_sesion, "erika") == "dashboard:ana"
    assert actor_para_log(con_sesion, "desconocido") == "dashboard:ana"
    # Token legacy: se conserva lo que informa el dashboard viejo si es util.
    assert actor_para_log(legacy, "erika") == "erika"
    assert actor_para_log(legacy, "desconocido") == "dashboard:token"
    assert actor_para_log(legacy, "") == "dashboard:token"


def test_actor_dashboard_es_inmutable():
    actor = ActorDashboard("dashboard:ana")
    with pytest.raises(Exception):
        actor.actor = "dashboard:otro"  # type: ignore[misc]


# --------------------------------------------------------------------------
# Matriz rol x area x dependencia
# --------------------------------------------------------------------------

# (ruta, rol, area, status esperado con sesion y SIN token legacy)
_MATRIZ_SESION = [
    # Solo admin
    ("/solo-admin", "admin", "todo", 200),
    ("/solo-admin", "admin", "bodega", 200),
    ("/solo-admin", "supervisor", "todo", 403),
    ("/solo-admin", "consulta", "todo", 403),
    # Admin o supervisor (cualquier area)
    ("/supervisor", "admin", "todo", 200),
    ("/supervisor", "supervisor", "todo", 200),
    ("/supervisor", "supervisor", "bodega", 200),
    ("/supervisor", "supervisor", "traslados", 200),
    ("/supervisor", "consulta", "todo", 403),
    # Supervisor de bodega
    ("/area-bodega", "admin", "todo", 200),
    ("/area-bodega", "supervisor", "todo", 200),
    ("/area-bodega", "supervisor", "bodega", 200),
    ("/area-bodega", "supervisor", "traslados", 403),
    ("/area-bodega", "consulta", "bodega", 403),
    ("/area-bodega", "consulta", "todo", 403),
    # Supervisor de traslados
    ("/area-traslados", "admin", "todo", 200),
    ("/area-traslados", "supervisor", "todo", 200),
    ("/area-traslados", "supervisor", "traslados", 200),
    ("/area-traslados", "supervisor", "bodega", 403),
    ("/area-traslados", "consulta", "traslados", 403),
    # requiere_rol: sin token legacy y sin area
    ("/rol-admin", "admin", "todo", 200),
    ("/rol-admin", "supervisor", "todo", 403),
    ("/rol-admin", "consulta", "todo", 403),
    ("/rol-consulta", "consulta", "todo", 200),
    ("/rol-consulta", "admin", "todo", 403),  # la fabrica compara roles literalmente
    ("/rol-consulta", "supervisor", "todo", 403),
    # Cualquier sesion valida
    ("/cualquier-sesion", "admin", "todo", 200),
    ("/cualquier-sesion", "supervisor", "bodega", 200),
    ("/cualquier-sesion", "consulta", "traslados", 200),
]


@pytest.mark.parametrize("ruta, rol, area, esperado", _MATRIZ_SESION)
async def test_matriz_de_permisos_con_sesion(mini, pool, conn, ruta, rol, area, esperado):
    res = await mini.get(ruta, headers=_sesion(conn, rol, area))
    assert res.status_code == esperado, res.text


@pytest.mark.parametrize("ruta", [r for r in {m[0] for m in _MATRIZ_SESION}])
async def test_sin_credenciales_todas_las_rutas_protegidas_dan_401(mini, pool, conn, ruta):
    res = await mini.get(ruta)
    assert res.status_code == 401
    assert conn.llamadas == []  # ni siquiera consulta la base


@pytest.mark.parametrize("ruta", ["/solo-admin", "/supervisor", "/area-bodega", "/area-traslados"])
async def test_el_token_legacy_se_trata_como_admin_en_todas_las_areas(mini, pool, conn, ruta):
    res = await mini.get(ruta, headers=LEGACY)
    assert res.status_code == 200
    assert res.json()["actor"] == "dashboard:token"
    assert conn.llamadas == []


@pytest.mark.parametrize("ruta", ["/rol-admin", "/rol-consulta", "/cualquier-sesion"])
async def test_requiere_rol_y_sesion_simple_no_aceptan_el_token_legacy(mini, pool, conn, ruta):
    res = await mini.get(ruta, headers=LEGACY)
    assert res.status_code == 401


@pytest.mark.parametrize("ruta", ["/solo-admin", "/supervisor", "/area-bodega", "/area-traslados"])
@pytest.mark.parametrize("token", ["", "equivocado", TOKEN_LEGACY.upper(), TOKEN_LEGACY + " "])
async def test_token_legacy_incorrecto_da_401_sin_tocar_la_base(mini, pool, conn, ruta, token):
    res = await mini.get(ruta, headers={"X-Admin-Token": token})
    assert res.status_code == 401
    assert conn.llamadas == []


@pytest.mark.parametrize("ruta", ["/solo-admin", "/supervisor", "/area-bodega", "/area-traslados"])
async def test_sin_token_configurado_el_legacy_queda_cerrado_con_503(mini, pool, conn, monkeypatch, ruta):
    monkeypatch.delenv("ADMIN_DELETE_TOKEN")
    get_settings.cache_clear()
    res = await mini.get(ruta, headers=LEGACY)
    assert res.status_code == 503


async def test_sin_token_configurado_la_sesion_sigue_funcionando(mini, pool, conn, monkeypatch):
    monkeypatch.delenv("ADMIN_DELETE_TOKEN")
    get_settings.cache_clear()
    res = await mini.get("/solo-admin", headers=_sesion(conn, "admin"))
    assert res.status_code == 200


async def test_sesion_sin_permiso_mas_token_legacy_incorrecto_da_401_no_403(mini, pool, conn):
    headers = {**_sesion(conn, "consulta"), "X-Admin-Token": "equivocado"}
    assert (await mini.get("/solo-admin", headers=headers)).status_code == 401


async def test_sesion_sin_permiso_mas_token_legacy_valido_pasa_como_token(mini, pool, conn):
    """Transicion documentada: el token legacy gana sobre una sesion sin permiso."""
    headers = {**_sesion(conn, "consulta"), **LEGACY}
    res = await mini.get("/solo-admin", headers=headers)
    assert res.status_code == 200
    assert res.json() == {"actor": "dashboard:token", "con_sesion": False}


async def test_sesion_con_permiso_gana_sobre_el_token_legacy_y_deja_su_nombre(mini, pool, conn):
    headers = {**_sesion(conn, "admin", usuario="ana"), **LEGACY}
    res = await mini.get("/solo-admin", headers=headers)
    assert res.json() == {"actor": "dashboard:ana", "con_sesion": True}


# --------------------------------------------------------------------------
# Sesiones invalidas: nunca otorgan acceso
# --------------------------------------------------------------------------


@pytest.mark.parametrize("ruta", ["/solo-admin", "/cualquier-sesion", "/rol-admin"])
@pytest.mark.parametrize(
    "cabecera",
    ["Bearer", "Bearer ", "Basic abc", "Token abc", "Bearer basura", "Bearer a.b", "Bearer a.b.c", "abc", "Bearer  "],
)
async def test_authorization_malformado_da_401(mini, pool, conn, ruta, cabecera):
    res = await mini.get(ruta, headers={"Authorization": cabecera})
    # "Bearer " vacio se trata como si no hubiera sesion: tambien 401.
    assert res.status_code == 401
    assert conn.llamadas == []


async def test_authorization_malformado_con_token_legacy_valido_tambien_da_401(mini, pool, conn):
    """Una sesion rota no se "rescata" con el token legacy: falla cerrado."""
    res = await mini.get("/solo-admin", headers={"Authorization": "Bearer basura", **LEGACY})
    assert res.status_code == 401


async def test_esquema_bearer_no_distingue_mayusculas(mini, pool, conn):
    fila = fila_usuario_dashboard()
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    token = encabezado_bearer(fila)["Authorization"].split(" ", 1)[1]
    for esquema in ("bearer", "BEARER", "Bearer"):
        res = await mini.get("/cualquier-sesion", headers={"Authorization": f"{esquema} {token}"})
        assert res.status_code == 200


async def test_token_vencido_da_401(mini, pool, conn):
    fila = fila_usuario_dashboard()
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    token, _ = crear_token(fila["id"], obtener_secreto(), ahora=time.time() - 9 * 3600)
    res = await mini.get("/cualquier-sesion", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401
    assert conn.llamadas == []


async def test_token_firmado_con_otro_secreto_da_401(mini, pool, conn):
    fila = fila_usuario_dashboard()
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    token, _ = crear_token(fila["id"], "secreto-ajeno")
    res = await mini.get("/cualquier-sesion", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401


async def test_token_con_sub_que_no_es_uuid_da_401_sin_consultar(mini, pool, conn):
    token = firmar({"sub": "no-es-uuid", "exp": time.time() + 600}, obtener_secreto())
    res = await mini.get("/cualquier-sesion", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401
    assert conn.llamadas == []


async def test_usuario_inactivo_o_borrado_pierde_la_sesion_al_instante(mini, pool, conn):
    """La consulta filtra `activo = true`: sin fila, 401 aunque el token siga vigente."""
    fila = fila_usuario_dashboard()
    conn.responder("fetchrow", "from usuarios_dashboard where id", None)
    res = await mini.get("/solo-admin", headers=encabezado_bearer(fila))
    assert res.status_code == 401
    sql = conn.llamadas[0][1]
    assert "activo = true" in sql


async def test_usuario_inactivo_no_entra_ni_con_token_legacy_en_el_mismo_pedido(mini, pool, conn):
    fila = fila_usuario_dashboard()
    conn.responder("fetchrow", "from usuarios_dashboard where id", None)
    res = await mini.get("/solo-admin", headers={**encabezado_bearer(fila), **LEGACY})
    assert res.status_code == 401


async def test_el_rol_se_lee_de_la_base_en_cada_pedido_no_del_token(mini, pool, conn):
    fila = fila_usuario_dashboard(rol="admin")
    headers = encabezado_bearer(fila)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila, {**fila, "rol": "consulta"})
    assert (await mini.get("/solo-admin", headers=headers)).status_code == 200
    # El admin fue degradado: el mismo token ya no sirve para lo de admin.
    assert (await mini.get("/solo-admin", headers=headers)).status_code == 403


async def test_el_admin_actua_como_todo_aunque_la_fila_diga_otra_area(mini, pool, conn):
    res = await mini.get("/cualquier-sesion", headers=_sesion(conn, "admin", area="bodega"))
    assert res.json()["area"] == "todo"


async def test_sesion_sin_area_guardada_cuenta_como_todo(mini, pool, conn):
    fila = fila_usuario_dashboard(rol="supervisor")
    fila["area"] = None
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await mini.get("/cualquier-sesion", headers=encabezado_bearer(fila))
    assert res.json()["area"] == "todo"


# --------------------------------------------------------------------------
# Sesion opcional y autorizacion "a mano"
# --------------------------------------------------------------------------


async def test_sesion_opcional_sin_header_es_none(mini, pool, conn):
    res = await mini.get("/sesion-opcional")
    assert res.json() == {"usuario": None}
    assert conn.llamadas == []


@pytest.mark.parametrize("cabecera", ["Bearer basura", "Basic abc", "Bearer a.b.c"])
async def test_sesion_opcional_con_header_invalido_da_401_y_no_se_degrada_a_anonimo(mini, pool, conn, cabecera):
    res = await mini.get("/sesion-opcional", headers={"Authorization": cabecera})
    assert res.status_code == 401


async def test_sesion_opcional_con_header_vacio_se_trata_como_ausente(mini, pool, conn):
    res = await mini.get("/sesion-opcional", headers={"Authorization": "   "})
    assert res.json() == {"usuario": None}


async def test_sesion_opcional_valida_devuelve_el_usuario(mini, pool, conn):
    res = await mini.get("/sesion-opcional", headers=_sesion(conn, "consulta", usuario="luis"))
    assert res.json() == {"usuario": "luis"}


async def test_autorizar_admin_a_mano(mini, pool, conn):
    assert (await mini.get("/admin-a-mano")).status_code == 401
    assert (await mini.get("/admin-a-mano", params={"x_admin_token": "mal"})).status_code == 401
    ok = await mini.get("/admin-a-mano", params={"x_admin_token": TOKEN_LEGACY})
    assert ok.status_code == 200 and ok.json() == {"actor": "dashboard:token"}


async def test_autorizar_roles_directo_sin_credenciales_levanta_401():
    with pytest.raises(HTTPException) as info:
        await autorizar_roles(("admin",), None, None)
    assert info.value.status_code == 401


async def test_el_actor_de_la_peticion_queda_en_el_contextvar(pool, conn):
    actor_actual.set(None)
    headers = _sesion(conn, "supervisor", usuario="luis")
    actor = await autorizar_roles(("admin", "supervisor"), headers["Authorization"], None)
    assert actor.actor == "dashboard:luis"
    assert actor_actual.get() == "dashboard:luis"

    actor_actual.set(None)
    await autorizar_roles(("admin",), None, TOKEN_LEGACY)
    assert actor_actual.get() == "dashboard:token"


async def test_una_autorizacion_denegada_no_deja_actor_en_el_contextvar(pool, conn):
    actor_actual.set(None)
    headers = _sesion(conn, "consulta", usuario="luis")
    with pytest.raises(HTTPException):
        await autorizar_roles(("admin",), headers["Authorization"], None)
    assert actor_actual.get() is None


# --------------------------------------------------------------------------
# La aplicacion real: "denegar por defecto"
# --------------------------------------------------------------------------

_GUARDIAS = {
    "requiere_admin",
    "requiere_supervisor",
    "requiere_supervisor_area.<locals>.dependencia",
    "requiere_rol.<locals>.dependencia",
    "usuario_dashboard",
}


def _llamadas(dependant, acumulado: list) -> list:
    for dep in dependant.dependencies:
        acumulado.append(dep.call)
        _llamadas(dep, acumulado)
    return acumulado


def _rutas_reales():
    for ruta in app_real.routes:
        if not hasattr(ruta, "dependant"):
            continue
        nombres = {getattr(c, "__qualname__", "") for c in _llamadas(ruta.dependant, [])}
        for metodo in sorted(ruta.methods - {"HEAD", "OPTIONS"}):
            yield metodo, ruta.path, nombres


# Rutas SIN guardia de dashboard. Cada una es publica a proposito: la usa la
# app movil (que se identifica con PIN, no con sesion de dashboard) o es un
# chequeo de salud. Si se agrega una ruta nueva sin guardia hay que decidir
# aqui, por escrito, que sea publica.
_PUBLICAS = {
    # --- Captura y confirmacion de entregas (app movil)
    ("POST", "/entregas/procesar"),
    ("POST", "/entregas/{entrega_id}/devoluciones"),
    ("POST", "/entregas/{entrega_id}/no-entregados"),
    ("GET", "/entregas/pendientes"),
    ("GET", "/entregas/resumen-hoy"),
    ("GET", "/entregas/buscar"),
    ("GET", "/entregas/faia"),
    # --- Con sesion OPCIONAL (el dashboard la manda, el movil no): ver
    #     usuario_dashboard_opcional. Documentadas como limitacion conocida.
    ("DELETE", "/entregas/{entrega_id}"),
    ("PATCH", "/entregas/{entrega_id}/items"),
    ("GET", "/logs"),
    # --- Catalogos que lee el movil. Los listados con incluir_inactivos
    #     exigen admin dentro del propio endpoint.
    ("GET", "/sedes"),
    ("GET", "/empleados"),
    ("GET", "/productos"),
    ("GET", "/puntos"),
    ("GET", "/puntos/{punto_id}/usuarios"),
    ("GET", "/supervisores"),
    ("GET", "/tipos-documento"),
    # --- Login por PIN
    ("POST", "/auth/pin"),
    ("POST", "/puntos/auth/pin"),
    ("POST", "/supervisores/auth/pin"),
    ("POST", "/dashboard/auth/login"),
    # --- Traslados y talonarios (app movil de los puntos)
    ("POST", "/traslados-puntos"),
    ("POST", "/traslados-puntos/llegada-directa"),
    ("POST", "/traslados-puntos/extraer"),
    ("GET", "/puntos/{punto_id}/talonario"),
    ("GET", "/talonarios-puntos/resumen"),
    ("POST", "/talonarios-puntos/configurar"),
    ("POST", "/talonarios-puntos/anular-hoja"),
    ("GET", "/traslados-puntos"),
    ("GET", "/traslados-puntos/novedades"),
    ("GET", "/traslados-puntos/buscar-consecutivo"),
    ("GET", "/traslados-puntos/syscafe"),
    ("GET", "/traslados-puntos/actividad"),
    ("GET", "/traslados-puntos/{traslado_id}"),
    ("GET", "/traslados-puntos/{traslado_id}/historial"),
    ("POST", "/traslados-puntos/{traslado_id}/recepcion"),
    ("POST", "/traslados-puntos/{traslado_id}/solucion"),
    ("PATCH", "/traslados-puntos/{traslado_id}/syscafe"),
    # --- Facturas faltantes (bodega y mostrador, app movil)
    ("POST", "/facturas-faltantes"),
    ("GET", "/facturas-faltantes"),
    ("POST", "/facturas-faltantes/{reporte_id}/descartar"),
    ("POST", "/facturas-faltantes/{reporte_id}/marcar-subida"),
    # --- Lecturas de analitica sin datos personales
    ("GET", "/ranking/productos"),
    ("GET", "/turnos"),
    ("GET", "/turnos/carga"),
    ("GET", "/turnos/recomendaciones"),
    # --- Salud
    ("GET", "/health"),
}


def test_toda_ruta_sin_guardia_esta_en_la_lista_de_publicas():
    sin_guardia = {(metodo, ruta) for metodo, ruta, nombres in _rutas_reales() if not (nombres & _GUARDIAS)}
    inesperadas = sin_guardia - _PUBLICAS
    assert not inesperadas, f"Rutas sin proteccion que no estan en la lista de publicas: {sorted(inesperadas)}"


def test_la_lista_de_publicas_no_tiene_rutas_que_ya_no_existen_ni_que_hoy_estan_protegidas():
    reales = {(m, r): n for m, r, n in _rutas_reales()}
    for clave in _PUBLICAS:
        assert clave in reales, f"{clave} ya no existe: quitarla de la lista"
        assert not (reales[clave] & _GUARDIAS), f"{clave} esta protegida: quitarla de la lista de publicas"


# Operaciones de administracion y borrado: SIEMPRE exigen admin.
_SOLO_ADMIN = [
    ("DELETE", "/entregas/todas"),
    ("DELETE", "/entregas/{entrega_id}/definitivo"),
    ("POST", "/sedes"),
    ("PATCH", "/sedes/{sede_id}"),
    ("DELETE", "/sedes/{sede_id}"),
    ("POST", "/empleados"),
    ("PATCH", "/empleados/{empleado_id}"),
    ("DELETE", "/empleados/{empleado_id}"),
    ("POST", "/empleados/{empleado_id}/pin"),
    ("POST", "/puntos"),
    ("PATCH", "/puntos/{punto_id}"),
    ("DELETE", "/puntos/{punto_id}"),
    ("POST", "/puntos/{punto_id}/usuarios"),
    ("PATCH", "/puntos/usuarios/{usuario_id}"),
    ("DELETE", "/puntos/usuarios/{usuario_id}"),
    ("POST", "/puntos/usuarios/{usuario_id}/pin"),
    ("POST", "/supervisores"),
    ("PATCH", "/supervisores/{supervisor_id}"),
    ("DELETE", "/supervisores/{supervisor_id}"),
    ("POST", "/supervisores/{supervisor_id}/pin"),
    ("POST", "/tipos-documento"),
    ("PATCH", "/tipos-documento/{codigo}"),
    ("DELETE", "/tipos-documento/{codigo}"),
]

# Gestion de usuarios del dashboard: solo sesion admin, sin token legacy.
_SOLO_SESION_ADMIN = [
    ("GET", "/dashboard/usuarios"),
    ("POST", "/dashboard/usuarios"),
    ("PATCH", "/dashboard/usuarios/{usuario_id}"),
    ("DELETE", "/dashboard/usuarios/{usuario_id}"),
    ("POST", "/dashboard/usuarios/{usuario_id}/password"),
]


def test_las_operaciones_de_administracion_y_borrado_exigen_admin():
    reales = {(m, r): n for m, r, n in _rutas_reales()}
    for clave in _SOLO_ADMIN:
        assert "requiere_admin" in reales[clave], f"{clave} deberia exigir requiere_admin"
    for clave in _SOLO_SESION_ADMIN:
        assert "requiere_rol.<locals>.dependencia" in reales[clave], f"{clave} deberia exigir requiere_rol('admin')"


def test_toda_ruta_de_borrado_exige_una_guardia_salvo_la_cancelacion_del_movil():
    """Un DELETE nuevo sin guardia es casi siempre un olvido."""
    borrados = {(m, r): n for m, r, n in _rutas_reales() if m == "DELETE"}
    sin_guardia = {k for k, n in borrados.items() if not (n & _GUARDIAS)}
    assert sin_guardia == {("DELETE", "/entregas/{entrega_id}")}


# Ejemplos concretos sobre la aplicacion real: guardia correcta por rol.
_UUID = "11111111-1111-1111-1111-111111111111"
_ESCRITURAS_ADMIN = [
    ("DELETE", f"/sedes/{_UUID}", None),
    ("DELETE", f"/empleados/{_UUID}", None),
    ("DELETE", f"/puntos/{_UUID}", None),
    ("DELETE", f"/puntos/usuarios/{_UUID}", None),
    ("DELETE", f"/supervisores/{_UUID}", None),
    ("DELETE", "/tipos-documento/FEI", None),
    ("DELETE", "/entregas/todas", None),
    ("DELETE", f"/entregas/{_UUID}/definitivo", None),
    ("DELETE", f"/dashboard/usuarios/{_UUID}", None),
]


@pytest.mark.parametrize("metodo, ruta, cuerpo", _ESCRITURAS_ADMIN)
@pytest.mark.parametrize("rol", ["supervisor", "consulta"])
async def test_borrados_en_la_app_real_dan_403_a_roles_sin_admin_y_no_tocan_datos(
    cliente, pool, conn, metodo, ruta, cuerpo, rol
):
    res = await cliente.request(metodo, ruta, headers=_sesion(conn, rol, "todo"))
    assert res.status_code == 403
    assert [c for c in conn.llamadas if c[1].lstrip().lower().startswith(("delete", "truncate"))] == []
    assert conn.eventos_log() == []


@pytest.mark.parametrize("metodo, ruta, cuerpo", _ESCRITURAS_ADMIN)
async def test_borrados_en_la_app_real_dan_401_sin_credenciales(cliente, pool, conn, metodo, ruta, cuerpo):
    res = await cliente.request(metodo, ruta)
    assert res.status_code == 401
    assert conn.llamadas == []


@pytest.mark.parametrize("area, esperado", [("todo", 201), ("bodega", 201), ("traslados", 403)])
async def test_catalogo_de_productos_lo_edita_admin_o_supervisor_de_bodega(cliente, pool, conn, area, esperado):
    conn.responder("fetchrow", "insert into productos", {"id": _UUID, "codigo": "1", "nombre": "A"})
    res = await cliente.post(
        "/productos", json={"codigo": "12345", "nombre": "Sal"}, headers=_sesion(conn, "supervisor", area)
    )
    assert res.status_code == esperado


async def test_catalogo_de_productos_no_lo_edita_consulta(cliente, pool, conn):
    res = await cliente.post(
        "/productos", json={"codigo": "12345", "nombre": "Sal"}, headers=_sesion(conn, "consulta")
    )
    assert res.status_code == 403
    assert conn.sql_ejecutado("insert into productos") == []


def test_el_modulo_expone_las_guardias_que_las_rutas_necesitan():
    # Si alguien renombra una guardia, la lista _GUARDIAS de arriba deja de
    # detectar rutas protegidas: que falle aqui y no en silencio.
    for nombre in ("requiere_admin", "requiere_supervisor", "usuario_dashboard", "requiere_rol", "requiere_supervisor_area"):
        assert hasattr(permisos, nombre)
