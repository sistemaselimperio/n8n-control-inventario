"""Ranking de productos (app/services/ranking.py + GET /ranking/productos) y
deteccion del codigo de producto (app/services/productos.py)."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.services.productos import extraer_codigo_nombre, sincronizar_producto
from app.services.ranking import _normalizar, calcular_ranking_productos

UTC = timezone.utc


def fila(descripcion: str, cantidad: int, entrega: str = "e1") -> dict:
    return {"descripcion": descripcion, "cantidad_entregada": cantidad, "entrega_id": entrega}


def resumen(items) -> list[tuple]:
    return [(i.codigo, i.nombre, i.cantidad_total, i.entregas_count) for i in items]


# --------------------------------------------------------------------------
# extraer_codigo_nombre
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "descripcion, esperado",
    [
        ("75936  SAL BLANCA * 40 KILOS", ("75936", "SAL BLANCA * 40 KILOS")),
        ("  75936 - SAL BLANCA ", ("75936", "SAL BLANCA")),
        ("123: AZUCAR", ("123", "AZUCAR")),
        ("1234567890\tACEITE", ("1234567890", "ACEITE")),
        ("2 CAJAS DE SAL", None),  # 1-2 digitos: es una cantidad, no un codigo
        ("12 SAL", None),
        ("SAL BLANCA", None),
        ("75936", None),  # codigo sin nombre
        ("75936   ", None),
        ("75936SAL", None),  # sin separador
        ("", None),
        ("   ", None),
        ("-75936 SAL", None),
    ],
)
def test_extraer_codigo_nombre(descripcion, esperado):
    assert extraer_codigo_nombre(descripcion) == esperado


async def test_sincronizar_producto_inserta_con_on_conflict_do_nothing(conn):
    await sincronizar_producto(conn, "75936  SAL BLANCA")
    ((_, sql, args),) = conn.llamadas
    assert "on conflict (codigo) do nothing" in sql
    assert args == ("75936", "SAL BLANCA")


async def test_sincronizar_producto_ignora_descripciones_sin_codigo(conn):
    await sincronizar_producto(conn, "SAL BLANCA")
    assert conn.llamadas == []


# --------------------------------------------------------------------------
# calcular_ranking_productos
# --------------------------------------------------------------------------


def test_agrupa_por_codigo_suma_cantidades_y_cuenta_entregas_distintas():
    filas = [
        fila("75936 SAL BLANCA", 5, "e1"),
        fila("75936  SAL BLANCA * 40", 3, "e2"),  # mismo codigo, texto distinto
        fila("75936 SAL BLANCA", 2, "e2"),  # misma entrega otra vez: no suma otra entrega
    ]
    mas, _ = calcular_ranking_productos(filas, limit=10)
    assert len(mas) == 1
    assert (mas[0].codigo, mas[0].cantidad_total, mas[0].entregas_count) == ("75936", 10, 2)
    # Sin catalogo, el nombre es el de la primera descripcion que trajo el codigo.
    assert mas[0].nombre == "SAL BLANCA"


def test_sin_codigo_se_agrupa_por_texto_normalizado_sin_distinguir_mayusculas_ni_espacios():
    filas = [fila("sal blanca", 1), fila("SAL   BLANCA", 2, "e2"), fila("  Sal Blanca ", 4, "e3")]
    mas, _ = calcular_ranking_productos(filas, limit=10)
    assert resumen(mas) == [(None, "sal blanca", 7, 3)]  # nombre "bonito": la primera descripcion vista


def test_el_catalogo_completa_el_codigo_de_una_descripcion_sin_codigo():
    catalogo = [{"codigo": "75936", "nombre": "SAL BLANCA"}]
    filas = [fila("75936 SAL BLANCA", 5, "e1"), fila("sal  blanca", 3, "e2")]
    mas, _ = calcular_ranking_productos(filas, limit=10, catalogo=catalogo)
    assert resumen(mas) == [("75936", "SAL BLANCA", 8, 2)]


def test_el_nombre_corregido_a_mano_en_el_catalogo_gana_sobre_el_de_la_factura():
    catalogo = [{"codigo": "75936", "nombre": "Sal blanca x 40 kg"}]
    mas, _ = calcular_ranking_productos([fila("75936 SAL BLNCA", 5)], limit=10, catalogo=catalogo)
    assert mas[0].nombre == "Sal blanca x 40 kg"


def test_un_nombre_sin_codigo_y_sin_coincidencia_en_el_catalogo_queda_sin_codigo():
    catalogo = [{"codigo": "75936", "nombre": "SAL BLANCA"}]
    mas, _ = calcular_ranking_productos([fila("AZUCAR", 5)], limit=10, catalogo=catalogo)
    assert resumen(mas) == [(None, "AZUCAR", 5, 1)]


def test_descripciones_vacias_o_nulas_se_saltan():
    filas = [fila("", 5), fila("   ", 5), {"descripcion": None, "cantidad_entregada": 9, "entrega_id": "e1"}, fila("SAL", 1)]
    mas, menos = calcular_ranking_productos(filas, limit=10)
    assert resumen(mas) == [(None, "SAL", 1, 1)] == resumen(menos)


def test_mas_vendidos_de_mayor_a_menor_y_menos_vendidos_de_menor_a_mayor_con_limite():
    filas = [fila(f"1000{n} PRODUCTO {n}", n, f"e{n}") for n in range(1, 6)]
    mas, menos = calcular_ranking_productos(filas, limit=2)
    assert [i.cantidad_total for i in mas] == [5, 4]
    assert [i.cantidad_total for i in menos] == [1, 2]


def test_limite_mayor_que_la_cantidad_devuelve_todo_y_cero_devuelve_nada():
    filas = [fila("10000 A", 1), fila("10001 B", 2)]
    mas, menos = calcular_ranking_productos(filas, limit=50)
    assert len(mas) == len(menos) == 2
    assert calcular_ranking_productos(filas, limit=0) == ([], [])


def test_sin_filas_todo_vacio():
    assert calcular_ranking_productos([], limit=5) == ([], [])


def test_un_producto_sin_unidades_entregadas_aparece_entre_los_menos_vendidos():
    filas = [fila("10000 A", 0), fila("10001 B", 4)]
    mas, menos = calcular_ranking_productos(filas, limit=1)
    assert mas[0].codigo == "10001" and menos[0].codigo == "10000"


def test_empates_son_estables_en_el_orden_de_aparicion():
    filas = [fila("10000 A", 3), fila("10001 B", 3), fila("10002 C", 3)]
    mas, menos = calcular_ranking_productos(filas, limit=3)
    assert [i.codigo for i in mas] == ["10000", "10001", "10002"]
    assert [i.codigo for i in menos] == ["10000", "10001", "10002"]


def test_normalizar():
    assert _normalizar("  sal \t blanca\n") == "SAL BLANCA"


# --------------------------------------------------------------------------
# GET /ranking/productos
# --------------------------------------------------------------------------

RANGO = {"desde": "2026-01-01T00:00:00Z", "hasta": "2026-01-31T23:59:59Z"}


async def test_endpoint_arma_el_ranking_con_filas_y_catalogo(cliente, pool, conn):
    conn.responder("fetch", "from entrega_items i", [fila("75936 SAL", 5, "e1"), fila("10001 AZUCAR", 2, "e2")])
    conn.responder("fetch", "from productos", [{"codigo": "75936", "nombre": "Sal fina"}])
    res = await cliente.get("/ranking/productos", params=RANGO)
    assert res.status_code == 200
    cuerpo = res.json()
    assert cuerpo["sede_id"] is None
    assert [i["nombre"] for i in cuerpo["mas_vendidos"]] == ["Sal fina", "AZUCAR"]
    assert cuerpo["menos_vendidos"][0]["codigo"] == "10001"
    assert set(cuerpo["mas_vendidos"][0]) == {"codigo", "nombre", "cantidad_total", "entregas_count"}


async def test_endpoint_excluye_los_duplicados_bloqueados_y_usa_el_rango(cliente, pool, conn):
    conn.responder("fetch", "from entrega_items i", [])
    await cliente.get("/ranking/productos", params=RANGO)
    (_, sql, args) = conn.sql_ejecutado("from entrega_items i")[0]
    assert "e.estado != 'duplicado_bloqueado'" in sql
    assert "e.sede_origen_id" not in sql
    assert args == (datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 31, 23, 59, 59, tzinfo=UTC))


async def test_endpoint_filtra_por_sede_con_parametro_y_no_por_texto(cliente, pool, conn):
    conn.responder("fetch", "from entrega_items i", [])
    peligrosa = "s1' or '1'='1"
    res = await cliente.get("/ranking/productos", params={**RANGO, "sede_id": peligrosa})
    assert res.status_code == 200 and res.json()["sede_id"] == peligrosa
    (_, sql, args) = conn.sql_ejecutado("from entrega_items i")[0]
    assert "e.sede_origen_id = $3" in sql and peligrosa not in sql
    assert args[2] == peligrosa


async def test_endpoint_respeta_limit(cliente, pool, conn):
    conn.responder("fetch", "from entrega_items i", [fila(f"1000{n} P{n}", n, f"e{n}") for n in range(1, 6)])
    res = await cliente.get("/ranking/productos", params={**RANGO, "limit": 2})
    assert len(res.json()["mas_vendidos"]) == len(res.json()["menos_vendidos"]) == 2


@pytest.mark.parametrize("params", [{}, {"desde": "2026-01-01T00:00:00Z"}, {"hasta": "2026-01-31T00:00:00Z"}, {"desde": "ayer", "hasta": "hoy"}])
async def test_endpoint_exige_un_rango_de_fechas_valido(cliente, pool, conn, params):
    res = await cliente.get("/ranking/productos", params=params)
    assert res.status_code == 422
    assert conn.llamadas == []
