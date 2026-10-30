"""Borrado desde /creador: solo se elimina lo que nunca se uso.

La base va simulada: cada prueba guiona la fila a borrar y que chequeos de
historial "encuentran algo", y afirma sobre el SQL que se ejecuto. Reglas que
se verifican aqui:
  - nada con historial se borra jamas (409 / TieneHistorial);
  - se borra exactamente una fila, por su id, y nada mas;
  - `logs` es append-only: solo se agrega el evento `admin_cambio` ("eliminado");
  - ningun dato de PIN ni contrasena llega a los logs;
  - nada sale a la red (el bucket de Storage no se toca).
"""

from __future__ import annotations

import asyncpg
import httpx
import pytest

from app.services import borrado_admin as borrado
from app.services import tipos_documento as servicio_tipos
from app.services.borrado_admin import ReglaBorrado, TieneHistorial
from app.services.permisos_dashboard import actor_actual
from app.services.usuarios import RegistroNoEncontrado
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

ID = "11111111-1111-1111-1111-111111111111"
ID_OTRO = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def sin_red(monkeypatch):
    """Ninguna prueba de borrado puede hablar con Supabase Storage ni con nada
    externo: si algo intenta salir, la prueba falla en vez de borrar fotos."""

    async def _prohibido(self, *args, **kwargs):
        raise AssertionError("Intento de acceso a la red durante una prueba de borrado")

    # El cliente de las pruebas usa ASGITransport (en memoria); solo se bloquea
    # el transporte de red real, el que usaria cualquier llamada a Supabase.
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _prohibido)

    async def _sin_conexion(*args, **kwargs):
        raise AssertionError("Intento de abrir una conexion directa a Postgres")

    monkeypatch.setattr(asyncpg, "connect", _sin_conexion)


# --------------------------------------------------------------------------
# Casos por entidad
# --------------------------------------------------------------------------

# (nombre, funcion, args, tabla, entidad_tipo_log, chequeos, fila, detalle esperado)
CASOS = [
    pytest.param(
        borrado.eliminar_sede, (ID,), "sedes", "sede", borrado._CHEQUEOS_SEDE,
        {"id": ID, "nombre": "Norte", "codigo": "S-01"},
        {"nombre": "Norte", "codigo": "S-01"},
        id="sede",
    ),
    pytest.param(
        borrado.eliminar_empleado, (ID,), "empleados", "empleado", borrado._CHEQUEOS_EMPLEADO,
        {"id": ID, "nombre": "Luis", "rol": "operador", "sede_id": "sede-1", "pin_hash": "H", "pin_salt": "S"},
        {"nombre": "Luis", "rol": "operador", "sede_id": "sede-1"},
        id="empleado",
    ),
    pytest.param(
        borrado.eliminar_punto, (ID,), "puntos", "punto", borrado._CHEQUEOS_PUNTO,
        {"id": ID, "nombre": "TB9 — Estacion", "codigo": "TB9"},
        {"nombre": "TB9 — Estacion", "codigo": "TB9"},
        id="punto",
    ),
    pytest.param(
        borrado.eliminar_usuario_punto, (ID,), "usuarios_punto", "usuario_punto", borrado._CHEQUEOS_USUARIO_PUNTO,
        {"id": ID, "nombre": "Cuenta TB9", "punto_id": ID_OTRO, "pin_hash": "H", "pin_salt": "S"},
        {"nombre": "Cuenta TB9", "punto_id": ID_OTRO},
        id="usuario_punto",
    ),
    pytest.param(
        borrado.eliminar_supervisor, (ID,), "supervisores", "supervisor", borrado._CHEQUEOS_SUPERVISOR,
        {"id": ID, "nombre": "Erika", "pin_hash": "H", "pin_salt": "S"},
        {"nombre": "Erika"},
        id="supervisor",
    ),
    pytest.param(
        borrado.eliminar_tipo_documento, ("FEI",), "tipos_documento", "tipo_documento", borrado._CHEQUEOS_TIPO,
        {"codigo": "FEI", "descripcion": "factura"},
        {"codigo": "FEI", "descripcion": "factura"},
        id="tipo_documento",
    ),
]

_PARAMS = "funcion, args, tabla, entidad, chequeos, fila, detalle"


def guionar(conn, fila: dict | None, con_historial: tuple[int, ...] = (), n_chequeos: int = 0) -> None:
    """`fila`: lo que devuelve el select ... for update. `con_historial`: indices
    de chequeos que 'encuentran filas'."""
    conn.responder("fetchrow", "for update", fila)
    conn.responder("fetchrow", "as _p", {"_p": True, **{f"c{i}": i in con_historial for i in range(n_chequeos)}})


def borrados(conn) -> list:
    return [c for c in conn.llamadas if c[0] == "execute" and c[1].lstrip().lower().startswith("delete")]


def modifican_logs(conn) -> list:
    """Cualquier sentencia que cambie o borre filas de logs (insertar esta bien)."""
    return [
        c for c in conn.llamadas
        if c[0] == "execute"
        and "logs" in c[1].lower()
        and not c[1].lstrip().lower().startswith("insert into logs")
    ]


# --------------------------------------------------------------------------
# Borrado sin historial
# --------------------------------------------------------------------------


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_sin_historial_borra_exactamente_la_fila_y_deja_un_evento(
    pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle
):
    guionar(conn, fila, n_chequeos=len(chequeos))
    actor_actual.set("dashboard:ana")
    await funcion(*args)

    eliminados = borrados(conn)
    assert len(eliminados) == 1
    _, sql, parametros = eliminados[0]
    assert sql.startswith(f"delete from {tabla} where ")
    assert parametros == (args[0],)

    # Un unico evento admin_cambio / eliminado, a nombre de quien lo pidio.
    (evento,) = conn.inserts_log()
    nombre_evento, entidad_tipo, entidad_id, actor, _sede, resultado, det = evento
    assert nombre_evento == "admin_cambio"
    assert entidad_tipo == entidad
    assert entidad_id == args[0]
    assert actor == "dashboard:ana"
    assert resultado == "eliminado"
    assert det == {k: str(v) if k == "punto_id" else v for k, v in detalle.items()}
    # logs es append-only: no se actualiza ni se borra nada de logs.
    assert modifican_logs(conn) == []


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_el_evento_de_borrado_nunca_lleva_datos_de_pin(pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle):
    guionar(conn, fila, n_chequeos=len(chequeos))
    await funcion(*args)
    texto = str(conn.inserts_log())
    assert "pin_hash" not in texto and "pin_salt" not in texto
    assert "'H'" not in texto and "'S'" not in texto


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_fuera_de_una_peticion_el_actor_es_admin(pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle):
    guionar(conn, fila, n_chequeos=len(chequeos))
    actor_actual.set(None)
    await funcion(*args)
    assert conn.inserts_log()[0][3] == "admin"


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_borra_dentro_de_una_transaccion_con_la_fila_bloqueada(pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle):
    guionar(conn, fila, n_chequeos=len(chequeos))
    await funcion(*args)
    primero = conn.llamadas[0]
    # for update serializa dos borrados simultaneos del mismo registro.
    assert primero[0] == "fetchrow" and primero[1].rstrip().endswith("for update")
    metodos = [c[0] for c in conn.llamadas]
    assert metodos.index("fetchrow") < metodos.index("execute")


# --------------------------------------------------------------------------
# Borrado con historial: se rechaza, no se toca nada
# --------------------------------------------------------------------------


def _casos_por_chequeo():
    for param in CASOS:
        funcion, args, tabla, entidad, chequeos, fila, detalle = param.values
        for i, (descripcion, _sql) in enumerate(chequeos):
            yield pytest.param(
                funcion, args, tabla, chequeos, fila, i, descripcion, id=f"{param.id}-{descripcion}"
            )


@pytest.mark.parametrize("funcion, args, tabla, chequeos, fila, indice, descripcion", list(_casos_por_chequeo()))
async def test_cualquier_historial_impide_el_borrado(pool, conn, funcion, args, tabla, chequeos, fila, indice, descripcion):
    guionar(conn, fila, con_historial=(indice,), n_chequeos=len(chequeos))
    with pytest.raises(TieneHistorial) as info:
        await funcion(*args)
    assert descripcion in str(info.value)
    assert str(info.value).startswith("No se puede eliminar: ")
    # Ni delete ni evento: el registro y la bitacora quedan intactos.
    assert borrados(conn) == []
    assert conn.inserts_log() == []
    assert modifican_logs(conn) == []


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_todos_los_motivos_aparecen_juntos_en_el_mensaje(pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle):
    guionar(conn, fila, con_historial=tuple(range(len(chequeos))), n_chequeos=len(chequeos))
    with pytest.raises(TieneHistorial) as info:
        await funcion(*args)
    for descripcion, _ in chequeos:
        assert descripcion in str(info.value)
    assert borrados(conn) == []


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_registro_inexistente_levanta_no_encontrado_sin_borrar_ni_loguear(
    pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle
):
    guionar(conn, None, n_chequeos=len(chequeos))
    with pytest.raises(RegistroNoEncontrado):
        await funcion(*args)
    assert borrados(conn) == []
    assert conn.inserts_log() == []
    # Ni siquiera revisa el historial de algo que no existe.
    assert conn.sql_ejecutado("as _p") == []


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_una_fk_que_salta_justo_al_borrar_se_traduce_a_tiene_historial(
    pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle
):
    """Carrera: alguien uso el registro entre el chequeo y el delete."""
    guionar(conn, fila, n_chequeos=len(chequeos))
    conn.responder("execute", "delete from", asyncpg.ForeignKeyViolationError("fk"))
    with pytest.raises(TieneHistorial) as info:
        await funcion(*args)
    assert "registros asociados" in str(info.value)
    assert conn.inserts_log() == []


@pytest.mark.parametrize(_PARAMS, CASOS)
async def test_un_error_inesperado_de_la_base_no_se_traga_ni_deja_evento(
    pool, conn, funcion, args, tabla, entidad, chequeos, fila, detalle
):
    guionar(conn, fila, n_chequeos=len(chequeos))
    conn.responder("execute", "delete from", asyncpg.PostgresError("caida"))
    with pytest.raises(asyncpg.PostgresError):
        await funcion(*args)
    assert conn.inserts_log() == []


# --------------------------------------------------------------------------
# Forma de los chequeos de historial
# --------------------------------------------------------------------------

TODAS_LAS_LISTAS = [
    borrado._CHEQUEOS_SEDE,
    borrado._CHEQUEOS_EMPLEADO,
    borrado._CHEQUEOS_PUNTO,
    borrado._CHEQUEOS_USUARIO_PUNTO,
    borrado._CHEQUEOS_SUPERVISOR,
    borrado._CHEQUEOS_TIPO,
    borrado._CHEQUEOS_USUARIO_DASHBOARD,
]


def test_los_chequeos_son_solo_lecturas_parametrizadas_por_el_id():
    for lista in TODAS_LAS_LISTAS:
        for descripcion, sql in lista:
            texto = sql.lower()
            assert texto.startswith("select 1 from "), descripcion
            assert "$1" in sql, descripcion
            for prohibida in ("delete ", "update ", "insert ", "truncate ", "drop ", ";"):
                assert prohibida not in texto, f"{descripcion}: {prohibida!r}"


def test_el_historial_de_sede_y_punto_ignora_los_admin_cambio_propios():
    """Si no, nada creado desde el panel se podria borrar nunca."""
    for lista in (borrado._CHEQUEOS_SEDE, borrado._CHEQUEOS_PUNTO):
        (sql,) = [s for d, s in lista if d == "eventos en el historial"]
        assert "evento <> 'admin_cambio'" in sql


def test_el_historial_de_usuario_dashboard_cubre_los_intentos_de_ingreso():
    sql = dict(borrado._CHEQUEOS_USUARIO_DASHBOARD)["intentos de ingreso registrados"]
    assert "entidad_tipo = 'usuario_dashboard'" in sql and "evento <> 'admin_cambio'" in sql


def test_los_tipos_se_comparan_sin_distinguir_mayusculas():
    for _, sql in borrado._CHEQUEOS_TIPO:
        assert "upper(" in sql


async def test_una_sola_consulta_con_un_exists_por_chequeo(pool, conn):
    guionar(conn, {"id": ID, "nombre": "N", "codigo": "C"}, n_chequeos=len(borrado._CHEQUEOS_SEDE))
    await borrado.eliminar_sede(ID)
    (consulta,) = conn.sql_ejecutado("as _p")
    sql = consulta[1]
    assert sql.count("exists (") == len(borrado._CHEQUEOS_SEDE)
    for _, sql_chequeo in borrado._CHEQUEOS_SEDE:
        assert sql_chequeo in sql
    assert consulta[2] == (ID,)


@pytest.mark.parametrize(
    "motivos, esperado",
    [
        (["entregas"], "No se puede eliminar: esta sede tiene entregas. Puedes desactivarla."),
        (["entregas", "turnos"], "No se puede eliminar: esta sede tiene entregas y turnos. Puedes desactivarla."),
        (
            ["entregas", "turnos", "logs"],
            "No se puede eliminar: esta sede tiene entregas, turnos y logs. Puedes desactivarla.",
        ),
    ],
)
def test_mensaje_de_historial(motivos, esperado):
    assert borrado._mensaje("esta sede", motivos, "Puedes desactivarla.") == esperado


# --------------------------------------------------------------------------
# Tipos de documento: la cache de ejemplos del prompt
# --------------------------------------------------------------------------


async def test_borrar_un_tipo_invalida_la_cache_de_ejemplos(pool, conn):
    servicio_tipos._cache = (1e12, "FEI")
    guionar(conn, {"codigo": "FEI", "descripcion": "factura"}, n_chequeos=len(borrado._CHEQUEOS_TIPO))
    await borrado.eliminar_tipo_documento("FEI")
    assert servicio_tipos._cache is None


async def test_un_tipo_con_historial_no_invalida_la_cache(pool, conn):
    servicio_tipos._cache = (1e12, "FEI")
    guionar(conn, {"codigo": "FEI", "descripcion": "factura"}, con_historial=(0,), n_chequeos=len(borrado._CHEQUEOS_TIPO))
    with pytest.raises(TieneHistorial):
        await borrado.eliminar_tipo_documento("FEI")
    assert servicio_tipos._cache == (1e12, "FEI")
    servicio_tipos.invalidar_cache()


# --------------------------------------------------------------------------
# Usuarios del dashboard
# --------------------------------------------------------------------------

N_DASH = len(borrado._CHEQUEOS_USUARIO_DASHBOARD)
ADMIN = {"id": ID, "usuario": "ana", "nombre": "Ana", "rol": "admin", "area": "todo"}


def admins_activos(conn, cantidad: int) -> None:
    """Resultado del bloqueo de admins activos (`... order by id for update`)."""
    conn.responder("fetch", "order by id for update", [{"id": f"admin-{i}"} for i in range(cantidad)])


def fila_dash(rol="supervisor", activo=True, usuario="luis", id=ID_OTRO) -> dict:
    return {"id": id, "usuario": usuario, "nombre": "Luis", "rol": rol, "activo": activo, "pass_hash": "H", "pass_salt": "S"}


async def test_usuario_dashboard_sin_historial_se_borra_y_deja_evento_a_nombre_del_actor(pool, conn):
    guionar(conn, fila_dash(), n_chequeos=N_DASH)
    await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    ((_, sql, args),) = borrados(conn)
    assert sql == "delete from usuarios_dashboard where id = $1::uuid" and args == (ID_OTRO,)
    (evento,) = conn.inserts_log()
    assert evento[:3] == ("admin_cambio", "usuario_dashboard", ID_OTRO)
    assert evento[3] == "dashboard:ana"  # el actor es quien borra, no el borrado
    assert evento[5] == "eliminado"
    assert evento[6] == {"usuario": "luis", "nombre": "Luis", "rol": "supervisor"}
    assert "H" not in evento[6].values() and "S" not in evento[6].values()
    assert modifican_logs(conn) == []


async def test_un_admin_no_puede_borrarse_a_si_mismo(pool, conn):
    guionar(conn, fila_dash(rol="admin", id=ID), n_chequeos=N_DASH)
    admins_activos(conn, 5)  # aunque haya mas admins
    with pytest.raises(ReglaBorrado, match="a ti mismo"):
        await borrado.eliminar_usuario_dashboard(ADMIN, ID)
    assert borrados(conn) == [] and conn.inserts_log() == []


async def test_un_no_admin_tampoco_puede_borrarse_a_si_mismo(pool, conn):
    actor = {**ADMIN, "rol": "admin"}
    guionar(conn, fila_dash(rol="supervisor", id=ID), n_chequeos=N_DASH)
    with pytest.raises(ReglaBorrado):
        await borrado.eliminar_usuario_dashboard(actor, ID)
    assert borrados(conn) == []


async def test_no_se_borra_al_ultimo_administrador_activo(pool, conn):
    guionar(conn, fila_dash(rol="admin"), n_chequeos=N_DASH)
    admins_activos(conn, 1)
    with pytest.raises(ReglaBorrado, match="al menos un administrador"):
        await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    assert borrados(conn) == [] and conn.inserts_log() == []


async def test_se_puede_borrar_a_otro_admin_si_queda_alguno(pool, conn):
    guionar(conn, fila_dash(rol="admin"), n_chequeos=N_DASH)
    admins_activos(conn, 2)
    await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    assert len(borrados(conn)) == 1


async def test_un_admin_inactivo_se_borra_aunque_sea_el_unico_que_queda_registrado(pool, conn):
    """La guarda cuenta admins ACTIVOS: uno inactivo no sostiene al sistema."""
    guionar(conn, fila_dash(rol="admin", activo=False), n_chequeos=N_DASH)
    admins_activos(conn, 1)
    await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    assert len(borrados(conn)) == 1


@pytest.mark.parametrize("indice", range(N_DASH))
async def test_usuario_dashboard_con_cualquier_rastro_no_se_borra(pool, conn, indice):
    guionar(conn, fila_dash(), con_historial=(indice,), n_chequeos=N_DASH)
    with pytest.raises(TieneHistorial) as info:
        await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    assert borrado._CHEQUEOS_USUARIO_DASHBOARD[indice][0] in str(info.value)
    assert "desactivarlo" in str(info.value)
    assert borrados(conn) == [] and conn.inserts_log() == []


async def test_los_admins_activos_se_bloquean_en_orden_antes_que_la_fila_objetivo(pool, conn):
    """Regresion: sin ese bloqueo, dos admins que se borran entre si a la vez
    dejaban el sistema sin administrador. El orden por id evita interbloqueos."""
    guionar(conn, fila_dash(rol="admin"), n_chequeos=N_DASH)
    admins_activos(conn, 2)
    await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    consultas = [c[1] for c in conn.llamadas]
    i_admins = next(i for i, sql in enumerate(consultas) if "rol = 'admin' and activo" in sql)
    i_objetivo = next(i for i, sql in enumerate(consultas) if sql.startswith("select * from usuarios_dashboard"))
    assert i_admins < i_objetivo
    assert "order by id for update" in consultas[i_admins]


async def test_las_guardas_se_evaluan_antes_que_el_historial(pool, conn):
    """Un intento de auto-borrado responde ReglaBorrado y no gasta la consulta de historial."""
    guionar(conn, fila_dash(id=ID), n_chequeos=N_DASH)
    with pytest.raises(ReglaBorrado):
        await borrado.eliminar_usuario_dashboard(ADMIN, ID)
    assert conn.sql_ejecutado("as _p") == []


async def test_usuario_dashboard_inexistente(pool, conn):
    guionar(conn, None, n_chequeos=N_DASH)
    with pytest.raises(RegistroNoEncontrado):
        await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    assert borrados(conn) == [] and conn.inserts_log() == []


async def test_usuario_dashboard_con_fk_en_carrera(pool, conn):
    guionar(conn, fila_dash(), n_chequeos=N_DASH)
    conn.responder("execute", "delete from", asyncpg.ForeignKeyViolationError("fk"))
    with pytest.raises(TieneHistorial):
        await borrado.eliminar_usuario_dashboard(ADMIN, ID_OTRO)
    assert conn.inserts_log() == []


# --------------------------------------------------------------------------
# HTTP: codigos de estado, mensajes y actor del log
# --------------------------------------------------------------------------

RUTAS = [
    pytest.param(f"/sedes/{ID}", borrado._CHEQUEOS_SEDE, {"id": ID, "nombre": "N", "codigo": "C"}, "Sede no encontrada", id="sede"),
    pytest.param(
        f"/empleados/{ID}", borrado._CHEQUEOS_EMPLEADO,
        {"id": ID, "nombre": "L", "rol": "operador", "sede_id": "s"}, "Empleado no encontrado", id="empleado",
    ),
    pytest.param(f"/puntos/{ID}", borrado._CHEQUEOS_PUNTO, {"id": ID, "nombre": "P", "codigo": "P"}, None, id="punto"),
    pytest.param(
        f"/puntos/usuarios/{ID}", borrado._CHEQUEOS_USUARIO_PUNTO,
        {"id": ID, "nombre": "U", "punto_id": ID_OTRO}, None, id="usuario_punto",
    ),
    pytest.param(f"/supervisores/{ID}", borrado._CHEQUEOS_SUPERVISOR, {"id": ID, "nombre": "E"}, None, id="supervisor"),
    pytest.param(
        "/tipos-documento/fei", borrado._CHEQUEOS_TIPO, {"codigo": "FEI", "descripcion": "d"}, "Tipo de documento no encontrado",
        id="tipo_documento",
    ),
]


def _admin(conn) -> dict[str, str]:
    fila = fila_usuario_dashboard(rol="admin", usuario="ana")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


@pytest.mark.parametrize("ruta, chequeos, fila, _msg", RUTAS)
async def test_http_borrado_correcto_con_sesion_admin(cliente, pool, conn, ruta, chequeos, fila, _msg):
    headers = _admin(conn)
    guionar(conn, fila, n_chequeos=len(chequeos))
    res = await cliente.delete(ruta, headers=headers)
    assert res.status_code == 200 and res.json() == {"ok": True}
    assert len(borrados(conn)) == 1
    assert conn.inserts_log()[0][3] == "dashboard:ana"
    assert conn.inserts_log()[0][5] == "eliminado"


@pytest.mark.parametrize("ruta, chequeos, fila, _msg", RUTAS)
async def test_http_borrado_con_token_legacy_queda_a_nombre_del_token(cliente, pool, conn, admin_headers, ruta, chequeos, fila, _msg):
    guionar(conn, fila, n_chequeos=len(chequeos))
    res = await cliente.delete(ruta, headers=admin_headers)
    assert res.status_code == 200
    assert conn.inserts_log()[0][3] == "dashboard:token"


@pytest.mark.parametrize("ruta, chequeos, fila, _msg", RUTAS)
async def test_http_con_historial_da_409_y_el_mensaje_explica_la_salida(cliente, pool, conn, admin_headers, ruta, chequeos, fila, _msg):
    guionar(conn, fila, con_historial=(0,), n_chequeos=len(chequeos))
    res = await cliente.delete(ruta, headers=admin_headers)
    assert res.status_code == 409
    assert res.json()["detail"].startswith("No se puede eliminar: ")
    assert "desactiv" in res.json()["detail"]
    assert borrados(conn) == [] and conn.inserts_log() == []


@pytest.mark.parametrize("ruta, chequeos, fila, mensaje", RUTAS)
async def test_http_inexistente_da_404(cliente, pool, conn, admin_headers, ruta, chequeos, fila, mensaje):
    guionar(conn, None, n_chequeos=len(chequeos))
    res = await cliente.delete(ruta, headers=admin_headers)
    assert res.status_code == 404
    if mensaje:
        assert res.json()["detail"] == mensaje
    assert borrados(conn) == []


@pytest.mark.parametrize("ruta", [f"/sedes/{ID[:-1]}", "/sedes/no-es-uuid", "/empleados/1", "/puntos/xyz", "/supervisores/%20"])
async def test_http_id_que_no_es_uuid_da_422_sin_tocar_la_base(cliente, pool, conn, admin_headers, ruta):
    res = await cliente.delete(ruta, headers=admin_headers)
    assert res.status_code == 422
    assert conn.llamadas == []


@pytest.mark.parametrize("codigo", ["ABCDEFGHIJKLM", "FE-1", "F E"])
async def test_http_tipo_con_codigo_invalido_da_422(cliente, pool, conn, admin_headers, codigo):
    res = await cliente.delete(f"/tipos-documento/{codigo}", headers=admin_headers)
    assert res.status_code == 422
    assert borrados(conn) == []


async def test_http_el_codigo_del_tipo_se_normaliza_a_mayusculas(cliente, pool, conn, admin_headers):
    guionar(conn, {"codigo": "FEI", "descripcion": "d"}, n_chequeos=len(borrado._CHEQUEOS_TIPO))
    await cliente.delete("/tipos-documento/fei", headers=admin_headers)
    assert borrados(conn)[0][2] == ("FEI",)


# --- Usuarios del dashboard por HTTP --------------------------------------


def _admin_con_id(conn, id: str) -> dict[str, str]:
    """Sesion admin. OJO con el orden: la consulta de la sesion y la del borrado
    (`... for update`) comparten el fragmento "from usuarios_dashboard where id";
    guionar primero el borrado para que su regla (mas especifica) gane."""
    fila = fila_usuario_dashboard(rol="admin", usuario="ana")
    fila["id"] = id
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


async def test_http_borrar_usuario_dashboard_con_sesion_admin(cliente, pool, conn):
    guionar(conn, fila_dash(), n_chequeos=N_DASH)
    headers = _admin_con_id(conn, ID)
    res = await cliente.delete(f"/dashboard/usuarios/{ID_OTRO}", headers=headers)
    assert res.status_code == 200 and res.json() == {"ok": True}
    assert conn.inserts_log()[0][3] == "dashboard:ana"


async def test_http_borrarse_a_si_mismo_da_409(cliente, pool, conn):
    guionar(conn, fila_dash(rol="admin", id=ID), n_chequeos=N_DASH)
    headers = _admin_con_id(conn, ID)
    admins_activos(conn, 3)
    res = await cliente.delete(f"/dashboard/usuarios/{ID}", headers=headers)
    assert res.status_code == 409 and "a ti mismo" in res.json()["detail"]
    assert borrados(conn) == []


async def test_http_borrar_al_ultimo_admin_da_409(cliente, pool, conn):
    guionar(conn, fila_dash(rol="admin"), n_chequeos=N_DASH)
    headers = _admin_con_id(conn, ID)
    admins_activos(conn, 1)
    res = await cliente.delete(f"/dashboard/usuarios/{ID_OTRO}", headers=headers)
    assert res.status_code == 409 and "al menos un administrador" in res.json()["detail"]


async def test_http_usuario_dashboard_con_historial_da_409(cliente, pool, conn):
    guionar(conn, fila_dash(), con_historial=(0,), n_chequeos=N_DASH)
    headers = _admin_con_id(conn, ID)
    res = await cliente.delete(f"/dashboard/usuarios/{ID_OTRO}", headers=headers)
    assert res.status_code == 409
    assert borrados(conn) == []


async def test_http_usuario_dashboard_inexistente_da_404(cliente, pool, conn):
    guionar(conn, None, n_chequeos=N_DASH)
    headers = _admin_con_id(conn, ID)
    res = await cliente.delete(f"/dashboard/usuarios/{ID_OTRO}", headers=headers)
    assert res.status_code == 404


async def test_http_usuario_dashboard_no_se_borra_con_token_legacy(cliente, pool, conn, admin_headers):
    res = await cliente.delete(f"/dashboard/usuarios/{ID_OTRO}", headers=admin_headers)
    assert res.status_code == 401
    assert conn.llamadas == []


@pytest.mark.parametrize("rol", ["supervisor", "consulta"])
async def test_http_usuario_dashboard_no_lo_borra_un_no_admin(cliente, pool, conn, rol):
    fila = fila_usuario_dashboard(rol=rol)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.delete(f"/dashboard/usuarios/{ID_OTRO}", headers=encabezado_bearer(fila))
    assert res.status_code == 403
    assert borrados(conn) == []


# --------------------------------------------------------------------------
# Producto del catalogo (borrado sin historial: no hay FKs)
# --------------------------------------------------------------------------


async def test_borrar_producto_deja_evento_con_codigo_y_nombre(cliente, pool, conn):
    fila = fila_usuario_dashboard(rol="supervisor", area="bodega", usuario="luis")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    conn.responder("fetchrow", "delete from productos", {"codigo": "12345", "nombre": "SAL"})
    res = await cliente.delete(f"/productos/{ID}", headers=encabezado_bearer(fila))
    assert res.status_code == 200 and res.json() == {"ok": True}
    (evento,) = conn.inserts_log()
    assert evento[:3] == ("admin_cambio", "producto", ID)
    assert evento[3] == "dashboard:luis" and evento[5] == "eliminado"
    assert evento[6] == {"codigo": "12345", "nombre": "SAL"}


async def test_borrar_producto_inexistente_da_404_sin_evento(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "delete from productos", None)
    res = await cliente.delete(f"/productos/{ID}", headers=admin_headers)
    assert res.status_code == 404
    assert conn.inserts_log() == []
