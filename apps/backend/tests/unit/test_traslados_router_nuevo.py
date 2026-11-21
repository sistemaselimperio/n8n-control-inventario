"""Endpoints /traslados (app/routers/traslados.py): permisos por perfil,
validacion de entrada y mapeo de errores a HTTP. El servicio se sustituye por
dobles (su logica esta en test_traslados_servicio_nuevo.py)."""

import uuid

import pytest

from app.services import traslados as servicio
from app.services import traslados_reglas as r
from app.services.storage_evidencia import StorageNoDisponible
from tests.helpers import encabezado_bearer, fila_usuario_dashboard

TRASLADO = str(uuid.uuid4())
COMPROBANTE = str(uuid.uuid4())
PUNTO = str(uuid.uuid4())
PDF = b"%PDF-1.4\n%contenido de prueba\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 30


def _sesion(conn, rol="supervisor", area="traslados", punto_id=None, cedula="1234567") -> dict:
    fila = fila_usuario_dashboard(rol=rol, area=area, punto_id=punto_id, cedula=cedula)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def _doble(monkeypatch, nombre, resultado=None, *, lanza=None):
    llamadas: list = []

    async def _falso(*args, **kwargs):
        llamadas.append((args, kwargs))
        if lanza is not None:
            raise lanza
        return resultado

    monkeypatch.setattr(servicio, nombre, _falso)
    return llamadas


def _pdfs(*nombres):
    return [("archivos", (n, PDF, "application/pdf")) for n in nombres]


# Cada operacion: (servicio, resultado del doble, peticion, quien puede -> 200)
OPERACIONES = {
    "puntos": ("puntos_para_traslados", [], lambda c, h: c.get("/traslados/puntos", headers=h), "todos"),
    "listar_traslados": ("listar_traslados", {"total": 0, "items": []}, lambda c, h: c.get("/traslados", headers=h), "todos"),
    "detalle_traslado": ("detalle_traslado", {"id": TRASLADO}, lambda c, h: c.get(f"/traslados/{TRASLADO}", headers=h), "todos"),
    "listar_comprobantes": ("listar_comprobantes", {"total": 0, "items": []}, lambda c, h: c.get("/traslados/comprobantes", headers=h), "todos"),
    "detalle_comprobante": ("detalle_comprobante", {"id": COMPROBANTE}, lambda c, h: c.get(f"/traslados/comprobantes/{COMPROBANTE}", headers=h), "todos"),
    "subir": ("subir_pdfs", [], lambda c, h: c.post("/traslados/subir", files=_pdfs("a.pdf"), headers=h), "gestion"),
    "editar": ("editar_borrador", {"id": TRASLADO}, lambda c, h: c.patch(f"/traslados/{TRASLADO}", json={"numero": "NPT-1"}, headers=h), "gestion"),
    "enviar": ("enviar", {"id": TRASLADO}, lambda c, h: c.post(f"/traslados/{TRASLADO}/enviar", headers=h), "gestion"),
    "eliminar": ("eliminar", {"ok": True, "archivos_borrados": 0}, lambda c, h: c.delete(f"/traslados/{TRASLADO}", headers=h), "gestion"),
    "reenviar": ("reenviar", {"id": COMPROBANTE}, lambda c, h: c.post(f"/traslados/comprobantes/{COMPROBANTE}/reenviar", headers=h), "gestion"),
    # confirmar/devolver los abre el router a todo perfil con acceso; el servicio decide por estado y punto.
    "confirmar": ("confirmar", {"id": COMPROBANTE}, lambda c, h: c.post(f"/traslados/comprobantes/{COMPROBANTE}/confirmar", files={"firma": ("f.png", PNG, "image/png")}, headers=h), "resolucion"),
    "devolver": ("devolver", {"id": COMPROBANTE}, lambda c, h: c.post(f"/traslados/comprobantes/{COMPROBANTE}/devolver", json={"motivo": "Error"}, headers=h), "resolucion"),
}

PERFILES = {
    "admin": dict(rol="admin", area="todo"),
    "encargada": dict(rol="supervisor", area="traslados"),
    "punto": dict(rol="supervisor", area="traslados", punto_id=PUNTO),
    "lectura_traslados": dict(rol="consulta", area="traslados"),
    "lectura_todo": dict(rol="supervisor", area="todo"),
    "consulta_todo": dict(rol="consulta", area="todo"),
    "bodega": dict(rol="supervisor", area="bodega"),
}


def _permitido(quien: str, perfil: str) -> bool:
    if perfil == "bodega":
        return False
    if quien == "todos":
        return True
    if quien == "gestion":
        return perfil in ("admin", "encargada")
    # "resolucion": el router solo exige acceso de escritura (admin, encargada, punto);
    # la lectura nunca escribe.
    return perfil in ("admin", "encargada", "punto")


@pytest.mark.parametrize("operacion", list(OPERACIONES))
async def test_sin_sesion_responde_401_y_no_llama_al_servicio(cliente, pool, monkeypatch, operacion):
    nombre, resultado, peticion, _ = OPERACIONES[operacion]
    llamadas = _doble(monkeypatch, nombre, resultado)
    res = await peticion(cliente, {})
    assert res.status_code == 401 and llamadas == []


@pytest.mark.parametrize("operacion", list(OPERACIONES))
async def test_el_token_legacy_no_abre_el_modulo(cliente, pool, monkeypatch, admin_headers, operacion):
    nombre, resultado, peticion, _ = OPERACIONES[operacion]
    llamadas = _doble(monkeypatch, nombre, resultado)
    res = await peticion(cliente, admin_headers)
    assert res.status_code == 401 and llamadas == []


@pytest.mark.parametrize("perfil", list(PERFILES))
@pytest.mark.parametrize("operacion", list(OPERACIONES))
async def test_matriz_de_permisos(cliente, pool, conn, monkeypatch, operacion, perfil):
    nombre, resultado, peticion, quien = OPERACIONES[operacion]
    llamadas = _doble(monkeypatch, nombre, resultado)
    res = await peticion(cliente, _sesion(conn, **PERFILES[perfil]))
    if _permitido(quien, perfil):
        assert res.status_code == 200, res.text
        assert len(llamadas) == 1
    else:
        assert res.status_code == 403 and llamadas == []  # un 403 jamas llega al servicio


async def test_el_servicio_recibe_el_perfil_de_la_sesion(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "listar_comprobantes", {"total": 0, "items": []})
    await cliente.get("/traslados/comprobantes", headers=_sesion(conn, punto_id=PUNTO))
    perfil = llamadas[0][0][0]
    assert perfil.tipo == "punto" and perfil.punto_id == PUNTO


# --------------------------- rutas y parametros ---------------------------


async def test_rutas_estaticas_no_las_captura_el_id_del_traslado(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "listar_comprobantes", {"total": 0, "items": []})
    res = await cliente.get("/traslados/comprobantes", headers=_sesion(conn))
    assert res.status_code == 200 and len(llamadas) == 1
    assert (await cliente.get("/traslados/no-es-uuid", headers=_sesion(conn))).status_code == 422


async def test_filtros_de_comprobantes_llegan_al_servicio(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "listar_comprobantes", {"total": 0, "items": []})
    res = await cliente.get(
        "/traslados/comprobantes",
        params={"punto_id": PUNTO, "estado": "devuelto", "tipo": "ingreso", "q": " NPT-18 ", "limit": 25, "offset": 50},
        headers=_sesion(conn),
    )
    assert res.status_code == 200
    assert llamadas[0][1] == {"punto_id": PUNTO, "estado": "devuelto", "tipo": "ingreso", "q": "NPT-18", "limit": 25, "offset": 50}


async def test_filtros_por_defecto(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "listar_comprobantes", {"total": 0, "items": []})
    await cliente.get("/traslados/comprobantes", headers=_sesion(conn))
    assert llamadas[0][1] == {"punto_id": None, "estado": None, "tipo": None, "q": None, "limit": 50, "offset": 0}


@pytest.mark.parametrize(
    "params",
    [{"estado": "otro"}, {"tipo": "otro"}, {"punto_id": "x"}, {"limit": 0}, {"limit": 201}, {"offset": -1}, {"q": "x" * 101}],
)
async def test_filtros_invalidos_son_422(cliente, pool, conn, monkeypatch, params):
    llamadas = _doble(monkeypatch, "listar_comprobantes", {"total": 0, "items": []})
    res = await cliente.get("/traslados/comprobantes", params=params, headers=_sesion(conn))
    assert res.status_code == 422 and llamadas == []


async def test_listado_de_traslados_acepta_estado_borrador_o_enviado(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "listar_traslados", {"total": 0, "items": []})
    assert (await cliente.get("/traslados", params={"estado": "borrador"}, headers=_sesion(conn))).status_code == 200
    assert llamadas[0][1]["estado"] == "borrador"
    assert (await cliente.get("/traslados", params={"estado": "pendiente"}, headers=_sesion(conn))).status_code == 422


# --------------------------- subir ---------------------------


async def test_subir_varios_pdfs_devuelve_un_resultado_por_archivo(cliente, pool, conn, monkeypatch):
    resultados = [{"archivo": "a.pdf", "resultado": "creado"}, {"archivo": "b.pdf", "resultado": "duplicado"}]
    llamadas = _doble(monkeypatch, "subir_pdfs", resultados)
    res = await cliente.post("/traslados/subir", files=_pdfs("a.pdf", "b.pdf"), headers=_sesion(conn))
    assert res.status_code == 200 and res.json() == {"resultados": resultados}
    archivos = llamadas[0][0][0]
    assert [(n, c) for n, c in archivos] == [("a.pdf", PDF), ("b.pdf", PDF)]


async def test_subir_sin_archivos_es_422(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "subir_pdfs", [])
    res = await cliente.post("/traslados/subir", headers=_sesion(conn))
    assert res.status_code == 422 and llamadas == []


async def test_subir_demasiados_archivos_es_413(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "subir_pdfs", [])
    nombres = [f"{i}.pdf" for i in range(r.MAX_ARCHIVOS_POR_PETICION + 1)]
    res = await cliente.post("/traslados/subir", files=_pdfs(*nombres), headers=_sesion(conn))
    assert res.status_code == 413 and llamadas == []


async def test_un_archivo_enorme_se_recorta_para_que_el_servicio_lo_reporte(cliente, pool, conn, monkeypatch):
    """No se carga entero en memoria: se lee un byte de mas y el servicio informa el error de ese archivo."""
    llamadas = _doble(monkeypatch, "subir_pdfs", [])
    grande = b"%PDF-" + b"0" * (r.MAX_BYTES_PDF + 500)
    res = await cliente.post("/traslados/subir", files=[("archivos", ("g.pdf", grande, "application/pdf"))], headers=_sesion(conn))
    assert res.status_code == 200
    assert len(llamadas[0][0][0][0][1]) == r.MAX_BYTES_PDF + 1


# --------------------------- editar / enviar / eliminar ---------------------------


async def test_editar_pasa_solo_los_campos_enviados_incluidos_los_null(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "editar_borrador", {"id": TRASLADO})
    res = await cliente.patch(
        f"/traslados/{TRASLADO}", json={"numero": "NPT-1", "destino_punto_id": None, "fecha": "2026-11-02"}, headers=_sesion(conn)
    )
    assert res.status_code == 200
    import datetime

    assert llamadas[0][0][2] == {"numero": "NPT-1", "destino_punto_id": None, "fecha": datetime.date(2026, 11, 2)}


async def test_editar_sin_cambios_o_con_punto_invalido_es_422(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "editar_borrador", {"id": TRASLADO})
    assert (await cliente.patch(f"/traslados/{TRASLADO}", json={}, headers=_sesion(conn))).status_code == 422
    assert (await cliente.patch(f"/traslados/{TRASLADO}", json={"origen_punto_id": "x"}, headers=_sesion(conn))).status_code == 422
    assert llamadas == []


async def test_enviar_incompleto_devuelve_422_con_las_advertencias(cliente, pool, conn, monkeypatch):
    _doble(monkeypatch, "enviar", lanza=r.NoSePuedeEnviar([r.MSG_SIN_NUMERO, r.MSG_SIN_DESTINO]))
    res = await cliente.post(f"/traslados/{TRASLADO}/enviar", headers=_sesion(conn))
    assert res.status_code == 422
    assert res.json()["advertencias"] == [r.MSG_SIN_NUMERO, r.MSG_SIN_DESTINO]
    assert "No se puede enviar" in res.json()["detail"]


# --------------------------- confirmar ---------------------------


async def test_confirmar_pasa_la_firma_y_la_observacion(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "confirmar", {"id": COMPROBANTE})
    res = await cliente.post(
        f"/traslados/comprobantes/{COMPROBANTE}/confirmar",
        files={"firma": ("firma.png", PNG, "image/png")},
        data={"observacion": "Todo completo"},
        headers=_sesion(conn, punto_id=PUNTO),
    )
    assert res.status_code == 200
    args = llamadas[0][0]
    assert args[1] == COMPROBANTE and args[2] == PNG and args[3] == "Todo completo"


async def test_confirmar_sin_firma_es_422(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "confirmar", {"id": COMPROBANTE})
    res = await cliente.post(f"/traslados/comprobantes/{COMPROBANTE}/confirmar", headers=_sesion(conn, punto_id=PUNTO))
    assert res.status_code == 422 and llamadas == []


async def test_una_firma_enorme_se_recorta_a_un_byte_de_mas(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "confirmar", {"id": COMPROBANTE})
    grande = PNG + b"0" * (r.MAX_BYTES_FIRMA + 500)
    await cliente.post(
        f"/traslados/comprobantes/{COMPROBANTE}/confirmar",
        files={"firma": ("f.png", grande, "image/png")},
        headers=_sesion(conn, punto_id=PUNTO),
    )
    assert len(llamadas[0][0][2]) == r.MAX_BYTES_FIRMA + 1


# --------------------------- devolver ---------------------------


async def test_devolver_pasa_el_motivo_limpio(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "devolver", {"id": COMPROBANTE})
    res = await cliente.post(
        f"/traslados/comprobantes/{COMPROBANTE}/devolver", json={"motivo": "  Número mal  "}, headers=_sesion(conn, punto_id=PUNTO)
    )
    assert res.status_code == 200 and llamadas[0][0][2] == "Número mal"


@pytest.mark.parametrize("cuerpo", [{}, {"motivo": ""}, {"motivo": "   "}, {"motivo": "x" * 501}])
async def test_devolver_sin_motivo_valido_es_422(cliente, pool, conn, monkeypatch, cuerpo):
    llamadas = _doble(monkeypatch, "devolver", {"id": COMPROBANTE})
    res = await cliente.post(f"/traslados/comprobantes/{COMPROBANTE}/devolver", json=cuerpo, headers=_sesion(conn, punto_id=PUNTO))
    assert res.status_code == 422 and llamadas == []


# --------------------------- reenviar ---------------------------


async def test_reenviar_sin_campos_no_cambia_nada(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "reenviar", {"id": COMPROBANTE})
    res = await cliente.post(f"/traslados/comprobantes/{COMPROBANTE}/reenviar", headers=_sesion(conn))
    assert res.status_code == 200
    assert llamadas[0][1] == {"numero": None, "punto_id": None, "pdf": None, "pdf_nombre": None}


async def test_reenviar_con_correcciones_y_pdf(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "reenviar", {"id": COMPROBANTE})
    res = await cliente.post(
        f"/traslados/comprobantes/{COMPROBANTE}/reenviar",
        data={"numero": "NPT-1840", "punto_id": PUNTO},
        files={"archivo": ("nuevo.pdf", PDF, "application/pdf")},
        headers=_sesion(conn),
    )
    assert res.status_code == 200
    assert llamadas[0][1] == {"numero": "NPT-1840", "punto_id": PUNTO, "pdf": PDF, "pdf_nombre": "nuevo.pdf"}


async def test_reenviar_con_punto_invalido_es_422(cliente, pool, conn, monkeypatch):
    llamadas = _doble(monkeypatch, "reenviar", {"id": COMPROBANTE})
    res = await cliente.post(f"/traslados/comprobantes/{COMPROBANTE}/reenviar", data={"punto_id": "x"}, headers=_sesion(conn))
    assert res.status_code == 422 and llamadas == []


# --------------------------- errores del servicio ---------------------------


@pytest.mark.parametrize(
    "excepcion, codigo",
    [
        (r.TrasladoNoEncontrado("no existe"), 404),
        (r.SinPermiso("no puedes"), 403),
        (r.EstadoNoPermitido("estado"), 409),
        (r.ComprobanteDuplicado("duplicado"), 409),
        (r.DatoInvalido("dato"), 422),
        (servicio.PdfTrasladoInvalido("pdf"), 422),
        (StorageNoDisponible("storage"), 502),
    ],
)
async def test_errores_del_servicio_se_traducen_a_http(cliente, pool, conn, monkeypatch, excepcion, codigo):
    _doble(monkeypatch, "devolver", lanza=excepcion)
    res = await cliente.post(
        f"/traslados/comprobantes/{COMPROBANTE}/devolver", json={"motivo": "x"}, headers=_sesion(conn, punto_id=PUNTO)
    )
    assert res.status_code == codigo
    assert res.json()["detail"] == str(excepcion)


async def test_el_borrado_responde_lo_que_devuelve_el_servicio(cliente, pool, conn, monkeypatch):
    _doble(monkeypatch, "eliminar", {"ok": True, "archivos_borrados": 3})
    res = await cliente.delete(f"/traslados/{TRASLADO}", headers=_sesion(conn))
    assert res.json() == {"ok": True, "archivos_borrados": 3}
