"""Guardias estaticas sobre `_SCHEMA` (app/db.py).

No ejecutan SQL: verifican que el esquema siga siendo idempotente, que no
dependa de objetos propios de Supabase (para poder aplicarlo sobre un Postgres
comun, como el de CI) y que los enums de Python coincidan con los `check` de
la base. La ejecucion real del esquema esta en tests/integration.
"""

import re

import pytest

from app.db import _SCHEMA
from app.models.empleado import RolEmpleado
from app.models.entrega import EstadoEntrega


def _valores_de_check(patron: str) -> set[str]:
    coincidencia = re.search(patron, _SCHEMA, flags=re.S)
    assert coincidencia, f"No se encontro el check buscado: {patron}"
    return set(re.findall(r"'([^']+)'", coincidencia.group(1)))


def test_publicacion_realtime_solo_si_existe():
    """Las tablas se agregan a supabase_realtime unicamente si la publicacion
    existe; en un Postgres comun el bloque no hace nada y no falla."""
    guardia = "exists (select 1 from pg_publication where pubname = 'supabase_realtime')"
    assert guardia in _SCHEMA
    pos_guardia = _SCHEMA.index(guardia)
    posiciones = [m.start() for m in re.finditer(r"alter publication supabase_realtime", _SCHEMA)]
    assert posiciones, "El esquema ya no agrega tablas a la publicacion"
    assert all(p > pos_guardia for p in posiciones)


def test_alta_en_publicacion_tolera_tablas_ya_agregadas():
    # Cada alter va en su propio begin/exception: repetir el arranque no rompe.
    altas = len(re.findall(r"alter publication supabase_realtime add table", _SCHEMA))
    tolerancias = len(re.findall(r"exception when duplicate_object then null", _SCHEMA))
    assert tolerancias >= altas


@pytest.mark.parametrize(
    "patron",
    [
        r"\bauth\.",
        r"\bstorage\.",
        r"\banon\b",
        r"\bauthenticated\b",
        r"service_role",
        r"create\s+policy",
        r"row\s+level\s+security",
        r"create\s+role",
        r"\bgrant\b",
    ],
)
def test_esquema_no_depende_de_objetos_de_supabase(patron):
    assert re.search(patron, _SCHEMA, flags=re.I) is None


def test_unica_extension_es_pgcrypto():
    extensiones = set(re.findall(r"create extension if not exists (\w+)", _SCHEMA))
    assert extensiones == {"pgcrypto"}
    assert len(re.findall(r"create extension", _SCHEMA)) == 1


def test_ddl_es_idempotente():
    sin_if_not_exists = [
        linea.strip()
        for linea in _SCHEMA.splitlines()
        if re.match(r"\s*create (unique )?(table|index)\b", linea, flags=re.I)
        and "if not exists" not in linea.lower()
    ]
    assert sin_if_not_exists == []
    columnas = [
        linea.strip()
        for linea in _SCHEMA.splitlines()
        if re.match(r"\s*alter table .* add column\b", linea, flags=re.I)
        and "if not exists" not in linea.lower()
    ]
    assert columnas == []


def test_constraints_agregadas_se_eliminan_antes():
    # Cada `add constraint` fuera de un bloque DO debe tener su drop previo.
    for nombre in re.findall(r"alter table \w+ add constraint (\w+)", _SCHEMA):
        if nombre == "entregas_tipo_indicativo_numero_key":
            continue  # protegida por el chequeo en pg_constraint
        assert f"drop constraint if exists {nombre}" in _SCHEMA, nombre


def test_unique_tipo_indicativo_es_la_barrera_anti_duplicado():
    assert "unique (tipo, indicativo_numero)" in _SCHEMA
    assert "entregas_tipo_indicativo_numero_key" in _SCHEMA


def test_estado_entrega_coincide_con_check_de_la_base():
    en_base = _valores_de_check(r"estado text not null default 'pendiente_revision'\s*check \(estado in \(([^)]*)\)\)")
    assert en_base == {e.value for e in EstadoEntrega}


def test_rol_empleado_coincide_con_check_final_de_la_base():
    en_base = _valores_de_check(r"add constraint empleados_rol_check\s*check \(rol in \(([^)]*)\)\)")
    assert en_base == {r.value for r in RolEmpleado}
