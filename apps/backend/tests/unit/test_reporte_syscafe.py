"""Reporte Syscafe de un traslado: servicio (validacion, Storage, UPDATE
condicional, log) y endpoint del dashboard (guardas y mapeo de errores).

Storage se sustituye por un doble; nada sale a la red."""

import io
import uuid

import httpx
import pytest
from PIL import Image

from app.models.log import EventoLog
from app.routers import traslados_puntos as rt
from app.services import storage_evidencia as st
from app.services import traslados_puntos as tp
from tests.helpers import encabezado_bearer, fila_usuario_dashboard
from tests.helpers_traslados import PUNTO_DESTINO, PUNTO_ORIGEN, USUARIO_ORIGEN

TRASLADO = str(uuid.uuid4())
PDF = b"%PDF-1.4\n%contenido de prueba\n"


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class StorageFalso:
    def __init__(self) -> None:
        self.subidos: list[tuple] = []
        self.borrados: list[str] = []
        self.error_subida: Exception | None = None

    async def subir(self, ruta, contenido, content_type):
        if self.error_subida is not None:
            raise self.error_subida
        self.subidos.append((ruta, contenido, content_type))

    async def borrar(self, ruta):
        self.borrados.append(ruta)

    def url_publica(self, ruta):
        return f"https://storage.prueba/{ruta}"


@pytest.fixture
def storage(monkeypatch) -> StorageFalso:
    falso = StorageFalso()
    monkeypatch.setattr(tp.storage_evidencia, "subir", falso.subir)
    monkeypatch.setattr(tp.storage_evidencia, "borrar", falso.borrar)
    monkeypatch.setattr(tp.storage_evidencia, "url_publica", falso.url_publica)
    return falso


def _fila(**extra) -> dict:
    fila = {
        "id": uuid.UUID(TRASLADO),
        "punto_destino_id": uuid.UUID(PUNTO_DESTINO),
        "reporte_syscafe_url": None,
    }
    fila.update(extra)
    return fila


def _preparar(conn, *, existente=True, reporte_previo=None, actualizado=True):
    conn.responder(
        "fetchrow",
        "select id, punto_destino_id",
        _fila(reporte_syscafe_url=reporte_previo) if existente else None,
    )
    conn.responder(
        "fetchrow",
        "update traslados_puntos set reporte_syscafe_url",
        (lambda *a: {"id": uuid.UUID(TRASLADO), "reporte_syscafe_url": a[1], "reporte_syscafe_tipo": a[2]})
        if actualizado
        else None,
    )
    conn.responder("fetch", "from traslado_punto_items", [])


# --------------------------- servicio ---------------------------


async def test_imagen_se_convierte_a_webp_y_se_guarda(pool, conn, storage):
    _preparar(conn)
    res = await tp.subir_reporte_syscafe(TRASLADO, _png(), "image/png", "Ana Prueba")
    ruta, contenido, tipo = storage.subidos[0]
    assert ruta == f"reportes-syscafe/{TRASLADO}.webp" and tipo == "image/webp"
    assert Image.open(io.BytesIO(contenido)).format == "WEBP"
    assert res["reporte_syscafe_url"] == f"https://storage.prueba/{ruta}"
    assert res["reporte_syscafe_tipo"] == "image/webp"
    assert res["items"] == []


async def test_pdf_se_guarda_tal_cual(pool, conn, storage):
    _preparar(conn)
    await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    assert storage.subidos == [(f"reportes-syscafe/{TRASLADO}.pdf", PDF, "application/pdf")]


async def test_registra_evento_con_quien_subio(pool, conn, storage):
    _preparar(conn)
    await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana Prueba")
    assert conn.eventos_log() == [EventoLog.TRASLADO_PUNTO_REPORTE_SYSCAFE.value]
    args = conn.inserts_log()[0]
    assert args[2] == TRASLADO and args[3] == "Ana Prueba" and args[4] == PUNTO_DESTINO


async def test_traslado_inexistente_lanza_404_sin_tocar_storage(pool, conn, storage):
    _preparar(conn, existente=False)
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    assert storage.subidos == []


async def test_traslado_con_reporte_lanza_409_sin_subir(pool, conn, storage):
    _preparar(conn, reporte_previo="https://x/y.pdf")
    with pytest.raises(tp.ReporteSyscafeYaExiste):
        await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    assert storage.subidos == []


@pytest.mark.parametrize("tipo", ["text/plain", "image/gif", "application/zip", ""])
async def test_tipo_no_permitido_lanza_415(pool, conn, storage, tipo):
    _preparar(conn)
    with pytest.raises(tp.ArchivoReporteNoPermitido):
        await tp.subir_reporte_syscafe(TRASLADO, b"hola", tipo, "Ana")
    assert storage.subidos == []


async def test_pdf_falso_lanza_415(pool, conn, storage):
    _preparar(conn)
    with pytest.raises(tp.ArchivoReporteNoPermitido):
        await tp.subir_reporte_syscafe(TRASLADO, b"no soy pdf", "application/pdf", "Ana")


async def test_imagen_corrupta_lanza_415(pool, conn, storage):
    _preparar(conn)
    with pytest.raises(tp.ArchivoReporteNoPermitido):
        await tp.subir_reporte_syscafe(TRASLADO, b"no soy imagen", "image/jpeg", "Ana")


async def test_archivo_de_mas_de_5_mb_lanza_413(pool, conn, storage):
    _preparar(conn)
    grande = PDF + b"0" * (tp.MAX_BYTES_REPORTE_SYSCAFE + 1)
    with pytest.raises(tp.ArchivoReporteMuyGrande):
        await tp.subir_reporte_syscafe(TRASLADO, grande, "application/pdf", "Ana")
    assert storage.subidos == []


async def test_objeto_ya_existente_en_storage_lanza_409_sin_borrar(pool, conn, storage):
    _preparar(conn)
    storage.error_subida = st.ObjetoYaExiste("ya existe")
    with pytest.raises(tp.ReporteSyscafeYaExiste):
        await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    assert storage.borrados == []  # el objeto existente es de otro, no se toca


async def test_carrera_update_sin_filas_borra_lo_subido_y_lanza_409(pool, conn, storage):
    _preparar(conn, actualizado=False)
    with pytest.raises(tp.ReporteSyscafeYaExiste):
        await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    assert storage.borrados == [f"reportes-syscafe/{TRASLADO}.pdf"]
    assert conn.eventos_log() == []


async def test_update_condicional_exige_reporte_nulo(pool, conn, storage):
    _preparar(conn)
    await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    sql = conn.sql_ejecutado("update traslados_puntos set reporte_syscafe_url")[0][1]
    assert "reporte_syscafe_url is null" in sql


async def test_fallo_de_base_borra_el_objeto_subido(pool, conn, storage):
    conn.responder("fetchrow", "select id, punto_destino_id", _fila())
    conn.responder("fetchrow", "update traslados_puntos set reporte_syscafe_url", RuntimeError("db"))
    with pytest.raises(RuntimeError):
        await tp.subir_reporte_syscafe(TRASLADO, PDF, "application/pdf", "Ana")
    assert storage.borrados == [f"reportes-syscafe/{TRASLADO}.pdf"]


# --------------------------- storage ---------------------------


def _con_transporte(monkeypatch, manejador):
    monkeypatch.setattr(st, "_cliente", lambda: httpx.AsyncClient(transport=httpx.MockTransport(manejador)))
    monkeypatch.setattr(st, "_credenciales", lambda: ("https://sb.prueba", "sb_secret_x"))


async def test_storage_sube_sin_upsert(monkeypatch):
    vistos = []

    def manejador(req: httpx.Request):
        vistos.append(req)
        return httpx.Response(200, json={"Key": "evidencia/a.pdf"})

    _con_transporte(monkeypatch, manejador)
    await st.subir("reportes-syscafe/a.pdf", b"x", "application/pdf")
    req = vistos[0]
    assert req.method == "POST"
    assert str(req.url) == "https://sb.prueba/storage/v1/object/evidencia/reportes-syscafe/a.pdf"
    assert req.headers["x-upsert"] == "false"
    assert req.headers["authorization"] == "Bearer sb_secret_x"
    assert req.headers["content-type"] == "application/pdf"


@pytest.mark.parametrize(
    "codigo, cuerpo", [(409, {"error": "Duplicate"}), (400, {"statusCode": "409", "error": "Duplicate"})]
)
async def test_storage_duplicado_lanza_objeto_ya_existe(monkeypatch, codigo, cuerpo):
    _con_transporte(monkeypatch, lambda req: httpx.Response(codigo, json=cuerpo))
    with pytest.raises(st.ObjetoYaExiste):
        await st.subir("a.pdf", b"x", "application/pdf")


async def test_storage_otro_error_lanza_no_disponible(monkeypatch):
    _con_transporte(monkeypatch, lambda req: httpx.Response(500, text="boom"))
    with pytest.raises(st.StorageNoDisponible):
        await st.subir("a.pdf", b"x", "application/pdf")


async def test_storage_sin_credenciales_lanza_no_disponible(monkeypatch):
    monkeypatch.setattr(st, "_credenciales", lambda: ("", ""))
    with pytest.raises(st.StorageNoDisponible):
        await st.subir("a.pdf", b"x", "application/pdf")


def test_url_publica(monkeypatch):
    monkeypatch.setattr(st, "_credenciales", lambda: ("https://sb.prueba", "k"))
    assert (
        st.url_publica("reportes-syscafe/a.pdf")
        == "https://sb.prueba/storage/v1/object/public/evidencia/reportes-syscafe/a.pdf"
    )


# --------------------------- endpoint ---------------------------

RUTA = f"/traslados-puntos/{TRASLADO}/reporte-syscafe/dashboard"


def _servicio(monkeypatch, resultado=None, *, lanza=None, llamadas=None):
    async def _doble(*args, **kwargs):
        if llamadas is not None:
            llamadas.append((args, kwargs))
        if lanza is not None:
            raise lanza
        return resultado

    monkeypatch.setattr(rt, "subir_reporte_syscafe", _doble)


def _resultado() -> dict:
    return {
        "id": uuid.UUID(TRASLADO),
        "punto_origen_id": uuid.UUID(PUNTO_ORIGEN),
        "punto_destino_id": uuid.UUID(PUNTO_DESTINO),
        "creado_por": uuid.UUID(USUARIO_ORIGEN),
        "reporte_syscafe_url": "https://x/y.pdf",
        "items": [],
    }


def _sesion(conn, **kwargs) -> dict:
    fila = fila_usuario_dashboard(**kwargs)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


def _archivo(contenido=PDF, tipo="application/pdf", nombre="r.pdf"):
    return {"archivo": (nombre, contenido, tipo)}


async def test_endpoint_sin_credenciales_401(cliente, pool):
    assert (await cliente.post(RUTA, files=_archivo())).status_code == 401


@pytest.mark.parametrize(
    "rol, area, codigo",
    [("admin", "todo", 200), ("supervisor", "traslados", 200), ("supervisor", "bodega", 403), ("consulta", "todo", 403)],
)
async def test_endpoint_segun_rol_y_area(cliente, pool, conn, monkeypatch, rol, area, codigo):
    llamadas: list = []
    _servicio(monkeypatch, _resultado(), llamadas=llamadas)
    res = await cliente.post(RUTA, files=_archivo(), headers=_sesion(conn, rol=rol, area=area))
    assert res.status_code == codigo
    assert bool(llamadas) == (codigo == 200)


async def test_endpoint_pasa_bytes_tipo_y_nombre_de_sesion(cliente, pool, conn, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, _resultado(), llamadas=llamadas)
    res = await cliente.post(RUTA, files=_archivo(), headers=_sesion(conn, rol="supervisor", area="traslados"))
    assert res.status_code == 200 and "items" in res.json()
    assert llamadas == [((TRASLADO, PDF, "application/pdf", "Ana Prueba"), {})]


async def test_endpoint_token_legacy_firma_como_administracion(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    _servicio(monkeypatch, _resultado(), llamadas=llamadas)
    await cliente.post(RUTA, files=_archivo(), headers=admin_headers)
    assert llamadas[0][0][3] == "Administración"


async def test_endpoint_corta_en_413_sin_llamar_al_servicio(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    _servicio(monkeypatch, _resultado(), llamadas=llamadas)
    grande = PDF + b"0" * (tp.MAX_BYTES_REPORTE_SYSCAFE + 1)
    res = await cliente.post(RUTA, files=_archivo(grande), headers=admin_headers)
    assert res.status_code == 413 and llamadas == []


async def test_endpoint_sin_archivo_422(cliente, pool, admin_headers):
    assert (await cliente.post(RUTA, headers=admin_headers)).status_code == 422


@pytest.mark.parametrize(
    "error, codigo",
    [
        (tp.TrasladoNoEncontrado("x"), 404),
        (tp.ReporteSyscafeYaExiste("x"), 409),
        (tp.ArchivoReporteNoPermitido("x"), 415),
        (tp.ArchivoReporteMuyGrande("x"), 413),
        (st.StorageNoDisponible("x"), 502),
    ],
)
async def test_endpoint_mapea_errores(cliente, pool, monkeypatch, admin_headers, error, codigo):
    _servicio(monkeypatch, lanza=error)
    assert (await cliente.post(RUTA, files=_archivo(), headers=admin_headers)).status_code == codigo
