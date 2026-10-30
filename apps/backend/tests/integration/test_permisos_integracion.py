"""Permisos del dashboard contra Postgres real: el usuario se lee de la tabla
en CADA peticion, asi que una baja, un cambio de rol o de area rige al
instante aunque el token siga vigente."""

from __future__ import annotations

import time
from uuid import uuid4

import pytest

from app.services.sesion_dashboard import crear_token, obtener_secreto
from tests.helpers import fila_usuario_dashboard

pytestmark = pytest.mark.integration


async def crear_usuario(pg, usuario: str, rol: str, area: str = "todo", activo: bool = True) -> tuple[str, dict[str, str]]:
    fila = fila_usuario_dashboard(usuario=usuario, rol=rol, area=area)
    id_ = str(
        await pg.fetchval(
            """
            insert into usuarios_dashboard (usuario, nombre, rol, area, pass_hash, pass_salt, activo)
            values ($1, 'Nombre', $2, $3, $4, $5, $6) returning id
            """,
            usuario, rol, area, fila["pass_hash"], fila["pass_salt"], activo,
        )
    )
    token, _ = crear_token(id_, obtener_secreto())
    return id_, {"Authorization": f"Bearer {token}"}


PRODUCTO = {"codigo": "12345", "nombre": "Sal"}


@pytest.mark.parametrize(
    "rol, area, productos, borrar_sede, ver_usuarios",
    [
        ("admin", "todo", 201, 404, 200),
        ("admin", "traslados", 201, 404, 200),  # el admin siempre actua como "todo"
        ("supervisor", "todo", 201, 403, 403),
        ("supervisor", "bodega", 201, 403, 403),
        ("supervisor", "traslados", 403, 403, 403),
        ("consulta", "todo", 403, 403, 403),
        ("consulta", "bodega", 403, 403, 403),
    ],
)
async def test_matriz_con_usuarios_reales(cliente, pg, rol, area, productos, borrar_sede, ver_usuarios):
    _, headers = await crear_usuario(pg, "usuario1", rol, area)
    assert (await cliente.post("/productos", json=PRODUCTO, headers=headers)).status_code == productos
    # Una sede inexistente: el admin llega al servicio (404), los demas ni eso (403).
    assert (await cliente.delete(f"/sedes/{uuid4()}", headers=headers)).status_code == borrar_sede
    assert (await cliente.get("/dashboard/usuarios", headers=headers)).status_code == ver_usuarios
    # Cualquier sesion vigente ve su propio perfil.
    yo = await cliente.get("/dashboard/auth/yo", headers=headers)
    assert yo.status_code == 200 and yo.json()["rol"] == rol


async def test_desactivar_a_un_usuario_le_quita_la_sesion_al_instante(cliente, pg):
    id_, headers = await crear_usuario(pg, "ana", "admin")
    assert (await cliente.get("/dashboard/auth/yo", headers=headers)).status_code == 200
    await pg.execute("update usuarios_dashboard set activo = false where id = $1::uuid", id_)
    assert (await cliente.get("/dashboard/auth/yo", headers=headers)).status_code == 401
    assert (await cliente.delete(f"/sedes/{uuid4()}", headers=headers)).status_code == 401


async def test_un_usuario_inactivo_desde_el_inicio_no_entra_con_un_token_valido(cliente, pg):
    _, headers = await crear_usuario(pg, "inactivo", "admin", activo=False)
    assert (await cliente.get("/dashboard/auth/yo", headers=headers)).status_code == 401


async def test_borrar_a_un_usuario_le_quita_la_sesion(cliente, pg):
    id_, headers = await crear_usuario(pg, "luis", "supervisor")
    await pg.execute("delete from usuarios_dashboard where id = $1::uuid", id_)
    assert (await cliente.get("/dashboard/auth/yo", headers=headers)).status_code == 401


async def test_degradar_el_rol_rige_de_inmediato_con_el_mismo_token(cliente, pg):
    id_, headers = await crear_usuario(pg, "ana", "admin")
    assert (await cliente.get("/dashboard/usuarios", headers=headers)).status_code == 200
    await pg.execute("update usuarios_dashboard set rol = 'consulta' where id = $1::uuid", id_)
    assert (await cliente.get("/dashboard/usuarios", headers=headers)).status_code == 403
    assert (await cliente.get("/dashboard/auth/yo", headers=headers)).json()["rol"] == "consulta"


async def test_cambiar_el_area_rige_de_inmediato(cliente, pg):
    id_, headers = await crear_usuario(pg, "luis", "supervisor", "bodega")
    assert (await cliente.post("/productos", json=PRODUCTO, headers=headers)).status_code == 201
    await pg.execute("update usuarios_dashboard set area = 'traslados' where id = $1::uuid", id_)
    assert (await cliente.post("/productos", json={"codigo": "99999", "nombre": "X"}, headers=headers)).status_code == 403
    assert await pg.fetchval("select count(*) from productos") == 1


async def test_un_token_de_un_usuario_no_sirve_para_otro(cliente, pg):
    _, headers_ana = await crear_usuario(pg, "ana", "admin")
    id_luis, _ = await crear_usuario(pg, "luis", "consulta")
    yo = await cliente.get("/dashboard/auth/yo", headers=headers_ana)
    assert yo.json()["usuario"] == "ana"
    # Quien conoce solo el id de otro no puede fabricar su token sin el secreto.
    falso, _ = crear_token(id_luis, "secreto-que-no-es")
    res = await cliente.get("/dashboard/auth/yo", headers={"Authorization": f"Bearer {falso}"})
    assert res.status_code == 401


async def test_token_vencido_no_sirve_aunque_el_usuario_exista(cliente, pg):
    id_, _ = await crear_usuario(pg, "ana", "admin")
    vencido, _ = crear_token(id_, obtener_secreto(), ahora=time.time() - 9 * 3600)
    res = await cliente.get("/dashboard/auth/yo", headers={"Authorization": f"Bearer {vencido}"})
    assert res.status_code == 401


async def test_el_actor_del_log_es_el_de_la_sesion_y_no_se_puede_suplantar(cliente, pg):
    _, headers = await crear_usuario(pg, "ana", "admin")
    sede = str(await pg.fetchval("insert into sedes (nombre, codigo) values ('N', 'C') returning id"))
    res = await cliente.delete(f"/sedes/{sede}", params={"actor_id": "otra-persona"}, headers=headers)
    assert res.status_code == 200
    assert await pg.fetchval("select actor_id from logs where resultado = 'eliminado'") == "dashboard:ana"


async def test_el_borrado_de_entregas_con_sesion_ignora_el_actor_que_manda_el_cliente(cliente, pg):
    _, headers = await crear_usuario(pg, "ana", "admin")
    res = await cliente.delete("/entregas/todas", params={"actor_id": "otra-persona"}, headers=headers)
    assert res.status_code == 200
    assert await pg.fetchval("select actor_id from logs where evento = 'limpieza_total'") == "dashboard:ana"
