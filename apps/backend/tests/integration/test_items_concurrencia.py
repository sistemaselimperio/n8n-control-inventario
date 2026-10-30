"""PATCH /entregas/{id}/items contra Postgres real: el delta `entregado_hoy`
se aplica en SQL, asi que entregas simultaneas no se pisan."""

import asyncio

import pytest

from app.models.entrega import ItemActualizacion
from app.services.duplicates import (
    CantidadInvalida,
    aplicar_actualizacion_items,
    cancelar_entrega_no_confirmada,
)
from tests.integration.conftest import crear_entrega, estado_item, eventos_en_logs

pytestmark = pytest.mark.integration

BASE = dict(operador_id="op", sede_id="sede-1")


def entregar(entrega_id, item_id, cantidad):
    return aplicar_actualizacion_items(
        entrega_id, [ItemActualizacion(id=item_id, entregado_hoy=cantidad)], **BASE
    )


async def test_cinco_entregas_simultaneas_suman_sin_pisarse(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(10,))
    resultados = await asyncio.gather(*(entregar(entrega_id, item_id, 2) for _ in range(5)), return_exceptions=True)
    assert [r for r in resultados if isinstance(r, BaseException)] == []
    assert await estado_item(pg, item_id) == (10, 0)  # (entregado, pendiente): nada se perdio


async def test_entregar_de_mas_en_paralelo_nunca_deja_numeros_inconsistentes(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(10,))
    resultados = await asyncio.gather(*(entregar(entrega_id, item_id, 2) for _ in range(6)), return_exceptions=True)

    rechazos = [r for r in resultados if isinstance(r, CantidadInvalida)]
    otros = [r for r in resultados if isinstance(r, BaseException) and not isinstance(r, CantidadInvalida)]
    assert otros == []
    assert len(rechazos) == 1  # exactamente la sexta no cabia
    entregado, pendiente = await estado_item(pg, item_id)
    assert (entregado, pendiente) == (10, 0)
    assert entregado + pendiente == 10  # el total original se conserva
    eventos = await eventos_en_logs(pg)
    assert eventos.count("entrega_actualizada") == 5  # el rechazado no deja evento


async def test_la_primera_confirmacion_fija_y_las_siguientes_suman(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(10,))
    await entregar(entrega_id, item_id, 4)
    assert await estado_item(pg, item_id) == (4, 6)
    await entregar(entrega_id, item_id, 3)
    assert await estado_item(pg, item_id) == (7, 3)


async def test_no_se_puede_entregar_mas_de_lo_pendiente(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(3,))
    with pytest.raises(CantidadInvalida, match="tiene 3 pendiente"):
        await entregar(entrega_id, item_id, 4)
    assert await estado_item(pg, item_id) == (0, 3)
    assert await eventos_en_logs(pg) == []


async def test_item_de_otra_entrega_no_se_toca(pg):
    entrega_a, (item_a,) = await crear_entrega(pg, numero="1", pendientes=(5,))
    entrega_b, _ = await crear_entrega(pg, numero="2", pendientes=(5,))
    with pytest.raises(CantidadInvalida, match="no existe en esta entrega"):
        await entregar(entrega_b, item_a, 1)
    assert await estado_item(pg, item_a) == (0, 5)


async def test_si_un_item_falla_se_deshace_toda_la_confirmacion(pg):
    entrega_id, (primero, segundo) = await crear_entrega(pg, pendientes=(10, 1))
    with pytest.raises(CantidadInvalida):
        await aplicar_actualizacion_items(
            entrega_id,
            [ItemActualizacion(id=primero, entregado_hoy=4), ItemActualizacion(id=segundo, entregado_hoy=2)],
            **BASE,
        )
    assert await estado_item(pg, primero) == (0, 10)  # rollback real, no quedo a medias
    assert await estado_item(pg, segundo) == (0, 1)


async def test_pendiente_absoluto_deriva_lo_entregado(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(10,))
    await aplicar_actualizacion_items(entrega_id, [ItemActualizacion(id=item_id, cantidad_pendiente=3)], **BASE)
    assert await estado_item(pg, item_id) == (7, 3)
    # Subir el pendiente (correccion) no resta lo ya entregado.
    await aplicar_actualizacion_items(entrega_id, [ItemActualizacion(id=item_id, cantidad_pendiente=8)], **BASE)
    assert await estado_item(pg, item_id) == (7, 8)


async def test_correccion_explicita_de_entregado_tiene_prioridad(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(10,))
    await aplicar_actualizacion_items(
        entrega_id, [ItemActualizacion(id=item_id, cantidad_entregada=2, cantidad_pendiente=3)], **BASE
    )
    assert await estado_item(pg, item_id) == (2, 3)


async def test_item_cerrado_registra_quien_lo_entrego_y_reabrir_lo_limpia(pg):
    entrega_id, (item_id,) = await crear_entrega(pg, pendientes=(2,))
    await entregar(entrega_id, item_id, 2)
    fila = await pg.fetchrow("select entregado_por from entrega_items where id = $1::uuid", item_id)
    assert fila["entregado_por"] == "op"
    assert await pg.fetchval("select bodeguero_id from entregas where id = $1::uuid", entrega_id) == "op"

    await aplicar_actualizacion_items(entrega_id, [ItemActualizacion(id=item_id, cantidad_pendiente=1)], **BASE)
    assert await pg.fetchval("select entregado_por from entrega_items where id = $1::uuid", item_id) is None


async def test_cancelar_borra_solo_lo_que_nadie_confirmo(pg):
    sin_confirmar, _ = await crear_entrega(pg, numero="1", pendientes=(5,))
    confirmada, (item_id,) = await crear_entrega(pg, numero="2", pendientes=(5,))
    await entregar(confirmada, item_id, 1)

    assert await cancelar_entrega_no_confirmada(sin_confirmar, operador_id="op", sede_id="s") is True
    assert await cancelar_entrega_no_confirmada(confirmada, operador_id="op", sede_id="s") is False
    assert await cancelar_entrega_no_confirmada(sin_confirmar, operador_id="op", sede_id="s") is False  # idempotente
    assert await pg.fetchval("select count(*) from entregas") == 1
    assert (await eventos_en_logs(pg)).count("entrega_cancelada") == 1
