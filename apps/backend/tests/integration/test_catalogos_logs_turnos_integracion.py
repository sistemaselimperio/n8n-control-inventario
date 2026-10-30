"""Productos, tipos de documento, logs y turnos contra Postgres real."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from tests.integration.datos_admin import insertar_log, nueva_sede, sesion_dashboard

pytestmark = pytest.mark.integration


# --------------------------------------------------------------------------
# Productos
# --------------------------------------------------------------------------


async def test_crud_de_productos_contra_la_base(cliente, pg, admin_headers):
    creado = await cliente.post("/productos", json={"codigo": "12345", "nombre": "SAL"}, headers=admin_headers)
    assert creado.status_code == 201
    id_ = creado.json()["id"]
    assert (await cliente.post("/productos", json={"codigo": "12345", "nombre": "OTRA"}, headers=admin_headers)).status_code == 409

    editado = await cliente.patch(f"/productos/{id_}", json={"nombre": "  Sal fina  "}, headers=admin_headers)
    assert editado.status_code == 200 and editado.json()["nombre"] == "Sal fina" and editado.json()["codigo"] == "12345"

    await cliente.post("/productos", json={"codigo": "99999", "nombre": "AZUCAR"}, headers=admin_headers)
    choque = await cliente.patch(f"/productos/{id_}", json={"codigo": "99999"}, headers=admin_headers)
    assert choque.status_code == 409
    assert await pg.fetchval("select codigo from productos where id = $1::uuid", id_) == "12345"

    assert (await cliente.delete(f"/productos/{id_}", headers=admin_headers)).status_code == 200
    assert (await cliente.delete(f"/productos/{id_}", headers=admin_headers)).status_code == 404
    assert (await cliente.patch(f"/productos/{id_}", json={"nombre": "x"}, headers=admin_headers)).status_code == 404


async def test_buscar_productos_sin_distinguir_mayusculas_en_codigo_o_nombre(cliente, pg):
    await pg.execute("insert into productos (codigo, nombre) values ('12345', 'Sal Blanca'), ('777', 'Azucar')")
    por_nombre = (await cliente.get("/productos", params={"buscar": "sal"})).json()
    assert [p["codigo"] for p in por_nombre] == ["12345"]
    por_codigo = (await cliente.get("/productos", params={"buscar": "77"})).json()
    assert [p["nombre"] for p in por_codigo] == ["Azucar"]
    todos = (await cliente.get("/productos")).json()
    assert [p["codigo"] for p in todos] == ["12345", "777"]  # ordenados por codigo
    assert (await cliente.get("/productos", params={"buscar": "x'; drop table productos; --"})).json() == []
    assert await pg.fetchval("select count(*) from productos") == 2


async def test_un_supervisor_de_bodega_edita_el_catalogo_y_uno_de_traslados_no(cliente, pg):
    bodega = await sesion_dashboard(pg, "sup-bodega", "supervisor", "bodega")
    traslados = await sesion_dashboard(pg, "sup-traslados", "supervisor", "traslados")
    assert (await cliente.post("/productos", json={"codigo": "1", "nombre": "A"}, headers=bodega)).status_code == 201
    assert (await cliente.post("/productos", json={"codigo": "2", "nombre": "B"}, headers=traslados)).status_code == 403
    assert await pg.fetchval("select count(*) from productos") == 1


@pytest.mark.parametrize("metodo", ["patch", "delete"])
async def test_un_id_de_producto_que_no_es_uuid_no_debe_dar_500(cliente, pg, admin_headers, metodo):
    """Regresion: el id llegaba como `str` y el cast `$1::uuid` reventaba con
    DataError (HTTP 500). Debe responder 404/422, como el resto de /creador."""
    res = await cliente.request(metodo.upper(), "/productos/no-es-uuid", json={"nombre": "X"}, headers=admin_headers)
    assert res.status_code in (404, 422)


# --------------------------------------------------------------------------
# Tipos de documento
# --------------------------------------------------------------------------


async def test_crud_de_tipos_de_documento(cliente, pg, admin_headers):
    codigo = f"T{uuid4().hex[:5].upper()}"
    creado = await cliente.post("/tipos-documento", json={"codigo": codigo.lower(), "descripcion": " prueba "}, headers=admin_headers)
    assert creado.status_code == 201 and creado.json()["codigo"] == codigo and creado.json()["descripcion"] == "prueba"
    assert (await cliente.post("/tipos-documento", json={"codigo": codigo}, headers=admin_headers)).status_code == 409

    publico = {t["codigo"] for t in (await cliente.get("/tipos-documento")).json()}
    assert codigo in publico and "FEI" in publico  # incluye la semilla
    await cliente.patch(f"/tipos-documento/{codigo}", json={"activo": False}, headers=admin_headers)
    assert codigo not in {t["codigo"] for t in (await cliente.get("/tipos-documento")).json()}
    completo = (await cliente.get("/tipos-documento", params={"incluir_inactivos": "true"}, headers=admin_headers)).json()
    assert [t["activo"] for t in completo if t["codigo"] == codigo] == [False]

    assert (await cliente.delete(f"/tipos-documento/{codigo}", headers=admin_headers)).status_code == 200
    assert (await cliente.patch(f"/tipos-documento/{codigo}", json={"activo": True}, headers=admin_headers)).status_code == 404


async def test_listado_de_tipos_con_inactivos_no_es_publico(cliente, pg):
    assert (await cliente.get("/tipos-documento", params={"incluir_inactivos": "true"})).status_code == 401


async def test_la_frase_de_ejemplos_sale_de_los_tipos_activos(pg):
    from app.services import tipos_documento as servicio

    servicio.invalidar_cache()
    frase = await servicio.frase_ejemplos()
    assert "FEI o FV1 (factura)" in frase and "TB9 (traslado entre bodegas)" in frase
    servicio.invalidar_cache()


# --------------------------------------------------------------------------
# Logs
# --------------------------------------------------------------------------


async def test_logs_de_una_entidad_es_publico_y_trae_el_nombre_del_actor(cliente, pg):
    emp = str(await pg.fetchval("insert into empleados (nombre, sede_id, rol) values ('Luis', 's', 'operador') returning id"))
    await insertar_log(pg, entidad_id="e1", actor_id=emp)
    await insertar_log(pg, entidad_id="e1", actor_id="system")
    await insertar_log(pg, entidad_id="otra")
    res = await cliente.get("/logs", params={"entidad_id": "e1"})
    assert res.status_code == 200
    por_actor = {f["actor_id"]: f for f in res.json()}
    assert len(res.json()) == 2
    assert por_actor[emp]["actor_nombre"] == "Luis" and por_actor[emp]["actor_rol"] == "operador"
    assert por_actor["system"]["actor_nombre"] is None  # sin match en empleados
    assert isinstance(res.json()[0]["id"], str)


async def test_logs_sin_sesion_ni_entidad_da_401_y_con_sesion_lista_lo_mas_reciente_primero(cliente, pg):
    for n in range(3):
        await insertar_log(pg, entidad_id=f"e{n}")
        await pg.execute("update logs set \"timestamp\" = now() - ($1 * interval '1 hour') where entidad_id = $2", 3 - n, f"e{n}")
    assert (await cliente.get("/logs")).status_code == 401
    headers = await sesion_dashboard(pg, "consulta1", "consulta")
    res = await cliente.get("/logs", headers=headers)
    assert [f["entidad_id"] for f in res.json()] == ["e2", "e1", "e0"]
    limitado = await cliente.get("/logs", params={"limit": 2}, headers=headers)
    assert [f["entidad_id"] for f in limitado.json()] == ["e2", "e1"]


async def test_logs_filtra_por_sede_y_entidad_a_la_vez(cliente, pg):
    await insertar_log(pg, entidad_id="e1", sede_id="s1")
    await insertar_log(pg, entidad_id="e1", sede_id="s2")
    await insertar_log(pg, entidad_id="e2", sede_id="s1")
    res = await cliente.get("/logs", params={"entidad_id": "e1", "sede_id": "s1"})
    assert len(res.json()) == 1


@pytest.mark.parametrize("limit", [-1, 0])
async def test_logs_con_limit_negativo_no_debe_dar_500(cliente, pg, limit):
    """Regresion: `limit` iba tal cual a LIMIT y Postgres rechaza uno negativo
    (HTTP 500). Debe validarse en la entrada (422)."""
    await insertar_log(pg, entidad_id="e1")
    res = await cliente.get("/logs", params={"entidad_id": "e1", "limit": limit})
    assert res.status_code == 422


async def test_logs_con_limit_enorme_se_acota(cliente, pg):
    """Un pedido anonimo con limit gigante no debe poder volcar toda la tabla."""
    res = await cliente.get("/logs", params={"entidad_id": "e1", "limit": 10_000_000})
    assert res.status_code == 422


# --------------------------------------------------------------------------
# Turnos
# --------------------------------------------------------------------------


async def test_crear_y_listar_turnos(cliente, pg):
    cuerpo = {"empleado_id": "e1", "sede_id": "s1", "fecha": "2026-03-05", "hora_inicio": "08:00:00", "hora_fin": "12:00:00"}
    creado = await cliente.post("/turnos", json=cuerpo)
    assert creado.status_code == 201
    await cliente.post("/turnos", json={**cuerpo, "sede_id": "s2", "fecha": "2026-03-01", "origen": "sugerido_ia"})
    todos = (await cliente.get("/turnos")).json()
    assert [t["fecha"] for t in todos] == ["2026-03-01", "2026-03-05"]  # por fecha
    assert todos[0]["origen"] == "sugerido_ia" and isinstance(todos[0]["id"], str)
    assert [t["id"] for t in (await cliente.get("/turnos", params={"sede_id": "s1"})).json()] == [creado.json()["id"]]


async def test_recomendaciones_de_turnos_mas_recientes_primero(cliente, pg):
    for semana in ("2026-W09", "2026-W11", "2026-W10"):
        await pg.execute("insert into shift_recommendations (sede_id, semana_iso, bloques_sugeridos) values ('s1', $1, '[]')", semana)
    await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ('s2', '2026-W12')")
    res = (await cliente.get("/turnos/recomendaciones", params={"sede_id": "s1"})).json()
    assert [r["semana_iso"] for r in res] == ["2026-W11", "2026-W10", "2026-W09"]
    assert res[0]["bloques_sugeridos"] == []
    assert len((await cliente.get("/turnos/recomendaciones")).json()) == 4


async def _entregas(pg, sede: str, cantidad: int, cuando: datetime, prefijo: str) -> None:
    for n in range(cantidad):
        await pg.execute(
            """
            insert into entregas (tipo, indicativo_numero, hash_evidencia, sede_origen_id, estado,
                                  evidencia_url, operador_id, capturado_at)
            values ('XYZ', $1, $1, $2, 'procesada', 'https://e.prueba/f.webp', 'op', $3)
            """,
            f"{prefijo}-{n}", sede, cuando,
        )


async def test_carga_por_hora_usa_la_hora_local_de_la_sede_y_marca_los_picos(cliente, pg):
    sede = await nueva_sede(pg)  # timezone por defecto: America/Bogota (UTC-5)
    base = datetime.now(timezone.utc) - timedelta(days=30)
    lunes = (base - timedelta(days=base.weekday())).replace(hour=15, minute=0, second=0, microsecond=0)  # 10:00 local
    await _entregas(pg, sede, 8, lunes, "pico")
    for hora_utc in (13, 14, 16, 17, 18, 19, 20, 21, 22):
        await _entregas(pg, sede, 1, lunes.replace(hour=hora_utc), f"v{hora_utc}")

    res = await cliente.get("/turnos/carga", params={"sede_id": sede})
    cuerpo = res.json()
    assert res.status_code == 200 and cuerpo["semanas"] >= 4
    picos = [(c["dia"], c["hora"]) for c in cuerpo["celdas"] if c["pico"]]
    assert picos == [(0, 10)]  # lunes 10:00 local, no 15:00 UTC
    assert cuerpo["bloques"][0]["hora_inicio"] == "10:00:00" and cuerpo["bloques"][0]["dia"] == "lunes"
    assert cuerpo["umbral_pico"] is not None


async def test_carga_por_hora_excluye_otras_sedes_duplicados_bloqueados_y_lo_viejo(cliente, pg):
    sede = await nueva_sede(pg)
    ahora = datetime.now(timezone.utc)
    await _entregas(pg, "otra-sede", 3, ahora - timedelta(days=2), "ajena")
    await _entregas(pg, sede, 3, ahora - timedelta(days=400), "vieja")
    await _entregas(pg, sede, 2, ahora - timedelta(days=2), "dup")
    await pg.execute("update entregas set estado = 'duplicado_bloqueado' where indicativo_numero like 'dup-%'")
    res = (await cliente.get("/turnos/carga", params={"sede_id": sede})).json()
    assert res["celdas"] == [] and res["bloques"] == [] and res["umbral_pico"] is None


async def test_carga_por_hora_de_una_sede_inexistente_responde_vacio(cliente, pg):
    res = await cliente.get("/turnos/carga", params={"sede_id": str(uuid4())})
    assert res.status_code == 200 and res.json()["celdas"] == []
