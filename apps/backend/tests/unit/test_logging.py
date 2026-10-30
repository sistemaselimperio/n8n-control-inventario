"""Bitacora `logs`: solo se inserta, nunca se actualiza ni se borra."""

import re
from pathlib import Path

import pytest

from app.models.log import EventoLog
from app.services.logging_service import registrar_evento

RAIZ_APP = Path(__file__).resolve().parents[2] / "app"


async def test_registrar_evento_inserta_una_fila_con_los_valores_del_enum(pool, conn):
    await registrar_evento(
        EventoLog.ENTREGA_INSERTADA,
        entidad_tipo="entrega",
        entidad_id="abc",
        actor_id="op",
        sede_id="s1",
        resultado="ok",
        detalle={"k": 1},
    )
    ((metodo, sql, args),) = conn.llamadas
    assert metodo == "execute"
    assert sql.strip().lower().startswith("insert into logs")
    assert args == ("entrega_insertada", "entrega", "abc", "op", "s1", "ok", {"k": 1})


async def test_detalle_por_defecto_es_dict_vacio(pool, conn):
    await registrar_evento(
        EventoLog.FOTO_CAPTURADA, entidad_tipo="entrega", entidad_id="a", actor_id="o", sede_id="s", resultado="ok"
    )
    assert conn.llamadas[0][2][-1] == {}


def test_el_codigo_de_la_app_nunca_actualiza_ni_borra_logs():
    """Unica excepcion documentada: la limpieza total desde el dashboard
    (DELETE /entregas/todas), que luego deja su propio evento de auditoria."""
    patron = re.compile(r"\b(update\s+logs|delete\s+from\s+logs|truncate\s+(table\s+)?logs)\b", re.I)
    encontrados = {}
    for archivo in RAIZ_APP.rglob("*.py"):
        coincidencias = patron.findall(archivo.read_text(encoding="utf-8"))
        if coincidencias:
            encontrados[archivo.relative_to(RAIZ_APP).as_posix()] = len(coincidencias)
    assert encontrados == {"routers/entregas.py": 1}


@pytest.mark.parametrize("evento", list(EventoLog))
def test_todo_evento_es_un_texto_simple(evento):
    assert isinstance(evento.value, str) and evento.value
