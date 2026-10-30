"""Usuarios del dashboard (tabla usuarios_dashboard): login con lockout,
alta/edicion por un admin, reset y cambio de contrasena. La logica vive aca;
app/routers/dashboard_auth.py solo traduce excepciones a HTTP.

Nunca se escribe una contrasena (ni su hash) en logs ni en respuestas.
"""

import math
from datetime import UTC, datetime

import asyncpg

from app.db import get_pool
from app.models.log import EventoLog
from app.models.usuario_dashboard import normalizar_usuario
from app.services.auth_pin import generar_sal, hashear_password, verificar_password
from app.services.logging_service import registrar_evento
from app.services.permisos_dashboard import area_efectiva
from app.services.sesion_dashboard import crear_token, obtener_secreto

MAX_INTENTOS = 5
BLOQUEO_MINUTOS = 15

# Sal/hash falsos para gastar el mismo tiempo de PBKDF2 cuando el usuario no
# existe, y que la respuesta no delate si el usuario es real.
_SAL_FALSA = generar_sal()
_HASH_FALSO = hashear_password("sin-usuario", _SAL_FALSA)


class CredencialesInvalidas(Exception):
    pass


class CuentaBloqueada(Exception):
    def __init__(self, minutos: int) -> None:
        self.minutos = minutos


class UsuarioDuplicado(Exception):
    pass


class UsuarioNoEncontrado(Exception):
    pass


class ReglaAdmin(Exception):
    """Cambio que dejaria al sistema sin administrador o que un admin se haria a si mismo."""


class PasswordIncorrecta(Exception):
    pass


def _publico(fila: asyncpg.Record) -> dict:
    return {
        "id": str(fila["id"]),
        "usuario": fila["usuario"],
        "nombre": fila["nombre"],
        "rol": fila["rol"],
        "area": area_efectiva(fila["rol"], fila["area"]),
    }


def _completo(fila: asyncpg.Record) -> dict:
    """Para el listado de administracion: sin hash ni sal."""
    return {
        **_publico(fila),
        "activo": fila["activo"],
        "creado_at": fila["creado_at"],
        "ultimo_login_at": fila["ultimo_login_at"],
        "bloqueado_hasta": fila["bloqueado_hasta"],
    }


async def _log_login(entidad_id: str, usuario: str, resultado: str) -> None:
    await registrar_evento(
        EventoLog.DASHBOARD_LOGIN,
        entidad_tipo="usuario_dashboard",
        entidad_id=entidad_id,
        actor_id=f"dashboard:{usuario}",
        sede_id="-",
        resultado=resultado,
    )


async def autenticar(usuario: str, password: str) -> tuple[str, datetime, dict]:
    """Valida credenciales y devuelve (token, expira_at, usuario publico).
    CredencialesInvalidas cubre usuario inexistente, contrasena mala y usuario
    inactivo (misma respuesta, sin enumeracion). CuentaBloqueada si esta en
    lockout."""
    secreto = obtener_secreto()  # 503 antes de tocar nada si no hay con que firmar
    usuario = normalizar_usuario(usuario)
    pool = await get_pool()
    fila = await pool.fetchrow(
        """
        select *, (bloqueado_hasta is not null and bloqueado_hasta > now()) as bloqueado,
               extract(epoch from (bloqueado_hasta - now())) as segundos_bloqueo
        from usuarios_dashboard where usuario = $1
        """,
        usuario,
    )
    if fila is None:
        verificar_password(password, _SAL_FALSA, _HASH_FALSO)
        await _log_login(usuario[:100], usuario[:100], "fallido")
        raise CredencialesInvalidas()

    entidad_id = str(fila["id"])
    if fila["bloqueado"]:
        await _log_login(entidad_id, usuario, "bloqueado")
        raise CuentaBloqueada(max(1, math.ceil(float(fila["segundos_bloqueo"]) / 60)))

    correcta = verificar_password(password, fila["pass_salt"], fila["pass_hash"])
    if not fila["activo"] or not correcta:
        resultado = "fallido"
        if fila["activo"]:
            # Atomico en SQL: dos intentos simultaneos no pisan el contador.
            bloqueado_hasta = await pool.fetchval(
                """
                update usuarios_dashboard
                set intentos_fallidos = case when intentos_fallidos + 1 >= $2 then 0 else intentos_fallidos + 1 end,
                    bloqueado_hasta = case when intentos_fallidos + 1 >= $2
                        then now() + make_interval(mins => $3) else bloqueado_hasta end
                where id = $1::uuid
                returning (bloqueado_hasta is not null and bloqueado_hasta > now())
                """,
                entidad_id,
                MAX_INTENTOS,
                BLOQUEO_MINUTOS,
            )
            if bloqueado_hasta:
                resultado = "bloqueado"
        await _log_login(entidad_id, usuario, resultado)
        raise CredencialesInvalidas()

    await pool.execute(
        """
        update usuarios_dashboard
        set intentos_fallidos = 0, bloqueado_hasta = null, ultimo_login_at = now()
        where id = $1::uuid
        """,
        entidad_id,
    )
    await _log_login(entidad_id, usuario, "ok")
    token, exp = crear_token(entidad_id, secreto)
    return token, datetime.fromtimestamp(exp, UTC), _publico(fila)


async def listar() -> list[dict]:
    pool = await get_pool()
    filas = await pool.fetch("select * from usuarios_dashboard order by activo desc, usuario")
    return [_completo(f) for f in filas]


async def _registrar_cambio(actor: dict, entidad_id: str, accion: str, detalle: dict) -> None:
    await registrar_evento(
        EventoLog.ADMIN_CAMBIO,
        entidad_tipo="usuario_dashboard",
        entidad_id=entidad_id,
        actor_id=f"dashboard:{actor['usuario']}",
        sede_id="-",
        resultado=accion,
        detalle=detalle,
    )


async def crear(actor: dict, usuario: str, nombre: str, rol: str, password: str, area: str = "todo") -> dict:
    # El admin siempre es area "todo", sea lo que sea que llegue.
    area = area_efectiva(rol, area)
    sal = generar_sal()
    pool = await get_pool()
    try:
        fila = await pool.fetchrow(
            """
            insert into usuarios_dashboard (usuario, nombre, rol, area, pass_hash, pass_salt)
            values ($1, $2, $3, $4, $5, $6) returning *
            """,
            usuario,
            nombre,
            rol,
            area,
            hashear_password(password, sal),
            sal,
        )
    except asyncpg.UniqueViolationError as exc:
        raise UsuarioDuplicado() from exc
    await _registrar_cambio(
        actor, str(fila["id"]), "creado", {"usuario": usuario, "nombre": nombre, "rol": rol, "area": area}
    )
    return _completo(fila)


async def actualizar(actor: dict, usuario_id: str, cambios: dict) -> dict:
    """Update parcial de nombre/rol/area/activo. Guardas: un admin no puede
    desactivarse ni quitarse el rol admin a si mismo, y siempre debe quedar al
    menos un admin activo."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Bloquea a los admins activos para que dos cambios simultaneos no
            # dejen el sistema sin ninguno.
            admins = await conn.fetch("select id from usuarios_dashboard where rol = 'admin' and activo order by id for update")
            ids_admin_activos = {str(a["id"]) for a in admins}
            actual = await conn.fetchrow("select * from usuarios_dashboard where id = $1::uuid for update", usuario_id)
            if actual is None:
                raise UsuarioNoEncontrado()

            deja_de_ser_admin_activo = str(actual["id"]) in ids_admin_activos and (
                cambios.get("activo") is False or ("rol" in cambios and cambios["rol"] != "admin")
            )
            if deja_de_ser_admin_activo:
                if usuario_id == actor["id"]:
                    raise ReglaAdmin("No puedes desactivarte ni quitarte el rol de administrador a ti mismo")
                if len(ids_admin_activos) <= 1:
                    raise ReglaAdmin("Debe quedar al menos un administrador activo")

            efectivos = {k: v for k, v in cambios.items() if k in ("nombre", "rol", "area", "activo") and v is not None}
            # Un admin queda siempre en area "todo": si el rol resultante es
            # admin se fuerza, y si cambia el rol a admin se normaliza el area.
            rol_resultante = efectivos.get("rol", actual["rol"])
            if rol_resultante == "admin" and (efectivos.get("area") or actual["area"]) != "todo":
                efectivos["area"] = "todo"
            if efectivos:
                asignaciones = ", ".join(f"{col} = ${i}" for i, col in enumerate(efectivos, start=2))
                fila = await conn.fetchrow(
                    f"update usuarios_dashboard set {asignaciones} where id = $1::uuid returning *",
                    usuario_id,
                    *efectivos.values(),
                )
            else:
                fila = actual
    if efectivos:
        await _registrar_cambio(actor, usuario_id, "actualizado", {"usuario": fila["usuario"], **efectivos})
    return _completo(fila)


async def resetear_password(actor: dict, usuario_id: str, password: str) -> None:
    """Pone una contrasena nueva (sal nueva) y limpia el lockout."""
    sal = generar_sal()
    pool = await get_pool()
    usuario = await pool.fetchval(
        """
        update usuarios_dashboard
        set pass_hash = $2, pass_salt = $3, intentos_fallidos = 0, bloqueado_hasta = null
        where id = $1::uuid returning usuario
        """,
        usuario_id,
        hashear_password(password, sal),
        sal,
    )
    if usuario is None:
        raise UsuarioNoEncontrado()
    await _registrar_cambio(actor, usuario_id, "password_reseteada", {"usuario": usuario})


async def cambiar_password(usuario: dict, actual: str, nueva: str) -> None:
    pool = await get_pool()
    fila = await pool.fetchrow(
        "select pass_hash, pass_salt from usuarios_dashboard where id = $1::uuid", usuario["id"]
    )
    if fila is None:
        raise UsuarioNoEncontrado()
    if not verificar_password(actual, fila["pass_salt"], fila["pass_hash"]):
        raise PasswordIncorrecta()
    sal = generar_sal()
    await pool.execute(
        "update usuarios_dashboard set pass_hash = $2, pass_salt = $3 where id = $1::uuid",
        usuario["id"],
        hashear_password(nueva, sal),
        sal,
    )
    await _registrar_cambio(usuario, usuario["id"], "password_cambiada", {"usuario": usuario["usuario"]})


async def crear_o_actualizar_admin(conn: asyncpg.Connection, usuario: str, nombre: str, password: str) -> str:
    """Para scripts/crear_admin_dashboard.py: crea el admin, o si el usuario ya
    existe le resetea la contrasena, lo deja admin/activo y limpia el lockout.
    Devuelve "creado" o "actualizado"."""
    sal = generar_sal()
    existente = await conn.fetchval("select id from usuarios_dashboard where usuario = $1", usuario)
    if existente is None:
        await conn.execute(
            """
            insert into usuarios_dashboard (usuario, nombre, rol, pass_hash, pass_salt)
            values ($1, $2, 'admin', $3, $4)
            """,
            usuario,
            nombre,
            hashear_password(password, sal),
            sal,
        )
        return "creado"
    await conn.execute(
        """
        update usuarios_dashboard
        set nombre = $2, rol = 'admin', area = 'todo', activo = true, pass_hash = $3, pass_salt = $4,
            intentos_fallidos = 0, bloqueado_hasta = null
        where id = $1
        """,
        existente,
        nombre,
        hashear_password(password, sal),
        sal,
    )
    return "actualizado"
