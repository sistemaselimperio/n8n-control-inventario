"""Endpoints del traslado "desde bodega" en app/routers/traslados_puntos.py:
permisos, validacion de entrada y mapeo de errores a HTTP. Los servicios se
sustituyen por dobles; su logica se prueba en test_traslados_bodega_servicio.py."""

import json
import uuid

import pytest

from app.routers import traslados_puntos as rt
from app.services import storage_evidencia as st
from app.services import traslados_puntos as tp
from tests.helpers import encabezado_bearer, fila_usuario_dashboard
from tests.helpers_traslados import PUNTO_DESTINO

TRASLADO = str(uuid.uuid4())
PDF = b"%PDF-1.4\n%contenido de prueba\n"
RUTA_BORRADOR = "/traslados-puntos/desde-bodega/borrador"
RUTA_ALTA = "/traslados-puntos/desde-bodega"
RUTA_EDITAR = f"/traslados-puntos/{TRASLADO}/desde-bodega"
RUTA_ANULAR = f"/traslados-puntos/{TRASLADO}/anular"


def _datos(**extra) -> dict:
    cuerpo = {
        "numero": "NPT-1839",
        "fecha": "2026-11-02",
        "concepto": "SUGERIDO",
        "origen": "BODEGA VENTAS",
        "punto_destino_id": PUNTO_DESTINO,
        "elaboro": "YOHANA",
        "items": [{"referencia": "02058", "detalle": "C. CONTELAC", "empaque": "BULTO", "cantidad": 15, "precio": 75700}],
    }
    cuerpo.update(extra)
    return cuerpo


def _resultado(**extra) -> dict:
    resultado = {
        "id": uuid.UUID(TRASLADO),
        "punto_destino_id": uuid.UUID(PUNTO_DESTINO),
        "punto_origen_id": None,
        "creado_por": None,
        "creado_por_usuario": None,
        "tipo": "desde_bodega",
        "estado": "en_transito",
        "items": [{"id": uuid.uuid4(), "traslado_id": uuid.UUID(TRASLADO), "cantidad": 15, "referencia": "02058"}],
    }
    resultado.update(extra)
    return resultado


def _servicio(monkeypatch, nombre, resultado=None, *, lanza=None, llamadas=None):
    async def _doble(*args, **kwargs):
        if llamadas is not None:
            llamadas.append((args, kwargs))
        if lanza is not None:
            raise lanza
        return resultado() if callable(resultado) else resultado

    monkeypatch.setattr(rt, nombre, _doble)


def _sesion(conn, **kwargs) -> dict:
    fila = fila_usuario_dashboard(**kwargs)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def _archivo(contenido=PDF, tipo="application/pdf"):
    return {"archivo": ("NPT 1839.pdf", contenido, tipo)}


# --------------------------- permisos ---------------------------

_PETICIONES = {
    "borrador": lambda c, h: c.post(RUTA_BORRADOR, files=_archivo(), headers=h),
    "alta": lambda c, h: c.post(RUTA_ALTA, files=_archivo(), data={"datos": json.dumps(_datos())}, headers=h),
    "editar": lambda c, h: c.patch(RUTA_EDITAR, json=_datos(), headers=h),
    "anular": lambda c, h: c.post(RUTA_ANULAR, json={"motivo": "Error de digitacion"}, headers=h),
}
_SERVICIOS = {
    "borrador": "generar_borrador",
    "alta": "crear_desde_bodega",
    "editar": "editar_desde_bodega",
    "anular": "anular_desde_bodega",
}


@pytest.mark.parametrize("operacion", list(_PETICIONES))
async def test_sin_credenciales_responde_401_sin_llamar_al_servicio(cliente, pool, monkeypatch, operacion):
    llamadas: list = []
    _servicio(monkeypatch, _SERVICIOS[operacion], _resultado(), llamadas=llamadas)
    res = await _PETICIONES[operacion](cliente, {})
    assert res.status_code == 401 and llamadas == []


@pytest.mark.parametrize("operacion", list(_PETICIONES))
@pytest.mark.parametrize(
    "rol, area, codigo",
    [
        ("admin", "todo", 200),
        ("supervisor", "todo", 200),
        ("supervisor", "traslados", 200),
        ("supervisor", "bodega", 403),
        ("consulta", "traslados", 403),
        ("consulta", "todo", 403),
    ],
)
async def test_permisos_por_rol_y_area(cliente, pool, conn, monkeypatch, operacion, rol, area, codigo):
    llamadas: list = []
    resultado = {"numero": "NPT-1839", "items": []} if operacion == "borrador" else _resultado()
    _servicio(monkeypatch, _SERVICIOS[operacion], resultado, llamadas=llamadas)
    res = await _PETICIONES[operacion](cliente, _sesion(conn, rol=rol, area=area))
    assert res.status_code in ({200, 201} if codigo == 200 else {codigo})
    assert bool(llamadas) == (codigo == 200)  # un 403 jamas llega a escribir


# --------------------------- borrador ---------------------------


async def test_borrador_devuelve_lo_que_lee_el_servicio(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    borrador = {"numero": "NPT-1839", "items": [], "advertencias": [], "punto_destino_id": PUNTO_DESTINO}
    _servicio(monkeypatch, "generar_borrador", borrador, llamadas=llamadas)
    res = await cliente.post(RUTA_BORRADOR, files=_archivo(), headers=admin_headers)
    assert res.status_code == 200 and res.json() == borrador
    assert llamadas[0][0][0] == PDF


async def test_borrador_pdf_ilegible_responde_422(cliente, pool, monkeypatch, admin_headers):
    _servicio(monkeypatch, "generar_borrador", lanza=rt.PdfTrasladoInvalido("El PDF no tiene texto legible"))
    res = await cliente.post(RUTA_BORRADOR, files=_archivo(), headers=admin_headers)
    assert res.status_code == 422 and "texto" in res.json()["detail"]


async def test_borrador_archivo_de_mas_de_5_mb_responde_413_sin_llamar_al_servicio(
    cliente, pool, monkeypatch, admin_headers
):
    llamadas: list = []
    _servicio(monkeypatch, "generar_borrador", {}, llamadas=llamadas)
    grande = PDF + b"0" * (tp.MAX_BYTES_REPORTE_SYSCAFE + 1)
    res = await cliente.post(RUTA_BORRADOR, files=_archivo(grande), headers=admin_headers)
    assert res.status_code == 413 and llamadas == []


async def test_borrador_sin_archivo_responde_422(cliente, pool, admin_headers):
    res = await cliente.post(RUTA_BORRADOR, headers=admin_headers)
    assert res.status_code == 422


# --------------------------- alta ---------------------------


async def test_alta_responde_201_con_items_serializados(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    _servicio(monkeypatch, "crear_desde_bodega", _resultado(), llamadas=llamadas)
    res = await cliente.post(
        RUTA_ALTA, files=_archivo(), data={"datos": json.dumps(_datos())}, headers=admin_headers
    )
    assert res.status_code == 201
    cuerpo = res.json()
    assert cuerpo["id"] == TRASLADO and cuerpo["items"][0]["traslado_id"] == TRASLADO
    (args, kwargs) = llamadas[0]
    assert args[0] == PDF and args[1].numero == "NPT-1839"
    assert kwargs["usuario_id"] is None and kwargs["actor"] == "dashboard:token"


async def test_alta_pasa_el_usuario_de_la_sesion(cliente, pool, conn, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "crear_desde_bodega", _resultado(), llamadas=llamadas)
    fila = fila_usuario_dashboard(rol="supervisor", area="traslados")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    await cliente.post(
        RUTA_ALTA, files=_archivo(), data={"datos": json.dumps(_datos())}, headers=encabezado_bearer(fila)
    )
    (_, kwargs) = llamadas[0]
    assert kwargs["usuario_id"] == fila["id"]


@pytest.mark.parametrize(
    "datos",
    [
        "no es json",
        json.dumps(_datos(items=[])),
        json.dumps(_datos(origen="  ")),
        json.dumps(_datos(items=[{"referencia": "1", "detalle": "X", "cantidad": 0, "precio": 1}])),
        json.dumps(_datos(items=[{"referencia": "1", "detalle": "X", "cantidad": 2.5, "precio": 1}])),
        json.dumps(_datos(items=[{"referencia": "", "detalle": "X", "cantidad": 1, "precio": 1}])),
        json.dumps(_datos(items=[{"referencia": "1", "detalle": "X", "cantidad": 1, "precio": -1}])),
    ],
)
async def test_alta_valida_la_entrada(cliente, pool, monkeypatch, admin_headers, datos):
    llamadas: list = []
    _servicio(monkeypatch, "crear_desde_bodega", _resultado(), llamadas=llamadas)
    res = await cliente.post(RUTA_ALTA, files=_archivo(), data={"datos": datos}, headers=admin_headers)
    assert res.status_code == 422 and llamadas == []


async def test_alta_sin_datos_responde_422(cliente, pool, admin_headers):
    res = await cliente.post(RUTA_ALTA, files=_archivo(), headers=admin_headers)
    assert res.status_code == 422


@pytest.mark.parametrize(
    "error, codigo",
    [
        (tp.SyscafeDuplicado("El traslado NPT-1839 ya fue cargado"), 409),
        (tp.TrasladoInvalido("El punto de destino no existe o está inactivo"), 422),
        (tp.ArchivoReporteNoPermitido("El archivo no es un PDF válido"), 415),
        (tp.ArchivoReporteMuyGrande("El archivo supera los 5 MB"), 413),
        (st.StorageNoDisponible("Storage no está configurado"), 502),
    ],
)
async def test_alta_mapea_errores(cliente, pool, monkeypatch, admin_headers, error, codigo):
    _servicio(monkeypatch, "crear_desde_bodega", lanza=error)
    res = await cliente.post(RUTA_ALTA, files=_archivo(), data={"datos": json.dumps(_datos())}, headers=admin_headers)
    assert res.status_code == codigo and res.json()["detail"] == str(error)


# --------------------------- edicion y anulacion ---------------------------


async def test_editar_responde_el_traslado_actualizado(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    _servicio(monkeypatch, "editar_desde_bodega", _resultado(concepto="NUEVO"), llamadas=llamadas)
    res = await cliente.patch(RUTA_EDITAR, json=_datos(concepto="NUEVO"), headers=admin_headers)
    assert res.status_code == 200 and res.json()["concepto"] == "NUEVO"
    assert llamadas[0][0][0] == TRASLADO


@pytest.mark.parametrize(
    "error, codigo",
    [
        (tp.TrasladoNoEncontrado("Traslado no encontrado"), 404),
        (tp.TrasladoYaRecibido("Este traslado ya fue recibido y no se puede modificar"), 409),
        (tp.SyscafeDuplicado("El traslado NPT-1 ya fue cargado"), 409),
        (tp.TrasladoInvalido("Solo se pueden editar o anular los traslados desde bodega"), 422),
    ],
)
async def test_editar_y_anular_mapean_errores(cliente, pool, monkeypatch, admin_headers, error, codigo):
    _servicio(monkeypatch, "editar_desde_bodega", lanza=error)
    _servicio(monkeypatch, "anular_desde_bodega", lanza=error)
    r1 = await cliente.patch(RUTA_EDITAR, json=_datos(), headers=admin_headers)
    r2 = await cliente.post(RUTA_ANULAR, json={"motivo": "x"}, headers=admin_headers)
    assert r1.status_code == codigo and r2.status_code == codigo
    assert r1.json()["detail"] == str(error)


async def test_anular_pasa_motivo_y_nombre_del_usuario(cliente, pool, conn, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "anular_desde_bodega", _resultado(estado="anulado"), llamadas=llamadas)
    fila = fila_usuario_dashboard(rol="supervisor", area="traslados")
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    res = await cliente.post(RUTA_ANULAR, json={"motivo": "  Cantidades mal  "}, headers=encabezado_bearer(fila))
    assert res.status_code == 200 and res.json()["estado"] == "anulado"
    (args, kwargs) = llamadas[0]
    assert args == (TRASLADO, "Cantidades mal")
    assert kwargs["usuario_id"] == fila["id"] and kwargs["nombre"] == fila["nombre"]


@pytest.mark.parametrize("cuerpo", [{}, {"motivo": ""}, {"motivo": "   "}, {"motivo": "x" * 501}])
async def test_anular_exige_motivo(cliente, pool, monkeypatch, admin_headers, cuerpo):
    llamadas: list = []
    _servicio(monkeypatch, "anular_desde_bodega", _resultado(), llamadas=llamadas)
    res = await cliente.post(RUTA_ANULAR, json=cuerpo, headers=admin_headers)
    assert res.status_code == 422 and llamadas == []


# --------------------------- listados ---------------------------


async def test_listado_acepta_el_tipo_desde_bodega(cliente, pool, conn):
    conn.responder("fetch", "from traslados_puntos t", [])
    res = await cliente.get("/traslados-puntos?tipo=desde_bodega")
    assert res.status_code == 200
    sql, args = conn.sql_ejecutado("from traslados_puntos t")[0][1:]
    assert args == ("desde_bodega",)


async def test_listado_sigue_rechazando_tipos_desconocidos(cliente, pool):
    res = await cliente.get("/traslados-puntos?tipo=otro")
    assert res.status_code == 422


async def test_consulta_de_traslados_muestra_origen_texto_y_creador_del_dashboard(cliente, pool, conn):
    conn.responder("fetch", "from traslados_puntos t", [])
    await cliente.get("/traslados-puntos")
    sql = conn.sql_ejecutado("from traslados_puntos t")[0][1]
    assert "coalesce(po.nombre, t.origen_texto)" in sql
    assert "usuarios_dashboard" in sql and "creado_por_usuario" in sql
