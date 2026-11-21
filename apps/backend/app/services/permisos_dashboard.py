"""Dependencias de FastAPI para la sesion del dashboard y los permisos por rol.

Header: `Authorization: Bearer <token>` (token de POST /dashboard/auth/login).
El usuario se lee de la base en CADA request: una baja o un cambio de rol rige
al instante, aunque el token todavia no haya vencido.
"""

import contextvars
from dataclasses import dataclass
from uuid import UUID

from fastapi import Header, HTTPException

from app.db import get_pool
from app.services.admin_auth import verificar_token_admin
from app.services.sesion_dashboard import obtener_secreto, verificar

_MSG_SESION_EXPIRADA = "Tu sesión expiró. Inicia sesión de nuevo."
_MSG_SIN_SESION = "Inicia sesión"
_MSG_SIN_PERMISO = "No tienes permiso para esta acción"

# Actor de la peticion en curso, para que registrar_cambio (usuarios.py) deje
# en logs quien hizo el cambio sin pasar el actor por cada funcion de servicio.
# Lo setean las dependencias requiere_* (async: corren en la misma tarea que el
# endpoint, asi que el valor llega).
actor_actual: contextvars.ContextVar[str | None] = contextvars.ContextVar("actor_dashboard", default=None)


def area_efectiva(rol: str, area: str | None) -> str:
    """Area con la que actua el usuario: el admin siempre es "todo", sin
    importar lo guardado; un valor ausente (filas o sesiones anteriores a la
    columna) tambien cuenta como "todo"."""
    if rol == "admin" or not area:
        return "todo"
    return area


@dataclass(frozen=True)
class ActorDashboard:
    """Quien hace la accion: `actor` es el texto para logs ("dashboard:<usuario>"
    o "dashboard:token" con el token legacy); `usuario` es el dict de la sesion
    o None si entro con el token legacy."""

    actor: str
    usuario: dict | None = None


def actor_para_log(actor: ActorDashboard, fallback: str) -> str:
    """Actor a registrar: el de la sesion si hay; con el token legacy se
    respeta lo que mande el dashboard viejo (`fallback`) si dijo algo util."""
    if actor.usuario is None and fallback and fallback != "desconocido":
        return fallback
    return actor.actor


async def _usuario_desde_header(authorization: str | None) -> dict | None:
    if authorization is None or not authorization.strip():
        return None
    partes = authorization.split(None, 1)
    if len(partes) != 2 or partes[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail=_MSG_SESION_EXPIRADA)
    payload = verificar(partes[1].strip(), obtener_secreto())
    if payload is None:
        raise HTTPException(status_code=401, detail=_MSG_SESION_EXPIRADA)
    try:
        usuario_id = str(UUID(payload["sub"]))
    except ValueError:
        raise HTTPException(status_code=401, detail=_MSG_SESION_EXPIRADA) from None
    pool = await get_pool()
    fila = await pool.fetchrow(
        "select id, usuario, nombre, rol, area, punto_id, cedula from usuarios_dashboard "
        "where id = $1::uuid and activo = true",
        usuario_id,
    )
    if fila is None:
        raise HTTPException(status_code=401, detail=_MSG_SESION_EXPIRADA)
    return {
        "id": str(fila["id"]),
        "usuario": fila["usuario"],
        "nombre": fila["nombre"],
        "rol": fila["rol"],
        "area": area_efectiva(fila["rol"], fila["area"]),
        # Modulo de traslados: punto asignado (None = encargada o sin alcance)
        # y cedula con la que firma confirmaciones y devoluciones.
        "punto_id": None if fila.get("punto_id") is None else str(fila["punto_id"]),
        "cedula": fila.get("cedula"),
    }


async def usuario_dashboard_opcional(authorization: str | None = Header(default=None)) -> dict | None:
    """None si no viene Authorization; 401 si viene pero es invalida/vencida o
    el usuario ya no existe / esta inactivo."""
    return await _usuario_desde_header(authorization)


async def usuario_dashboard(authorization: str | None = Header(default=None)) -> dict:
    usuario = await _usuario_desde_header(authorization)
    if usuario is None:
        raise HTTPException(status_code=401, detail=_MSG_SIN_SESION)
    return usuario


def requiere_rol(*roles: str):
    """Fabrica de dependencias: exige sesion con alguno de `roles` (sin token
    legacy). Devuelve el usuario."""

    async def dependencia(authorization: str | None = Header(default=None)) -> dict:
        usuario = await usuario_dashboard(authorization)
        if usuario["rol"] not in roles:
            raise HTTPException(status_code=403, detail=_MSG_SIN_PERMISO)
        actor_actual.set(f"dashboard:{usuario['usuario']}")
        return usuario

    return dependencia


def usuario_en_areas(usuario: dict, areas: tuple[str, ...] | None) -> bool:
    """True si no se exige area, o si el area efectiva del usuario esta en
    `areas` (el admin siempre pasa)."""
    if areas is None or usuario["rol"] == "admin":
        return True
    return area_efectiva(usuario["rol"], usuario.get("area")) in areas


async def autorizar_roles(
    roles: tuple[str, ...],
    authorization: str | None,
    x_admin_token: str | None,
    areas: tuple[str, ...] | None = None,
) -> ActorDashboard:
    """Sesion con alguno de `roles` (y, si se indica, de `areas`) O el token
    legacy X-Admin-Token (tratado como admin: pasa todas las areas).

    # TRANSICION: el token legacy (X-Admin-Token / ADMIN_DELETE_TOKEN) se
    # acepta mientras el dashboard viejo siga en uso. Se elimina esta rama (y
    # el uso de verificar_token_admin) cuando el dashboard salga con login.
    """
    usuario = await _usuario_desde_header(authorization)
    if usuario is not None and usuario["rol"] in roles and usuario_en_areas(usuario, areas):
        actor = ActorDashboard(f"dashboard:{usuario['usuario']}", usuario)
    elif x_admin_token is not None:
        verificar_token_admin(x_admin_token)  # 401 si es incorrecto, 503 si no esta configurado
        actor = ActorDashboard("dashboard:token")
    elif usuario is not None:
        raise HTTPException(status_code=403, detail=_MSG_SIN_PERMISO)
    else:
        raise HTTPException(status_code=401, detail=_MSG_SIN_SESION)
    actor_actual.set(actor.actor)
    return actor


async def autorizar_admin(authorization: str | None, x_admin_token: str | None) -> ActorDashboard:
    """Version invocable a mano (lecturas con ?incluir_inactivos=true)."""
    return await autorizar_roles(("admin",), authorization, x_admin_token)


async def requiere_admin(
    authorization: str | None = Header(default=None), x_admin_token: str | None = Header(default=None)
) -> ActorDashboard:
    """Sesion admin O token legacy (ver TRANSICION en autorizar_roles)."""
    return await autorizar_admin(authorization, x_admin_token)


async def requiere_supervisor(
    authorization: str | None = Header(default=None), x_admin_token: str | None = Header(default=None)
) -> ActorDashboard:
    """Sesion admin/supervisor O token legacy (ver TRANSICION en autorizar_roles)."""
    return await autorizar_roles(("admin", "supervisor"), authorization, x_admin_token)


def requiere_supervisor_area(*areas: str):
    """Fabrica de dependencias: sesion admin/supervisor cuya area sea alguna de
    `areas` (el admin siempre pasa) O token legacy (ver TRANSICION en
    autorizar_roles). Un supervisor de otra area recibe 403."""

    async def dependencia(
        authorization: str | None = Header(default=None), x_admin_token: str | None = Header(default=None)
    ) -> ActorDashboard:
        return await autorizar_roles(("admin", "supervisor"), authorization, x_admin_token, areas)

    return dependencia
