"""Traslado "desde bodega" contra Postgres real: checks del esquema, alta,
numero unico, edicion/anulacion mientras esta en transito y recepcion con
novedad por el flujo de siempre. Storage simulado."""

import pytest

from app.models.traslado_punto import SolucionNovedadDashboard, TrasladoDesdeBodegaDatos
from app.services import storage_evidencia as st
from app.services import traslados_bodega as tb
from app.services import traslados_puntos as tp
from tests.integration.conftest import eventos_en_logs
from tests.integration.datos_traslados import crear_usuario_dashboard, escenario, recepcion

pytestmark = pytest.mark.integration

PDF = b"%PDF-1.4\n%contenido de prueba\n"


@pytest.fixture(autouse=True)
def _storage(monkeypatch):
    async def subir(ruta, contenido, content_type):
        return None

    async def borrar(ruta):
        return None

    monkeypatch.setattr(st, "subir", subir)
    monkeypatch.setattr(st, "borrar", borrar)
    monkeypatch.setattr(st, "url_publica", lambda ruta: f"https://storage.prueba/{ruta}")


def datos(esc, **extra) -> TrasladoDesdeBodegaDatos:
    cuerpo = {
        "numero": "NPT-1839",
        "fecha": "2026-11-02",
        "concepto": "SUGERIDO",
        "origen": "BODEGA VENTAS",
        "punto_destino_id": esc.destino,
        "elaboro": "YOHANA",
        "items": [
            {"referencia": "02058", "detalle": "C. CONTELAC 18 P.", "empaque": "BULTO", "cantidad": 15, "precio": 75700},
            {"referencia": "1476", "detalle": "25-4-24 NUTRIMON", "empaque": "BULTO", "cantidad": 5, "precio": 140000.5},
        ],
    }
    cuerpo.update(extra)
    return TrasladoDesdeBodegaDatos(**cuerpo)


async def test_alta_guarda_traslado_en_transito_items_y_catalogo(pg):
    esc = await escenario(pg)
    usuario, _ = await crear_usuario_dashboard(pg)
    res = await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=usuario, actor="dashboard:ana")
    assert res["tipo"] == "desde_bodega" and res["estado"] == "en_transito"
    assert res["punto_origen_id"] is None and res["creado_por"] is None
    assert str(res["creado_por_usuario"]) == usuario
    assert res["numero_syscafe"] == "NPT-1839" and res["origen_texto"] == "BODEGA VENTAS"
    assert res["pdf_url"].startswith("https://storage.prueba/traslados-bodega/")
    referencias = {i["referencia"]: i for i in res["items"]}
    assert set(referencias) == {"02058", "1476"}  # ceros a la izquierda intactos
    assert float(referencias["1476"]["precio"]) == 140000.5
    codigos = {f["codigo"] for f in await pg.fetch("select codigo from productos")}
    assert codigos == {"02058", "1476"}
    assert "traslado_bodega_creado" in await eventos_en_logs(pg)


async def test_mismo_numero_dos_veces_se_bloquea(pg):
    esc = await escenario(pg)
    await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=None, actor="dashboard:token")
    with pytest.raises(tp.SyscafeDuplicado):
        await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=None, actor="dashboard:token")


async def test_editar_reemplaza_items_y_anular_libera_el_numero(pg):
    esc = await escenario(pg)
    creado = await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=None, actor="dashboard:token")
    traslado_id = str(creado["id"])
    nuevo = datos(esc, concepto="CORREGIDO", items=[{"referencia": "9", "detalle": "X", "cantidad": 1, "precio": 1}])
    editado = await tb.editar_desde_bodega(traslado_id, nuevo, usuario_id=None, actor="dashboard:token")
    assert editado["concepto"] == "CORREGIDO" and [i["referencia"] for i in editado["items"]] == ["9"]

    anulado = await tb.anular_desde_bodega(traslado_id, "Error", usuario_id=None, actor="dashboard:token", nombre="Ana")
    assert anulado["estado"] == "anulado" and anulado["numero_syscafe"] is None
    assert anulado["numero_documento"] == "NPT-1839"
    # El numero queda libre para cargar el PDF corregido.
    otro = await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=None, actor="dashboard:token")
    assert otro["estado"] == "en_transito"
    with pytest.raises(tp.TrasladoYaRecibido):
        await tb.editar_desde_bodega(traslado_id, nuevo, usuario_id=None, actor="dashboard:token")


async def test_recepcion_con_novedad_y_bloqueo_posterior(pg):
    esc = await escenario(pg)
    usuario, _ = await crear_usuario_dashboard(pg)
    creado = await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=usuario, actor="dashboard:ana")
    traslado_id = str(creado["id"])
    ids = [str(i["id"]) for i in creado["items"]]

    recibido = await tp.registrar_recepcion(traslado_id, recepcion(esc, [(ids[0], 14), (ids[1], 5)]))
    assert recibido["estado"] == "recibido_con_novedad" and recibido["novedad_estado"] == "pendiente"

    with pytest.raises(tp.TrasladoYaRecibido):
        await tb.editar_desde_bodega(traslado_id, datos(esc), usuario_id=None, actor="x")
    with pytest.raises(tp.TrasladoYaRecibido):
        await tb.anular_desde_bodega(traslado_id, "tarde", usuario_id=None, actor="x", nombre="Ana")

    resuelto = await tp.resolver_novedad(
        traslado_id,
        SolucionNovedadDashboard(solucion="Se ajusto", consecutivo_codigo="bdg", consecutivo_numero="1"),
        usuario_id=usuario,
    )
    assert resuelto["novedad_estado"] == "resuelta"


async def test_un_traslado_anulado_no_se_puede_recibir(pg):
    esc = await escenario(pg)
    creado = await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=None, actor="dashboard:token")
    traslado_id = str(creado["id"])
    await tb.anular_desde_bodega(traslado_id, "Error", usuario_id=None, actor="x", nombre="Ana")
    with pytest.raises(tp.TrasladoYaRecibido):
        await tp.registrar_recepcion(traslado_id, recepcion(esc, [(str(creado["items"][0]["id"]), 1)]))


async def test_listados_muestran_bodega_de_origen_y_creador(pg):
    esc = await escenario(pg)
    usuario, _ = await crear_usuario_dashboard(pg)
    await tb.crear_desde_bodega(PDF, datos(esc), usuario_id=usuario, actor="dashboard:ana")
    historial = await tp.listar_traslados_syscafe(None, False)
    (fila,) = [f for f in historial if f["tipo"] == "traslado"]
    assert fila["punto_origen_nombre"] == "BODEGA VENTAS" and fila["numero_documento"] == "NPT-1839"
    actividad = await tp.listar_actividad(10)
    assert actividad[0]["texto"].startswith("BODEGA VENTAS envió NPT-1839")
