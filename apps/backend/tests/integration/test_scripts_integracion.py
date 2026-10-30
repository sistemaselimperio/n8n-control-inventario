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


# --------------------------------------------------------------------------
# generar_turnos
# --------------------------------------------------------------------------


async def _entregas_en_hora(pg, sede: str, cantidad: int, cuando: datetime, prefijo: str, estado: str = "procesada") -> None:
    for n in range(cantidad):
        await pg.execute(
            """
            insert into entregas (tipo, indicativo_numero, hash_evidencia, sede_origen_id, estado,
                                  evidencia_url, operador_id, capturado_at)
            values ('XYZ', $1, $1, $2, $3, 'https://e.prueba/f.webp', 'op', $4)
            """,
            f"{prefijo}-{n}", sede, estado, cuando,
        )


@pytest.fixture
def job(pg, monkeypatch):
    """El job usa `app.db.get_pool` (singleton `_pool` que ya apunta a la base
    de prueba) y cierra el pool al terminar: se neutraliza el cierre para que
    el fixture `pg` pueda seguir usando la misma conexion."""
    async def _no_cerrar():
        return None

    monkeypatch.setattr(generar_turnos, "close_pool", _no_cerrar)


async def test_generar_turnos_escribe_una_foto_por_sede_y_la_semana_actual(pg, job):
    sede = await nueva_sede(pg)
    inactiva = await nueva_sede(pg)
    await pg.execute("update sedes set activa = false where id = $1::uuid", inactiva)
    # Lunes 10:00 hora de Bogota (15:00 UTC) con mucha carga, hace 3 semanas.
    base = datetime.now(timezone.utc) - timedelta(days=21)
    base = (base - timedelta(days=base.weekday())).replace(hour=15, minute=0, second=0, microsecond=0)
    await _entregas_en_hora(pg, sede, 6, base, "pico")
    # Mas horas con poca carga: el percentil 90 necesita varias celdas (con
    # menos de 9 el umbral queda por encima del maximo y no hay picos).
    for hora_utc in (13, 14, 16, 17, 18, 19, 20, 21, 22):
        await _entregas_en_hora(pg, sede, 1, base.replace(hour=hora_utc), f"valle{hora_utc}")
    await _entregas_en_hora(pg, inactiva, 3, base, "inactiva")

    await generar_turnos.generar_recomendaciones()

    filas = await pg.fetch("select * from shift_recommendations")
    assert [f["sede_id"] for f in filas] == [sede]  # la sede inactiva no genera foto
    foto = filas[0]
    assert foto["semana_iso"] == generar_turnos._semana_iso(datetime.now(timezone.utc))
    assert foto["modelo_usado"] == "p90_8semanas_hora_local"
    bloques = foto["bloques_sugeridos"]
    assert isinstance(bloques, list) and bloques[0]["dia"] == "lunes"
    assert bloques[0]["hora_inicio"] == "10:00:00"  # hora LOCAL de la sede (UTC-5), no UTC


async def test_generar_turnos_dos_veces_la_misma_semana_actualiza_en_vez_de_duplicar(pg, job):
    sede = await nueva_sede(pg)
    await _entregas_en_hora(pg, sede, 4, datetime.now(timezone.utc) - timedelta(days=2), "a")
    await generar_turnos.generar_recomendaciones()
    primera = await pg.fetchrow("select * from shift_recommendations")

    # Entra mas carga y se vuelve a correr (mismo sede_id y semana_iso).
    await _entregas_en_hora(pg, sede, 9, datetime.now(timezone.utc) - timedelta(days=1), "b")
    await generar_turnos.generar_recomendaciones()

    assert await pg.fetchval("select count(*) from shift_recommendations") == 1
    segunda = await pg.fetchrow("select * from shift_recommendations")
    assert segunda["id"] == primera["id"]  # misma fila, actualizada
    assert segunda["generado_at"] >= primera["generado_at"]


async def test_el_unique_de_sede_y_semana_lo_exige_la_base(pg):
    import asyncpg

    await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ('s', '2026-W10')")
    with pytest.raises(asyncpg.UniqueViolationError):
        await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ('s', '2026-W10')")
    # Otra sede o otra semana si pueden convivir.
    await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ('s', '2026-W11'), ('t', '2026-W10')")
    assert await pg.fetchval("select count(*) from shift_recommendations") == 3


async def test_generar_turnos_ignora_duplicados_bloqueados_y_entregas_viejas(pg, job):
    sede = await nueva_sede(pg)
    await _entregas_en_hora(pg, sede, 5, datetime.now(timezone.utc) - timedelta(days=2), "dup", estado="duplicado_bloqueado")
    await _entregas_en_hora(pg, sede, 5, datetime.now(timezone.utc) - timedelta(days=200), "vieja")
    await generar_turnos.generar_recomendaciones()
    # Sin historia util no se escribe nada (y no se borra una foto anterior).
    assert await pg.fetchval("select count(*) from shift_recommendations") == 0


async def test_generar_turnos_no_borra_la_foto_de_otras_semanas(pg, job):
    sede = await nueva_sede(pg)
    await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ($1, '2020-W01')", sede)
    await _entregas_en_hora(pg, sede, 4, datetime.now(timezone.utc) - timedelta(days=2), "a")
    await generar_turnos.generar_recomendaciones()
    assert await pg.fetchval("select count(*) from shift_recommendations") == 2
