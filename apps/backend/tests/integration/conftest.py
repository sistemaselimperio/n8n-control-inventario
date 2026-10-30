"""Fixtures de integracion: Postgres real indicado en TEST_DATABASE_URL.

Estas pruebas aplican el `ensure_schema()` verdadero y vacian las tablas entre
tests. Sin TEST_DATABASE_URL se omiten (skip), no fallan. En CI la variable
apunta al contenedor de Postgres del workflow; en local se puede usar un
Postgres desechable (nunca una base con datos reales: se TRUNCA).
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio

from app import db
from app.config import get_settings


def _url_de_prueba() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.skip("TEST_DATABASE_URL no esta definida: pruebas de integracion omitidas")
    # Red de seguridad: estas pruebas truncan tablas. Jamas contra Supabase.
    if "supabase" in url.lower():
        pytest.fail("TEST_DATABASE_URL apunta a Supabase; use un Postgres desechable")
    return url


@pytest_asyncio.fixture
async def pg(monkeypatch: pytest.MonkeyPatch):
    """Pool real contra la base de prueba, con el esquema aplicado y las tablas
    vacias. Reemplaza el singleton `app.db._pool` para que la app use ESTA base."""
    url = _url_de_prueba()
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    db._pool = None
    try:
        await db.ensure_schema()
        pool = await db.get_pool()
        tablas = await pool.fetch("select tablename from pg_tables where schemaname = 'public'")
        # Se vacian TODAS las tablas, incluidas las que ensure_schema() siembra
        # (tipos_documento): antes esa se dejaba intacta y un test que agregaba o
        # borraba un tipo contaminaba a los siguientes.
        a_vaciar = [f'"{t["tablename"]}"' for t in tablas]
        if a_vaciar:
            await pool.execute(f"truncate table {', '.join(a_vaciar)} restart identity cascade")
        await db.ensure_schema()  # idempotente: vuelve a sembrar las tablas semilla
        yield pool
    finally:
        await db.close_pool()
        get_settings.cache_clear()


async def crear_entrega(
    pool, *, tipo: str = "XYZ", numero: str = "1", hash_evidencia: str | None = None,
    pendientes: tuple[int, ...] = (10,), estado: str = "procesada",
) -> tuple[str, list[str]]:
    """Inserta una entrega con items recien creados (sin confirmar) y devuelve
    (entrega_id, [item_id...])."""
    entrega_id = await pool.fetchval(
        """
        insert into entregas (tipo, indicativo_numero, hash_evidencia, sede_origen_id, estado,
                              evidencia_url, operador_id, capturado_at)
        values ($1, $2, $3, 'sede-x', $4, 'https://evidencia.prueba/f.webp', 'op', now())
        returning id
        """,
        tipo, numero, hash_evidencia or f"hash-{tipo}-{numero}", estado,
    )
    items = []
    for n, pendiente in enumerate(pendientes):
        items.append(
            str(
                await pool.fetchval(
                    """
                    insert into entrega_items (entrega_id, descripcion, cantidad_entregada, cantidad_pendiente)
                    values ($1, $2, 0, $3) returning id
                    """,
                    entrega_id, f"PRODUCTO {n}", pendiente,
                )
            )
        )
    return str(entrega_id), items


async def estado_item(pool, item_id: str) -> tuple[int, int]:
    """(cantidad_entregada, cantidad_pendiente) del item."""
    fila = await pool.fetchrow(
        "select cantidad_entregada, cantidad_pendiente from entrega_items where id = $1::uuid", item_id
    )
    return fila["cantidad_entregada"], fila["cantidad_pendiente"]


async def eventos_en_logs(pool) -> list[str]:
    filas = await pool.fetch('select evento from logs order by "timestamp", id')
    return [f["evento"] for f in filas]
