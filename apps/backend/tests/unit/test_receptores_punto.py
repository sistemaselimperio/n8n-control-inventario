"""Receptores por punto (personas que reciben traslados en cada punto): modelo,
servicio (app/services/receptores_punto.py) y endpoints, con la base simulada.
La validacion al confirmar/devolver esta en test_traslados_servicio_nuevo.py."""

import uuid
from datetime import UTC, datetime

import asyncpg
import pytest
from pydantic import ValidationError

from app.models.receptor_punto import ReceptorActualizar, ReceptorCrear, normalizar_cedula
from app.services import receptores_punto as svc
from app.services import traslados_reglas as r
from app.services.permisos_traslados import perfil_de
from app.services.usuarios import DatoInvalido, RegistroNoEncontrado
from tests.fakes import violacion_unica
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

PUNTO = str(uuid.uuid4())
OTRO_PUNTO = str(uuid.uuid4())
RECEPTOR = str(uuid.uuid4())


def fila_receptor(**extra) -> dict:
    fila = {
        "id": uuid.UUID(RECEPTOR), "punto_id": uuid.UUID(PUNTO), "nombre": "Luis Pérez", "cedula": "1234567",
        "activo": True, "creado_at": datetime(2026, 1, 15, tzinfo=UTC), "punto_nombre": "NVL — Villa de Leyva",
    }
    fila.update(extra)
    return fila


# --------------------------- cedula ---------------------------


@pytest.mark.parametrize(
    "crudo, esperado",
    [("1234567", "1234567"), ("1.234.567", "1234567"), (" 12 345-678 ", "12345678"), ("00123456", "00123456")],
)
def test_la_cedula_se_normaliza_a_solo_digitos(crudo, esperado):
    assert normalizar_cedula(crudo) == esperado


@pytest.mark.parametrize("crudo", ["", "   ", "1234", "1" * 16, "12a4567", "ABC", "12,345,678"])
def test_una_cedula_invalida_se_rechaza(crudo):
    with pytest.raises(ValueError):
        normalizar_cedula(crudo)


def test_el_modelo_de_alta_normaliza_y_limpia():
    modelo = ReceptorCrear(punto_id=PUNTO, nombre="  Luis   Pérez ", cedula="1.234.567")
    assert modelo.nombre == "Luis Pérez" and modelo.cedula == "1234567" and modelo.punto_id == PUNTO


@pytest.mark.parametrize(
    "cuerpo",
    [
        {"punto_id": "x", "nombre": "A", "cedula": "1234567"},
        {"punto_id": PUNTO, "nombre": "   ", "cedula": "1234567"},
        {"punto_id": PUNTO, "nombre": "A" * 121, "cedula": "1234567"},
        {"punto_id": PUNTO, "nombre": "A", "cedula": "12"},
    ],
)
def test_el_modelo_de_alta_rechaza_datos_invalidos(cuerpo):
    with pytest.raises(ValidationError):
        ReceptorCrear(**cuerpo)


def test_la_edicion_solo_trae_lo_enviado():
    modelo = ReceptorActualizar(cedula="1.234.567", activo=False)
    assert modelo.model_dump(exclude_unset=True) == {"cedula": "1234567", "activo": False}


# --------------------------- listar activos de un punto ---------------------------


def _perfil(rol="supervisor", area="traslados", punto_id=None):
    return perfil_de(
        {"id": str(uuid.uuid4()), "usuario": "ana", "nombre": "Ana", "rol": rol, "area": area, "punto_id": punto_id,
         "cedula": None}
    )


async def test_lista_solo_los_activos_del_punto_ordenados(pool, conn):
    conn.responder("fetch", "from receptores_punto", [fila_receptor()])
    res = await svc.listar_activos_de_punto(_perfil(punto_id=PUNTO), PUNTO)
    assert res == [{"id": RECEPTOR, "nombre": "Luis Pérez", "cedula": "1234567"}]
    (_, sql, args) = conn.llamadas[0]
    assert "activo = true" in sql and "order by" in sql and args == (PUNTO,)


async def test_un_perfil_de_otro_punto_no_ve_los_receptores(pool, conn):
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.listar_activos_de_punto(_perfil(punto_id=OTRO_PUNTO), PUNTO)
    assert conn.llamadas == []


async def test_la_encargada_ve_los_receptores_de_cualquier_punto(pool, conn):
    conn.responder("fetch", "from receptores_punto", [])
    assert await svc.listar_activos_de_punto(_perfil(), PUNTO) == []


# --------------------------- resolver receptor (confirmar / devolver) ---------------------------


async def test_receptor_de_la_lista_devuelve_su_nombre_y_cedula(pool, conn):
    conn.responder("fetchrow", "from receptores_punto where id", fila_receptor())
    res = await svc.resolver_receptor(conn, PUNTO, receptor_id=RECEPTOR, nombre=None, cedula=None)
    assert res == {"receptor_id": RECEPTOR, "nombre": "Luis Pérez", "cedula": "1234567", "fuera_de_lista": False}


@pytest.mark.parametrize(
    "fila",
    [None, fila_receptor(activo=False), fila_receptor(punto_id=uuid.UUID(OTRO_PUNTO))],
    ids=["no existe", "inactivo", "de otro punto"],
)
async def test_receptor_que_no_sirve_es_dato_invalido(pool, conn, fila):
    conn.responder("fetchrow", "from receptores_punto where id", fila)
    with pytest.raises(r.DatoInvalido):
        await svc.resolver_receptor(conn, PUNTO, receptor_id=RECEPTOR, nombre=None, cedula=None)


async def test_receptor_con_id_que_no_es_uuid_es_dato_invalido(pool, conn):
    with pytest.raises(r.DatoInvalido):
        await svc.resolver_receptor(conn, PUNTO, receptor_id="no-es-uuid", nombre=None, cedula=None)
    assert conn.llamadas == []


async def test_otra_persona_normaliza_la_cedula_y_no_toca_la_base(pool, conn):
    res = await svc.resolver_receptor(conn, PUNTO, receptor_id=None, nombre="  Marta   Ríos ", cedula="52.123.456")
    assert res == {"receptor_id": None, "nombre": "Marta Ríos", "cedula": "52123456", "fuera_de_lista": True}
    assert conn.llamadas == []  # nunca se agrega a la lista


@pytest.mark.parametrize(
    "kwargs",
    [
        {},  # no eligio a nadie
        {"nombre": "Marta"},  # falta la cedula
        {"cedula": "52123456"},  # falta el nombre
        {"nombre": "   ", "cedula": "52123456"},
        {"nombre": "Marta", "cedula": "12"},  # cedula invalida
        {"nombre": "M" * 121, "cedula": "52123456"},
        {"receptor_id": RECEPTOR, "nombre": "Marta", "cedula": "52123456"},  # los dos modos
        {"receptor_id": RECEPTOR, "nombre": "Marta"},
        {"receptor_id": RECEPTOR, "cedula": "52123456"},
    ],
)
async def test_hay_que_elegir_exactamente_un_modo(pool, conn, kwargs):
    base = {"receptor_id": None, "nombre": None, "cedula": None}
    with pytest.raises(r.DatoInvalido):
        await svc.resolver_receptor(conn, PUNTO, **{**base, **kwargs})


# --------------------------- admin: listar ---------------------------


async def test_admin_lista_con_nombre_de_punto_y_filtros(pool, conn):
    conn.responder("fetch", "from receptores_punto", [fila_receptor()])
    res = await svc.listar(punto_id=PUNTO, incluir_inactivos=True)
    assert res[0]["id"] == RECEPTOR and res[0]["punto_id"] == PUNTO and res[0]["punto_nombre"] == "NVL — Villa de Leyva"
    (_, sql, args) = conn.llamadas[0]
    assert "activo = true" not in sql and args == (PUNTO,)


async def test_admin_lista_por_defecto_solo_activos(pool, conn):
    conn.responder("fetch", "from receptores_punto", [])
    await svc.listar(punto_id=None, incluir_inactivos=False)
    (_, sql, args) = conn.llamadas[0]
    assert "activo = true" in sql and args == ()


# --------------------------- admin: crear / editar / eliminar ---------------------------


async def test_crear_inserta_y_registra_el_cambio_sin_cedula(pool, conn):
    conn.responder("fetchrow", "insert into receptores_punto", fila_receptor())
    res = await svc.crear(ReceptorCrear(punto_id=PUNTO, nombre="Luis Pérez", cedula="1.234.567"))
    assert res["id"] == RECEPTOR
    (_, sql, args) = conn.sql_ejecutado("insert into receptores_punto")[0]
    assert args == (PUNTO, "Luis Pérez", "1234567")
    assert conn.eventos_log() == ["admin_cambio"]
    detalle = conn.inserts_log()[0][6]
    assert detalle["nombre"] == "Luis Pérez" and detalle["punto_id"] == PUNTO
    assert "1234567" not in str(detalle)  # la cedula no viaja al log del catalogo


async def test_crear_duplicado_es_dato_invalido_con_mensaje_claro(pool, conn):
    conn.responder("fetchrow", "insert into receptores_punto", violacion_unica("receptores_punto_punto_id_cedula_key"))
    with pytest.raises(DatoInvalido, match="cédula"):
        await svc.crear(ReceptorCrear(punto_id=PUNTO, nombre="Luis", cedula="1234567"))
    assert conn.eventos_log() == []


async def test_crear_en_un_punto_inexistente_es_dato_invalido(pool, conn):
    conn.responder("fetchrow", "insert into receptores_punto", asyncpg.ForeignKeyViolationError("fk"))
    with pytest.raises(DatoInvalido, match="punto"):
        await svc.crear(ReceptorCrear(punto_id=PUNTO, nombre="Luis", cedula="1234567"))


async def test_actualizar_aplica_solo_lo_enviado(pool, conn):
    conn.responder("fetchrow", "update receptores_punto set", fila_receptor(activo=False))
    cambios = ReceptorActualizar(activo=False)
    res = await svc.actualizar(RECEPTOR, cambios)
    assert res["activo"] is False
    (_, sql, args) = conn.sql_ejecutado("update receptores_punto set")[0]
    assert "activo = $2" in sql and "nombre" not in sql.split("where")[0] and args == (RECEPTOR, False)
    assert conn.inserts_log()[0][5] == "actualizado"


async def test_actualizar_cedula_registra_que_cambio_pero_no_el_valor(pool, conn):
    conn.responder("fetchrow", "update receptores_punto set", fila_receptor(cedula="7654321"))
    await svc.actualizar(RECEPTOR, ReceptorActualizar(cedula="7.654.321", punto_id=OTRO_PUNTO))
    detalle = conn.inserts_log()[0][6]
    assert detalle == {"cedula_cambiada": True, "punto_id": OTRO_PUNTO}


async def test_actualizar_sin_cambios_devuelve_la_fila_sin_escribir(pool, conn):
    conn.responder("fetchrow", "from receptores_punto", fila_receptor())
    res = await svc.actualizar(RECEPTOR, ReceptorActualizar())
    assert res["id"] == RECEPTOR and conn.sql_ejecutado("update receptores_punto") == []
    assert conn.eventos_log() == []


async def test_actualizar_inexistente_es_no_encontrado(pool, conn):
    conn.responder("fetchrow", "update receptores_punto set", None)
    with pytest.raises(RegistroNoEncontrado):
        await svc.actualizar(RECEPTOR, ReceptorActualizar(nombre="Otro"))


async def test_actualizar_a_cedula_repetida_es_dato_invalido(pool, conn):
    conn.responder("fetchrow", "update receptores_punto set", violacion_unica("receptores_punto_punto_id_cedula_key"))
    with pytest.raises(DatoInvalido, match="cédula"):
        await svc.actualizar(RECEPTOR, ReceptorActualizar(cedula="1234567"))


async def test_eliminar_borra_de_verdad_y_deja_el_evento(pool, conn):
    conn.responder("fetchrow", "delete from receptores_punto", fila_receptor())
    await svc.eliminar(RECEPTOR)
    assert conn.inserts_log()[0][5] == "eliminado"
    assert conn.inserts_log()[0][6] == {"nombre": "Luis Pérez", "punto_id": PUNTO}


async def test_eliminar_inexistente_es_no_encontrado(pool, conn):
    conn.responder("fetchrow", "delete from receptores_punto", None)
    with pytest.raises(RegistroNoEncontrado):
        await svc.eliminar(RECEPTOR)
    assert conn.eventos_log() == []


# --------------------------- endpoints de administracion ---------------------------


def _sesion(conn, **kwargs) -> dict:
    """Sesion de un usuario del dashboard; reemplaza la anterior del mismo test."""
    fila = fila_usuario_dashboard(**kwargs)
    conn._reglas = [x for x in conn._reglas if x[1] != "from usuarios_dashboard where id"]
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def _admin(conn) -> dict:
    return _sesion(conn, rol="admin", area="todo")


ADMIN_RUTAS = [
    ("get", "/receptores-punto", None),
    ("post", "/receptores-punto", {"punto_id": PUNTO, "nombre": "Luis", "cedula": "1234567"}),
    ("patch", f"/receptores-punto/{RECEPTOR}", {"activo": False}),
    ("delete", f"/receptores-punto/{RECEPTOR}", None),
]


@pytest.mark.parametrize("metodo, ruta, cuerpo", ADMIN_RUTAS)
async def test_el_admin_es_obligatorio(cliente, pool, conn, metodo, ruta, cuerpo):
    assert (await getattr(cliente, metodo)(ruta, **({"json": cuerpo} if cuerpo else {}))).status_code == 401
    supervisor = _sesion(conn, rol="supervisor", area="traslados")
    res = await getattr(cliente, metodo)(ruta, headers=supervisor, **({"json": cuerpo} if cuerpo else {}))
    assert res.status_code == 403


async def test_get_lista_con_el_token_legacy_y_filtros(cliente, pool, conn, admin_headers):
    conn.responder("fetch", "from receptores_punto", [fila_receptor()])
    res = await cliente.get("/receptores-punto", params={"punto_id": PUNTO, "incluir_inactivos": "true"}, headers=admin_headers)
    assert res.status_code == 200 and res.json()[0]["nombre"] == "Luis Pérez"


async def test_get_con_punto_invalido_es_422(cliente, pool, conn):
    res = await cliente.get("/receptores-punto", params={"punto_id": "x"}, headers=_admin(conn))
    assert res.status_code == 422


async def test_post_crea_con_201(cliente, pool, conn):
    conn.responder("fetchrow", "insert into receptores_punto", fila_receptor())
    res = await cliente.post(
        "/receptores-punto", json={"punto_id": PUNTO, "nombre": "Luis Pérez", "cedula": "1.234.567"}, headers=_admin(conn)
    )
    assert res.status_code == 201 and res.json()["id"] == RECEPTOR


async def test_post_con_cedula_invalida_es_422(cliente, pool, conn):
    res = await cliente.post(
        "/receptores-punto", json={"punto_id": PUNTO, "nombre": "Luis", "cedula": "12"}, headers=_admin(conn)
    )
    assert res.status_code == 422


async def test_post_duplicado_es_409_amigable(cliente, pool, conn):
    conn.responder("fetchrow", "insert into receptores_punto", violacion_unica("receptores_punto_punto_id_cedula_key"))
    res = await cliente.post(
        "/receptores-punto", json={"punto_id": PUNTO, "nombre": "Luis", "cedula": "1234567"}, headers=_admin(conn)
    )
    assert res.status_code == 409 and "cédula" in res.json()["detail"]


async def test_patch_actualiza_y_404_si_no_existe(cliente, pool, conn):
    conn.responder("fetchrow", "update receptores_punto set", fila_receptor(nombre="Nuevo"), None)
    cabeceras = _admin(conn)
    ok = await cliente.patch(f"/receptores-punto/{RECEPTOR}", json={"nombre": "Nuevo"}, headers=cabeceras)
    assert ok.status_code == 200 and ok.json()["nombre"] == "Nuevo"
    falta = await cliente.patch(f"/receptores-punto/{RECEPTOR}", json={"nombre": "Nuevo"}, headers=cabeceras)
    assert falta.status_code == 404


async def test_delete_borra_y_404_si_no_existe(cliente, pool, conn):
    conn.responder("fetchrow", "delete from receptores_punto", fila_receptor(), None)
    cabeceras = _admin(conn)
    assert (await cliente.delete(f"/receptores-punto/{RECEPTOR}", headers=cabeceras)).json() == {"ok": True}
    assert (await cliente.delete(f"/receptores-punto/{RECEPTOR}", headers=cabeceras)).status_code == 404


# --------------------------- endpoint de lectura para el modal ---------------------------


async def test_get_receptores_de_un_punto_por_perfil(cliente, pool, conn):
    conn.responder("fetch", "from receptores_punto", [fila_receptor()])
    ruta = f"/traslados/puntos/{PUNTO}/receptores"
    propio = await cliente.get(ruta, headers=_sesion(conn, rol="supervisor", area="traslados", punto_id=PUNTO))
    assert propio.status_code == 200 and propio.json() == [{"id": RECEPTOR, "nombre": "Luis Pérez", "cedula": "1234567"}]
    ajeno = await cliente.get(ruta, headers=_sesion(conn, rol="supervisor", area="traslados", punto_id=OTRO_PUNTO))
    assert ajeno.status_code == 404
    encargada = await cliente.get(ruta, headers=_sesion(conn, rol="supervisor", area="traslados"))
    assert encargada.status_code == 200
    bodega = await cliente.get(ruta, headers=_sesion(conn, rol="supervisor", area="bodega"))
    assert bodega.status_code == 403
    assert (await cliente.get(ruta)).status_code == 401
    assert (await cliente.get("/traslados/puntos/x/receptores", headers=_sesion(conn))).status_code == 422
