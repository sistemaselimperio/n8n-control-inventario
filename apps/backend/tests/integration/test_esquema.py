"""El esquema real (`ensure_schema()`) sobre un Postgres comun, sin extensiones
de Supabase, y sus restricciones de base de datos."""

import asyncpg
import pytest

from app import db
from app.models.empleado import RolEmpleado
from app.models.entrega import EstadoEntrega
from tests.integration.conftest import crear_entrega

pytestmark = pytest.mark.integration

INSERT_ENTREGA = """
    insert into entregas (tipo, indicativo_numero, hash_evidencia, sede_origen_id, estado,
                          evidencia_url, operador_id, capturado_at)
    values ($1, $2, $3, 's', $4, 'u', 'o', now())
"""


async def test_ensure_schema_es_idempotente(pg):
    await db.ensure_schema()
    await db.ensure_schema()
    tipos = await pg.fetchval("select count(*) from tipos_documento")
    assert tipos == 8  # la semilla no se duplica


async def test_esquema_aplica_sin_publicacion_de_supabase(pg):
    """En un Postgres comun la publicacion no existe y el bloque realtime no hace nada."""
    assert await pg.fetchval("select count(*) from pg_publication where pubname = 'supabase_realtime'") == 0


async def test_con_publicacion_de_supabase_agrega_las_tablas_y_tolera_repetir(pg):
    try:
        await pg.execute("create publication supabase_realtime")
    except asyncpg.InsufficientPrivilegeError:
        pytest.skip("El usuario de prueba no puede crear publicaciones")
    try:
        await db.ensure_schema()
        await db.ensure_schema()  # las tablas ya estan: duplicate_object se ignora
        en_publicacion = {
            f["tablename"]
            for f in await pg.fetch("select tablename from pg_publication_tables where pubname = 'supabase_realtime'")
        }
        assert {"entregas", "entrega_items", "logs"} <= en_publicacion
        # Las credenciales del dashboard nunca viajan por realtime.
        assert "usuarios_dashboard" not in en_publicacion
    finally:
        await pg.execute("drop publication if exists supabase_realtime")


@pytest.mark.parametrize("estado", [e.value for e in EstadoEntrega])
async def test_todos_los_estados_del_enum_los_acepta_la_base(pg, estado):
    await pg.execute(INSERT_ENTREGA, "XYZ", "1", "h1", estado)


async def test_estado_fuera_del_enum_lo_rechaza_la_base(pg):
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute(INSERT_ENTREGA, "XYZ", "1", "h1", "inventado")


async def test_unique_tipo_indicativo_es_la_barrera_anti_duplicado(pg):
    await pg.execute(INSERT_ENTREGA, "XYZ", "1", "h1", "procesada")
    with pytest.raises(asyncpg.UniqueViolationError) as info:
        await pg.execute(INSERT_ENTREGA, "XYZ", "1", "h2", "procesada")
    assert info.value.constraint_name == "entregas_tipo_indicativo_numero_key"
    # Otro numero o otro tipo si pueden coexistir.
    await pg.execute(INSERT_ENTREGA, "XYZ", "2", "h3", "procesada")
    await pg.execute(INSERT_ENTREGA, "ABC", "1", "h4", "procesada")


async def test_unique_de_hash_evidencia_tiene_el_nombre_que_espera_la_app(pg):
    await pg.execute(INSERT_ENTREGA, "XYZ", "1", "mismo-hash", "procesada")
    with pytest.raises(asyncpg.UniqueViolationError) as info:
        await pg.execute(INSERT_ENTREGA, "XYZ", "2", "mismo-hash", "procesada")
    # duplicates.py decide como buscar la fila existente leyendo este nombre.
    assert info.value.constraint_name == "entregas_hash_evidencia_key"


@pytest.mark.parametrize("rol", [r.value for r in RolEmpleado])
async def test_todos_los_roles_del_enum_los_acepta_la_base(pg, rol):
    await pg.execute("insert into empleados (nombre, sede_id, rol) values ('A', 's', $1)", rol)


async def test_rol_desconocido_lo_rechaza_la_base(pg):
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute("insert into empleados (nombre, sede_id, rol) values ('A', 's', 'dios')")


async def test_borrar_la_entrega_borra_sus_items_pero_no_los_logs(pg):
    entrega_id, _ = await crear_entrega(pg)
    await pg.execute(
        "insert into logs (evento, entidad_tipo, entidad_id, actor_id, sede_id, resultado)"
        " values ('x', 'entrega', $1, 'a', 's', 'ok')",
        entrega_id,
    )
    await pg.execute("delete from entregas where id = $1::uuid", entrega_id)
    assert await pg.fetchval("select count(*) from entrega_items") == 0
    assert await pg.fetchval("select count(*) from logs") == 1
