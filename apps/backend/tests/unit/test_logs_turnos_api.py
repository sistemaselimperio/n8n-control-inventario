"""GET /logs, /turnos (router) y el calculo de carga y bloques de turno
(app/services/turnos.py)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from uuid import uuid4

import pytest

from app.services import turnos as servicio
from app.services.turnos import Celda, calcular_bloques, cargar_celdas, umbral_pico
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

AHORA = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)


def sesion(conn, rol="consulta") -> dict[str, str]:
    fila = fila_usuario_dashboard(rol=rol)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def fila_log(**extra) -> dict:
    fila = {
        "id": uuid4(), "evento": "extraccion_ia", "entidad_tipo": "entrega", "entidad_id": "e1",
        "actor_id": "emp-1", "sede_id": "s1", "resultado": "ok", "detalle": {}, "timestamp": AHORA,
        "actor_nombre": "Luis", "actor_rol": "operador",
    }
    fila.update(extra)
    return fila


# --------------------------------------------------------------------------
# GET /logs
# --------------------------------------------------------------------------


async def test_logs_sin_sesion_y_sin_entidad_da_401_sin_tocar_la_base(cliente, pool, conn):
    res = await cliente.get("/logs")
    assert res.status_code == 401
    assert conn.llamadas == []
    # Filtrar solo por sede tampoco abre el listado a un anonimo.
    assert (await cliente.get("/logs", params={"sede_id": "s1"})).status_code == 401
    assert conn.llamadas == []


async def test_logs_de_una_entidad_es_publico_para_la_app_movil(cliente, pool, conn):
    conn.responder("fetch", "from logs l", [fila_log()])
    res = await cliente.get("/logs", params={"entidad_id": "e1"})
    assert res.status_code == 200
    (fila,) = res.json()
    assert isinstance(fila["id"], str) and fila["actor_nombre"] == "Luis"
    (_, sql, args) = conn.llamadas[0]
    assert "l.entidad_id = $1" in sql and args == ("e1", 100)


async def test_logs_con_sesion_lista_todo_ordenado_por_fecha_descendente(cliente, pool, conn):
    conn.responder("fetch", "from logs l", [])
    res = await cliente.get("/logs", headers=sesion(conn, "consulta"))
    assert res.status_code == 200
    sql = [c for c in conn.llamadas if "from logs l" in c[1]][0][1]
    assert 'order by l."timestamp" desc' in sql and "where" not in sql


async def test_logs_combina_filtros_con_parametros_y_el_limite_va_al_final(cliente, pool, conn):
    conn.responder("fetch", "from logs l", [])
    await cliente.get("/logs", params={"entidad_id": "e1", "sede_id": "s1", "limit": 5})
    (_, sql, args) = conn.sql_ejecutado("from logs l")[0]
    assert "l.entidad_id = $1 and l.sede_id = $2" in sql and "limit $3" in sql
    assert args == ("e1", "s1", 5)


async def test_logs_los_filtros_nunca_se_interpolan_en_el_sql(cliente, pool, conn):
    conn.responder("fetch", "from logs l", [])
    peligroso = "e1' or '1'='1"
    await cliente.get("/logs", params={"entidad_id": peligroso})
    (_, sql, args) = conn.sql_ejecutado("from logs l")[0]
    assert peligroso not in sql and args[0] == peligroso


async def test_logs_con_sesion_invalida_da_401_aunque_traiga_entidad(cliente, pool, conn):
    res = await cliente.get("/logs", params={"entidad_id": "e1"}, headers={"Authorization": "Bearer basura"})
    assert res.status_code == 401


async def test_logs_solo_expone_lectura(cliente, pool, conn):
    for metodo in ("post", "put", "patch", "delete"):
        res = await cliente.request(metodo.upper(), "/logs")
        assert res.status_code == 405
    assert conn.llamadas == []


@pytest.mark.parametrize("limit", ["x", "1.5"])
async def test_logs_limit_no_numerico_da_422(cliente, pool, conn, limit):
    assert (await cliente.get("/logs", params={"entidad_id": "e", "limit": limit})).status_code == 422


# --------------------------------------------------------------------------
# /turnos
# --------------------------------------------------------------------------

TURNO = {"empleado_id": "emp-1", "sede_id": "s1", "fecha": "2026-03-05", "hora_inicio": "08:00:00", "hora_fin": "12:30:00"}


async def test_crear_turno_inserta_con_parametros_y_devuelve_el_id(cliente, pool, conn):
    nuevo = uuid4()
    conn.responder("fetchval", "insert into turnos", nuevo)
    res = await cliente.post("/turnos", json=TURNO)
    assert res.status_code == 201 and res.json() == {"id": str(nuevo)}
    (_, _, args) = conn.sql_ejecutado("insert into turnos")[0]
    assert args == ("emp-1", "s1", date(2026, 3, 5), time(8, 0), time(12, 30), "manual")


async def test_crear_turno_acepta_el_origen_sugerido_por_ia(cliente, pool, conn):
    conn.responder("fetchval", "insert into turnos", uuid4())
    await cliente.post("/turnos", json={**TURNO, "origen": "sugerido_ia"})
    assert conn.sql_ejecutado("insert into turnos")[0][2][-1] == "sugerido_ia"


@pytest.mark.parametrize(
    "cambio",
    [
        {"empleado_id": None}, {"sede_id": None}, {"fecha": "no-es-fecha"}, {"fecha": "2026-13-45"},
        {"hora_inicio": "25:00"}, {"hora_fin": "x"}, {"origen": "inventado"}, {"fecha": None},
    ],
)
async def test_crear_turno_rechaza_datos_invalidos(cliente, pool, conn, cambio):
    res = await cliente.post("/turnos", json={**TURNO, **cambio})
    assert res.status_code == 422 and conn.llamadas == []


async def test_crear_turno_sin_cuerpo_da_422(cliente, pool, conn):
    assert (await cliente.post("/turnos", json={})).status_code == 422


async def test_listar_turnos_todos_o_de_una_sede(cliente, pool, conn):
    conn.responder("fetch", "from turnos", [{"id": uuid4(), "sede_id": "s1"}])
    res = await cliente.get("/turnos")
    assert res.status_code == 200 and isinstance(res.json()[0]["id"], str)
    assert "where" not in conn.llamadas[0][1] and "order by fecha" in conn.llamadas[0][1]

    await cliente.get("/turnos", params={"sede_id": "s1"})
    assert "where sede_id = $1" in conn.llamadas[1][1] and conn.llamadas[1][2] == ("s1",)


async def test_listar_recomendaciones_todas_o_de_una_sede_las_mas_recientes_primero(cliente, pool, conn):
    conn.responder("fetch", "from shift_recommendations", [{"id": uuid4(), "sede_id": "s1", "semana_iso": "2026-W10"}])
    res = await cliente.get("/turnos/recomendaciones")
    assert res.status_code == 200 and isinstance(res.json()[0]["id"], str)
    assert "order by semana_iso desc" in conn.llamadas[0][1] and "where" not in conn.llamadas[0][1]
    await cliente.get("/turnos/recomendaciones", params={"sede_id": "s1"})
    assert conn.llamadas[1][2] == ("s1",)


# --------------------------------------------------------------------------
# GET /turnos/carga
# --------------------------------------------------------------------------


def fila_carga(dia: int, hora: int, n: int, dias_atras: float = 30) -> dict:
    return {"dia": dia, "hora": hora, "n": n, "primero": datetime.now(timezone.utc) - timedelta(days=dias_atras)}


async def test_carga_exige_la_sede_y_valida_el_rango_de_semanas(cliente, pool, conn):
    assert (await cliente.get("/turnos/carga")).status_code == 422
    for semanas in (0, 53, -1, "x"):
        assert (await cliente.get("/turnos/carga", params={"sede_id": "s1", "semanas": semanas})).status_code == 422
    for semanas in (1, 52):
        conn.responder("fetch", "from entregas e", [])
        assert (await cliente.get("/turnos/carga", params={"sede_id": "s1", "semanas": semanas})).status_code == 200


async def test_carga_sin_historia_responde_vacio_sin_umbral(cliente, pool, conn):
    conn.responder("fetch", "from entregas e", [])
    res = await cliente.get("/turnos/carga", params={"sede_id": "s1"})
    assert res.json() == {"sede_id": "s1", "semanas": 0, "umbral_pico": None, "celdas": [], "bloques": []}


async def test_carga_marca_picos_redondea_y_arma_bloques(cliente, pool, conn):
    # 8 semanas cubiertas (60 dias > 56): promedio = n / 8.
    filas = [fila_carga(0, h, n, 60) for h, n in ((8, 8), (9, 8), (10, 80), (11, 80), (12, 4))]
    conn.responder("fetch", "from entregas e", filas)
    res = await cliente.get("/turnos/carga", params={"sede_id": "s1"})
    cuerpo = res.json()
    assert cuerpo["semanas"] == 8
    picos = {(c["dia"], c["hora"]): c["pico"] for c in cuerpo["celdas"]}
    assert picos == {(0, 8): False, (0, 9): False, (0, 10): True, (0, 11): True, (0, 12): False}
    assert {c["hora"]: c["promedio"] for c in cuerpo["celdas"]}[10] == 10.0
    (bloque,) = cuerpo["bloques"]
    assert (bloque["dia"], bloque["hora_inicio"], bloque["hora_fin"]) == ("lunes", "10:00:00", "12:00:00")
    assert bloque["carga_maxima"] == 10.0 and bloque["personal_sugerido"] == 1


async def test_carga_consulta_con_parametros_y_excluye_duplicados_bloqueados(cliente, pool, conn):
    conn.responder("fetch", "from entregas e", [])
    await cliente.get("/turnos/carga", params={"sede_id": "s1", "semanas": 4})
    (_, sql, args) = conn.llamadas[0]
    assert "e.estado <> 'duplicado_bloqueado'" in sql
    assert "at time zone s.timezone" in sql  # hora LOCAL de la sede, no UTC
    assert args == ("s1", 4)


# --------------------------------------------------------------------------
# servicio de turnos: logica pura
# --------------------------------------------------------------------------


def celdas(*triples) -> list[Celda]:
    return [Celda(d, h, p) for d, h, p in triples]


def test_umbral_sin_celdas_o_sin_carga_es_none():
    assert umbral_pico([]) is None
    assert umbral_pico(celdas((0, 8, 0), (0, 9, 0))) is None


def test_umbral_con_una_sola_celda_con_carga_es_su_valor():
    assert umbral_pico(celdas((0, 8, 0), (0, 9, 3.5))) == 3.5


def test_umbral_es_el_percentil_90_de_las_celdas_con_carga():
    cs = celdas(*[(0, h, float(h + 1)) for h in range(10)])  # 1..10
    assert umbral_pico(cs) == pytest.approx(9.9)
    # Las celdas en cero no bajan el percentil.
    assert umbral_pico(cs + celdas((1, 0, 0), (1, 1, 0))) == pytest.approx(9.9)


def test_bloques_sin_umbral_no_hay():
    assert calcular_bloques(celdas((0, 8, 5)), None) == []


def test_un_bloque_por_tramo_contiguo_no_uno_que_cubra_los_huecos():
    cs = celdas((0, 8, 10), (0, 9, 10), (0, 12, 10), (0, 13, 10), (0, 14, 10))
    bloques = calcular_bloques(cs, 10)
    assert [(b["hora_inicio"], b["hora_fin"]) for b in bloques] == [("08:00:00", "10:00:00"), ("12:00:00", "15:00:00")]


def test_los_bloques_salen_por_dia_en_orden_y_con_su_nombre():
    cs = celdas((2, 10, 9), (0, 8, 9), (6, 7, 9))
    bloques = calcular_bloques(cs, 9)
    assert [(b["dia"], b["dia_indice"]) for b in bloques] == [("lunes", 0), ("miercoles", 2), ("domingo", 6)]


def test_solo_cuentan_las_celdas_en_o_sobre_el_umbral():
    cs = celdas((0, 8, 9.99), (0, 9, 10), (0, 10, 10.01))
    (bloque,) = calcular_bloques(cs, 10)
    assert (bloque["hora_inicio"], bloque["hora_fin"]) == ("09:00:00", "11:00:00")


def test_la_hora_final_del_bloque_de_las_23_envuelve_a_medianoche():
    (bloque,) = calcular_bloques(celdas((4, 22, 5), (4, 23, 5)), 5)
    assert (bloque["hora_inicio"], bloque["hora_fin"]) == ("22:00:00", "00:00:00")


@pytest.mark.parametrize("horas, esperado", [(1, 1), (2, 1), (3, 2), (4, 2), (6, 3), (10, 5)])
def test_personal_sugerido_es_la_mitad_de_las_horas_con_minimo_uno(horas, esperado):
    cs = celdas(*[(0, h, 7) for h in range(8, 8 + horas)])
    (bloque,) = calcular_bloques(cs, 7)
    assert bloque["personal_sugerido"] == esperado


def test_carga_maxima_del_bloque_con_un_decimal():
    (bloque,) = calcular_bloques(celdas((0, 8, 4.26), (0, 9, 6.74)), 4)
    assert bloque["carga_maxima"] == 6.7


def test_el_modelo_nombra_la_ventana_de_semanas():
    assert servicio.MODELO == f"p90_{servicio.SEMANAS_HISTORIAL}semanas_hora_local"


# --- cargar_celdas ---------------------------------------------------------


async def test_cargar_celdas_sin_filas(pool, conn):
    conn.responder("fetch", "from entregas e", [])
    assert await cargar_celdas(pool, "s1") == ([], 0)


@pytest.mark.parametrize(
    "dias_atras, semanas, cubiertas",
    [(0.5, 8, 1), (6.9, 8, 1), (8, 8, 2), (20, 8, 3), (200, 8, 8), (200, 3, 3)],
)
async def test_cargar_celdas_divide_por_las_semanas_realmente_cubiertas(pool, conn, dias_atras, semanas, cubiertas):
    conn.responder("fetch", "from entregas e", [fila_carga(1, 9, 12, dias_atras)])
    cs, cubiertas_reales = await cargar_celdas(pool, "s1", semanas)
    assert cubiertas_reales == cubiertas
    assert cs[0].promedio == pytest.approx(12 / cubiertas)


async def test_cargar_celdas_usa_la_primera_entrega_mas_antigua_de_todas_las_celdas(pool, conn):
    conn.responder("fetch", "from entregas e", [fila_carga(0, 8, 4, 3), fila_carga(1, 9, 4, 30)])
    _, cubiertas = await cargar_celdas(pool, "s1", 8)
    assert cubiertas == 5  # ceil(30 / 7)


# --------------------------------------------------------------------------
# Regresion: limit acotado
# --------------------------------------------------------------------------


@pytest.mark.parametrize("limit", [-1, 0, 1001, 10_000_000])
async def test_logs_limit_fuera_de_rango_da_422_sin_consultar(cliente, pool, conn, limit):
    """Antes un limit negativo llegaba a Postgres (HTTP 500) y uno enorme
    permitia volcar la tabla con un pedido anonimo por entidad."""
    res = await cliente.get("/logs", params={"entidad_id": "e1", "limit": limit})
    assert res.status_code == 422 and conn.llamadas == []


@pytest.mark.parametrize("limit", [1, 150, 200, 1000])
async def test_logs_limit_dentro_de_rango_se_pasa_a_la_consulta(cliente, pool, conn, limit):
    conn.responder("fetch", "from logs l", [])
    assert (await cliente.get("/logs", params={"entidad_id": "e1", "limit": limit})).status_code == 200
    assert conn.sql_ejecutado("from logs l")[0][2][-1] == limit
