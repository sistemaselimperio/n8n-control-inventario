"""Scripts de mantenimiento contra Postgres real (solo la base desechable de
prueba: `limpiar_datos` borra de verdad)."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

from scripts import generar_turnos, limpiar_datos
from tests.integration.conftest import crear_entrega
from tests.integration.datos_admin import (
    insertar_devolucion,
    insertar_factura_faltante,
    insertar_log,
    insertar_no_entregado,
    nueva_sede,
    nuevo_empleado,
)

pytestmark = pytest.mark.integration


def _url() -> str:
    return os.environ["TEST_DATABASE_URL"]


# --------------------------------------------------------------------------
# limpiar_datos
# --------------------------------------------------------------------------


async def test_limpiar_datos_vacia_entregas_y_logs_sin_tocar_el_resto(pg):
    """Regresion: el script hacia `truncate table entregas, logs`, que Postgres
    rechaza (entrega_items, devoluciones... referencian a entregas por FK), asi
    que nunca limpiaba nada."""
    sede = await nueva_sede(pg)
    await nuevo_empleado(pg, sede)
    await pg.execute("insert into productos (codigo, nombre) values ('12345', 'SAL')")
    await pg.execute(
        "insert into turnos (empleado_id, sede_id, fecha, hora_inicio, hora_fin) values ('e', $1, '2026-03-05', '08:00', '12:00')",
        sede,
    )
    await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ($1, '2026-W10')", sede)
    entrega_id, _ = await crear_entrega(pg, numero="1")
    await insertar_devolucion(pg)
    await insertar_no_entregado(pg)
    await insertar_factura_faltante(pg)
    await pg.execute("update facturas_faltantes set entrega_id = $1::uuid", entrega_id)
    await insertar_log(pg)

    await limpiar_datos.vaciar_tablas(_url())

    assert await pg.fetchval("select count(*) from entregas") == 0
    assert await pg.fetchval("select count(*) from entrega_items") == 0
    assert await pg.fetchval("select count(*) from devoluciones") == 0
    assert await pg.fetchval("select count(*) from items_no_entregados") == 0
    assert await pg.fetchval("select count(*) from logs") == 0
    # Lo que NO es entregas/logs sigue ahi, incluida la factura faltante
    # (solo pierde la referencia a la entrega borrada).
    assert await pg.fetchval("select count(*) from sedes") == 1
    assert await pg.fetchval("select count(*) from empleados") == 1
    assert await pg.fetchval("select count(*) from productos") == 1
    assert await pg.fetchval("select count(*) from turnos") == 1
    assert await pg.fetchval("select count(*) from shift_recommendations") == 1
    assert await pg.fetchval("select count(*) from facturas_faltantes") == 1
    assert await pg.fetchval("select entrega_id from facturas_faltantes") is None


async def test_limpiar_datos_sobre_una_base_vacia_no_falla(pg):
    await limpiar_datos.vaciar_tablas(_url())
    assert await pg.fetchval("select count(*) from entregas") == 0


async def test_limpiar_datos_es_todo_o_nada(pg, monkeypatch):
    """Si algo falla a mitad, no queda la base a medio limpiar."""
    await crear_entrega(pg, numero="1")
    await insertar_log(pg)

    original = limpiar_datos.asyncpg.connect

    class ConexionConFallo:
        """Proxy de la conexion real que falla al vaciar logs (la 2.a sentencia)."""

        def __init__(self, conn) -> None:
            self._conn = conn

        def __getattr__(self, nombre):
            return getattr(self._conn, nombre)

        async def execute(self, sql, *args):
            if sql.lstrip().lower().startswith("truncate"):
                raise RuntimeError("falla simulada al vaciar logs")
            return await self._conn.execute(sql, *args)

    async def conectar_con_fallo(url):
        return ConexionConFallo(await original(url))

    monkeypatch.setattr(limpiar_datos.asyncpg, "connect", conectar_con_fallo)
    with pytest.raises(RuntimeError):
        await limpiar_datos.vaciar_tablas(_url())
    assert await pg.fetchval("select count(*) from entregas") == 1
    assert await pg.fetchval("select count(*) from logs") == 1
