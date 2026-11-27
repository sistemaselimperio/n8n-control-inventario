"""Guardias estaticas del esquema del modulo Traslados (app/db.py): el seed de
es_interna ocurre una sola vez, la barrera anti-duplicado esta a nivel de base
y las tablas nuevas viajan por Realtime. La ejecucion real esta en
tests/integration/test_traslados_comprobantes_integracion.py."""

import re

from app.db import _SCHEMA
from app.models.traslado import ESTADOS_COMPROBANTE, ESTADOS_TRASLADO, TIPOS_COMPROBANTE


def _bloque_es_interna() -> str:
    coincidencia = re.search(
        r"do \$\$\s*begin\s*if not exists \(\s*select 1 from information_schema\.columns.*?end \$\$;", _SCHEMA, flags=re.S
    )
    assert coincidencia, "No se encontro el bloque que agrega y siembra puntos.es_interna"
    return coincidencia.group(0)


def test_es_interna_se_agrega_y_siembra_en_un_solo_bloque_condicionado():
    bloque = _bloque_es_interna()
    assert "information_schema.columns" in bloque and "column_name = 'es_interna'" in bloque
    assert "add column if not exists es_interna boolean not null default false" in bloque
    assert re.search(r"update puntos set es_interna = true where codigo in \('TB8', 'TB9', 'TBE', 'TB'\)", bloque)


def _bloque_alias() -> str:
    coincidencia = re.search(
        r"do \$\$\s*begin\s*if not exists \(\s*select 1 from information_schema\.columns"
        r"(?:(?!end \$\$;).)*?column_name = 'alias'.*?end \$\$;",
        _SCHEMA,
        flags=re.S,
    )
    assert coincidencia, "No se encontro el bloque que agrega y siembra puntos.alias"
    return coincidencia.group(0)


def test_el_seed_de_es_interna_no_corre_fuera_del_bloque():
    """Un update suelto se repetiria en cada arranque y pisaria lo editado."""
    sin_bloques = _SCHEMA.replace(_bloque_es_interna(), "").replace(_bloque_alias(), "")
    assert "es_interna = true" not in sin_bloques


def test_alias_se_agrega_y_siembra_en_un_solo_bloque_condicionado():
    bloque = _bloque_alias()
    assert "table_name = 'puntos'" in bloque
    assert "add column if not exists alias text[] not null default '{}'" in bloque
    # BV: interna, con sus otros nombres, y sin pisar un punto que ya exista.
    assert "'BV'" in bloque and "'BV — Bodega Ventas'" in bloque
    for alias in (
        "Bodega Ventas Principal",
        "Bodega Interna Ventas",
        "Bodega Principal",
        "Bodega Central",
        "Principal",
        "Bodega Agroquímicos Estación",
    ):
        assert f"'{alias}'" in bloque
    assert re.search(r"update puntos set es_interna = true where codigo = 'VET'", bloque)
    assert "'GUA'" in bloque and "'GUA — Guasca'" in bloque
    # Los inserts no fallan ni pisan si el codigo o el nombre ya existen.
    assert bloque.count("on conflict do nothing") == 2


def test_el_seed_de_alias_no_corre_fuera_del_bloque():
    """Un seed suelto se repetiria en cada arranque y pisaria lo editado desde /creador."""
    sin_bloques = _SCHEMA.replace(_bloque_es_interna(), "").replace(_bloque_alias(), "")
    assert "'BV'" not in sin_bloques and "'GUA'" not in sin_bloques and "'VET'" not in sin_bloques
    assert "alias text[]" not in sin_bloques


def test_usuarios_dashboard_tiene_punto_y_cedula():
    assert re.search(
        r"alter table usuarios_dashboard add column if not exists punto_id uuid references puntos\(id\)", _SCHEMA
    )
    assert "alter table usuarios_dashboard add column if not exists cedula text" in _SCHEMA


def test_unico_de_comprobantes_por_numero_punto_y_tipo():
    assert re.search(
        r"create unique index if not exists traslado_comprobantes_numero_punto_tipo_key\s+"
        r"on traslado_comprobantes \(numero, punto_id, tipo\)",
        _SCHEMA,
    )


def test_a_lo_mas_un_comprobante_por_lado_en_cada_traslado():
    assert re.search(
        r"create unique index if not exists traslado_comprobantes_traslado_tipo_key\s+"
        r"on traslado_comprobantes \(traslado_id, tipo\)",
        _SCHEMA,
    )


def test_comprobantes_se_borran_en_cascada_con_su_traslado():
    assert re.search(r"traslado_id uuid not null references traslados\(id\) on delete cascade", _SCHEMA)


def test_checks_del_esquema_coinciden_con_las_constantes_de_python():
    def valores(patron: str) -> set[str]:
        coincidencia = re.search(patron, _SCHEMA, flags=re.S)
        assert coincidencia, patron
        return set(re.findall(r"'([^']+)'", coincidencia.group(1)))

    assert valores(r"traslados_estado_check check \((.*?)\);") == set(ESTADOS_TRASLADO)
    assert valores(r"traslado_comprobantes_tipo_check\s+check \((.*?)\);") == set(TIPOS_COMPROBANTE)
    assert valores(r"traslado_comprobantes_estado_check\s+check \((.*?)\);") == set(ESTADOS_COMPROBANTE)


def test_tablas_nuevas_van_a_la_publicacion_realtime_con_tolerancia():
    for tabla in ("traslados", "traslado_comprobantes"):
        assert f"alter publication supabase_realtime add table {tabla};" in _SCHEMA


def test_nombres_nuevos_no_chocan_con_las_tablas_del_modulo_anterior():
    tablas = re.findall(r"create table if not exists (\w+)", _SCHEMA)
    assert len(tablas) == len(set(tablas))
    assert {"traslados", "traslado_comprobantes", "traslados_puntos", "traslado_punto_items"} <= set(tablas)


# --------------------------- receptores por punto ---------------------------


def test_receptores_punto_tiene_su_tabla_idempotente_y_unico_por_punto_y_cedula():
    assert "create table if not exists receptores_punto (" in _SCHEMA
    bloque = _SCHEMA.split("create table if not exists receptores_punto (")[1].split(");")[0]
    assert "id uuid primary key default gen_random_uuid()" in bloque
    assert "punto_id uuid not null references puntos(id)" in bloque
    assert "nombre text not null" in bloque and "cedula text not null" in bloque
    assert "activo boolean not null default true" in bloque
    assert "creado_at timestamptz default now()" in bloque
    assert "unique (punto_id, cedula)" in bloque


def test_el_comprobante_enlaza_al_receptor_y_el_borrado_del_receptor_no_pierde_historial():
    assert re.search(
        r"alter table traslado_comprobantes\s+add column if not exists receptor_id uuid "
        r"references receptores_punto\(id\) on delete set null",
        _SCHEMA,
    )
    # La tabla se crea antes de que el comprobante la referencie.
    assert _SCHEMA.index("create table if not exists receptores_punto") < _SCHEMA.index("add column if not exists receptor_id")


def test_receptores_punto_no_viaja_por_realtime():
    assert "add table receptores_punto" not in _SCHEMA
