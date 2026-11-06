"""Servicio del traslado "desde bodega" (app/services/traslados_bodega.py):
borrador desde el PDF, alta, edicion y anulacion. Base y Storage simulados."""

import uuid
from pathlib import Path

import pytest

from app.models.log import EventoLog
from app.models.traslado_punto import TrasladoDesdeBodegaDatos
from app.services import storage_evidencia as st
from app.services import traslados_bodega as tb
from app.services import traslados_puntos as tp
from tests.fakes import violacion_unica
from tests.helpers_traslados import PUNTO_DESTINO

PDF_REAL = (Path(__file__).resolve().parent.parent / "fixtures" / "npt_1839.pdf").read_bytes()
PDF_MIN = b"%PDF-1.4\n%contenido de prueba\n"
TRASLADO = str(uuid.uuid4())
USUARIO = str(uuid.uuid4())


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
    monkeypatch.setattr(st, "subir", falso.subir)
    monkeypatch.setattr(st, "borrar", falso.borrar)
    monkeypatch.setattr(st, "url_publica", falso.url_publica)
    return falso


def datos(**extra) -> TrasladoDesdeBodegaDatos:
    cuerpo = {
        "numero": "npt - 1839",
        "fecha": "2026-11-02",
        "concepto": "SUGERIDO PUENTE 29 OCTUBRE",
        "origen": "BODEGA VENTAS",
        "punto_destino_id": PUNTO_DESTINO,
        "elaboro": "YOHANA",
        "items": [
            {"referencia": "02058", "detalle": "c. contelac 18 p.", "empaque": "bulto", "cantidad": 15, "precio": 75700},
            {"referencia": "1476", "detalle": "25-4-24 NUTRIMON", "empaque": "BULTO", "cantidad": 5, "precio": 140000},
        ],
    }
    cuerpo.update(extra)
    return TrasladoDesdeBodegaDatos(**cuerpo)


def _fila_traslado(**extra) -> dict:
    fila = {
        "id": uuid.UUID(TRASLADO),
        "tipo": "desde_bodega",
        "estado": "en_transito",
        "punto_destino_id": uuid.UUID(PUNTO_DESTINO),
        "numero_documento": "NPT-1839",
    }
    fila.update(extra)
    return fila


def _preparar_alta(conn, *, destino=True, existente=False, fallo_insert=None):
    conn.responder("fetchrow", "from puntos where id", {"id": uuid.UUID(PUNTO_DESTINO)} if destino else None)
    conn.responder("fetchrow", "where numero_syscafe", {"id": uuid.uuid4()} if existente else None)
    conn.responder(
        "fetchrow",
        "insert into traslados_puntos",
        fallo_insert or (lambda *a: _fila_traslado(id=uuid.UUID(a[0]), pdf_url=a[-1])),
    )
    conn.responder("fetchrow", "insert into traslado_punto_items", lambda *a: {"id": uuid.uuid4(), "cantidad": a[1]})
    conn.responder("execute", "insert into productos", "INSERT 0 1")


# --------------------------- borrador ---------------------------


async def test_borrador_lee_el_pdf_y_sugiere_el_punto(pool, conn):
    conn.responder(
        "fetch",
        "from puntos where activo",
        [{"id": uuid.UUID(PUNTO_DESTINO), "nombre": "PT — Puente de Tierra", "codigo": "PT"}],
    )
    conn.responder("fetchrow", "where numero_syscafe", None)
    res = await tb.generar_borrador(PDF_REAL)
    assert res["numero"] == "NPT-1839" and len(res["items"]) == 27
    assert res["punto_destino_id"] == PUNTO_DESTINO
    assert res["ya_cargado"] is False and res["advertencias"] == []
    # El borrador no escribe nada.
    assert conn.sql_ejecutado("insert") == []


async def test_borrador_sin_punto_coincidente_deja_sugerencia_vacia(pool, conn):
    conn.responder("fetch", "from puntos where activo", [{"id": uuid.uuid4(), "nombre": "Otro lugar", "codigo": None}])
    conn.responder("fetchrow", "where numero_syscafe", None)
    res = await tb.generar_borrador(PDF_REAL)
    assert res["punto_destino_id"] is None


async def test_borrador_avisa_si_el_traslado_ya_fue_cargado(pool, conn):
    conn.responder("fetch", "from puntos where activo", [])
    conn.responder("fetchrow", "where numero_syscafe", {"id": uuid.uuid4()})
    res = await tb.generar_borrador(PDF_REAL)
    assert res["ya_cargado"] is True
    assert any("NPT-1839" in a and "ya" in a.lower() for a in res["advertencias"])


async def test_borrador_rechaza_pdf_ilegible(pool, conn):
    with pytest.raises(tb.PdfTrasladoInvalido):
        await tb.generar_borrador(b"no soy pdf")


async def test_borrador_rechaza_archivo_muy_grande(pool, conn):
    with pytest.raises(tp.ArchivoReporteMuyGrande):
        await tb.generar_borrador(PDF_MIN + b"0" * (tb.MAX_BYTES_PDF + 1))


# --------------------------- alta ---------------------------


async def test_crear_guarda_traslado_en_transito_con_items_y_pdf(pool, conn, storage):
    _preparar_alta(conn)
    res = await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="dashboard:ana")
    ruta, contenido, tipo = storage.subidos[0]
    assert ruta.startswith("traslados-bodega/") and ruta.endswith(".pdf")
    assert contenido == PDF_MIN and tipo == "application/pdf"
    sql, args = conn.sql_ejecutado("insert into traslados_puntos")[0][1:]
    assert "'desde_bodega'" in sql and "'en_transito'" in sql
    assert "NPT-1839" in args  # numero normalizado, en numero_syscafe y numero_documento
    assert args[-1] == f"https://storage.prueba/{ruta}"
    assert USUARIO in args
    assert len(res["items"]) == 2


async def test_crear_conserva_ceros_y_mayusculas_en_los_items(pool, conn, storage):
    _preparar_alta(conn)
    await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="dashboard:ana")
    args = conn.sql_ejecutado("insert into traslado_punto_items")[0][2]
    assert "02058" in args and "C. CONTELAC 18 P." in args and "BULTO" in args


async def test_crear_sincroniza_el_catalogo_de_productos(pool, conn, storage):
    _preparar_alta(conn)
    await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="dashboard:ana")
    inserts = conn.sql_ejecutado("insert into productos")
    assert [c[2] for c in inserts] == [("02058", "C. CONTELAC 18 P."), ("1476", "25-4-24 NUTRIMON")]
    assert "on conflict (codigo) do nothing" in inserts[0][1]


async def test_crear_registra_evento(pool, conn, storage):
    _preparar_alta(conn)
    await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="dashboard:ana")
    assert conn.eventos_log() == [EventoLog.TRASLADO_BODEGA_CREADO.value]
    assert conn.inserts_log()[0][3] == USUARIO


async def test_crear_con_token_legacy_usa_el_actor_de_texto(pool, conn, storage):
    _preparar_alta(conn)
    await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=None, actor="dashboard:token")
    assert conn.inserts_log()[0][3] == "dashboard:token"


async def test_crear_numero_ya_existente_lanza_409_sin_subir(pool, conn, storage):
    _preparar_alta(conn, existente=True)
    with pytest.raises(tp.SyscafeDuplicado) as exc:
        await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="x")
    assert "NPT-1839" in str(exc.value)
    assert storage.subidos == []


async def test_crear_carrera_en_el_indice_unico_borra_el_pdf_subido(pool, conn, storage):
    _preparar_alta(conn, fallo_insert=violacion_unica("traslados_puntos_numero_syscafe_key"))
    with pytest.raises(tp.SyscafeDuplicado):
        await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="x")
    assert storage.borrados == [storage.subidos[0][0]]
    assert conn.eventos_log() == []


async def test_crear_fallo_de_base_borra_el_pdf_subido(pool, conn, storage):
    _preparar_alta(conn, fallo_insert=RuntimeError("db"))
    with pytest.raises(RuntimeError):
        await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="x")
    assert storage.borrados == [storage.subidos[0][0]]


async def test_crear_destino_inexistente_lanza_422_sin_subir(pool, conn, storage):
    _preparar_alta(conn, destino=False)
    with pytest.raises(tp.TrasladoInvalido):
        await tb.crear_desde_bodega(PDF_MIN, datos(), usuario_id=USUARIO, actor="x")
    assert storage.subidos == []


async def test_crear_numero_con_formato_invalido_lanza_422(pool, conn, storage):
    _preparar_alta(conn)
    with pytest.raises(tp.TrasladoInvalido):
        await tb.crear_desde_bodega(PDF_MIN, datos(numero="1839"), usuario_id=USUARIO, actor="x")


@pytest.mark.parametrize("contenido", [b"no soy pdf", b""])
async def test_crear_archivo_que_no_es_pdf_lanza_415(pool, conn, storage, contenido):
    _preparar_alta(conn)
    with pytest.raises(tp.ArchivoReporteNoPermitido):
        await tb.crear_desde_bodega(contenido, datos(), usuario_id=USUARIO, actor="x")
    assert storage.subidos == []


async def test_crear_archivo_muy_grande_lanza_413(pool, conn, storage):
    with pytest.raises(tp.ArchivoReporteMuyGrande):
        await tb.crear_desde_bodega(
            PDF_MIN + b"0" * (tb.MAX_BYTES_PDF + 1), datos(), usuario_id=USUARIO, actor="x"
        )


# --------------------------- edicion ---------------------------


def _preparar_edicion(conn, *, fila=None, actualizado=True, fallo_update=None):
    conn.responder("fetchrow", "select id, tipo, estado", fila if fila is not None else _fila_traslado())
    conn.responder("fetchrow", "from puntos where id", {"id": uuid.UUID(PUNTO_DESTINO)})
    conn.responder(
        "fetchrow", "update traslados_puntos", fallo_update or (_fila_traslado() if actualizado else None)
    )
    conn.responder("fetchrow", "insert into traslado_punto_items", lambda *a: {"id": uuid.uuid4(), "cantidad": a[1]})
    conn.responder("execute", "delete from traslado_punto_items", "DELETE 2")
    conn.responder("execute", "insert into productos", "INSERT 0 1")


async def test_editar_reemplaza_cabecera_e_items_y_registra_evento(pool, conn):
    _preparar_edicion(conn)
    res = await tb.editar_desde_bodega(TRASLADO, datos(), usuario_id=USUARIO, actor="dashboard:ana")
    sql = conn.sql_ejecutado("update traslados_puntos")[0][1]
    assert "estado = 'en_transito'" in sql and "tipo = 'desde_bodega'" in sql
    assert conn.sql_ejecutado("delete from traslado_punto_items")
    assert len(res["items"]) == 2
    assert conn.eventos_log() == [EventoLog.TRASLADO_BODEGA_EDITADO.value]


async def test_editar_inexistente_lanza_404(pool, conn):
    conn.responder("fetchrow", "select id, tipo, estado", None)
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tb.editar_desde_bodega(TRASLADO, datos(), usuario_id=USUARIO, actor="x")


async def test_editar_traslado_de_otro_tipo_lanza_422(pool, conn):
    _preparar_edicion(conn, fila=_fila_traslado(tipo="entre_puntos"))
    with pytest.raises(tp.TrasladoInvalido):
        await tb.editar_desde_bodega(TRASLADO, datos(), usuario_id=USUARIO, actor="x")


@pytest.mark.parametrize("estado", ["recibido", "recibido_con_novedad", "anulado"])
async def test_editar_traslado_ya_recibido_o_anulado_lanza_409(pool, conn, estado):
    _preparar_edicion(conn, fila=_fila_traslado(estado=estado))
    with pytest.raises(tp.TrasladoYaRecibido):
        await tb.editar_desde_bodega(TRASLADO, datos(), usuario_id=USUARIO, actor="x")
    assert conn.sql_ejecutado("delete from traslado_punto_items") == []


async def test_editar_carrera_con_recepcion_lanza_409_sin_tocar_items(pool, conn):
    _preparar_edicion(conn, actualizado=False)
    with pytest.raises(tp.TrasladoYaRecibido):
        await tb.editar_desde_bodega(TRASLADO, datos(), usuario_id=USUARIO, actor="x")
    assert conn.sql_ejecutado("delete from traslado_punto_items") == []


async def test_editar_a_un_numero_ya_usado_lanza_409(pool, conn):
    _preparar_edicion(conn, fallo_update=violacion_unica("traslados_puntos_numero_syscafe_key"))
    with pytest.raises(tp.SyscafeDuplicado):
        await tb.editar_desde_bodega(TRASLADO, datos(), usuario_id=USUARIO, actor="x")


# --------------------------- anulacion ---------------------------


async def test_anular_marca_anulado_libera_el_numero_y_registra_evento(pool, conn):
    conn.responder("fetchrow", "select id, tipo, estado", _fila_traslado())
    conn.responder("fetchrow", "update traslados_puntos", _fila_traslado(estado="anulado"))
    conn.responder("fetch", "from traslado_punto_items", [])
    res = await tb.anular_desde_bodega(TRASLADO, "Cantidades equivocadas", usuario_id=USUARIO, actor="dashboard:ana", nombre="Ana")
    sql, args = conn.sql_ejecutado("update traslados_puntos")[0][1:]
    assert "estado = 'anulado'" in sql and "numero_syscafe = null" in sql
    assert "estado = 'en_transito'" in sql and "tipo = 'desde_bodega'" in sql
    assert "Cantidades equivocadas" in args and "Ana" in args
    assert res["estado"] == "anulado"
    assert conn.eventos_log() == [EventoLog.TRASLADO_BODEGA_ANULADO.value]
    assert conn.inserts_log()[0][6]["motivo"] == "Cantidades equivocadas"


async def test_anular_sin_motivo_lanza_422(pool, conn):
    with pytest.raises(tp.TrasladoInvalido):
        await tb.anular_desde_bodega(TRASLADO, "   ", usuario_id=USUARIO, actor="x", nombre="Ana")


@pytest.mark.parametrize("estado", ["recibido", "recibido_con_novedad", "anulado"])
async def test_anular_traslado_ya_recibido_lanza_409(pool, conn, estado):
    conn.responder("fetchrow", "select id, tipo, estado", _fila_traslado(estado=estado))
    with pytest.raises(tp.TrasladoYaRecibido):
        await tb.anular_desde_bodega(TRASLADO, "motivo", usuario_id=USUARIO, actor="x", nombre="Ana")


async def test_anular_inexistente_lanza_404(pool, conn):
    conn.responder("fetchrow", "select id, tipo, estado", None)
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tb.anular_desde_bodega(TRASLADO, "motivo", usuario_id=USUARIO, actor="x", nombre="Ana")


# --------------------------- recepcion ---------------------------


async def test_recibir_un_traslado_anulado_lanza_409_con_mensaje_claro(pool, conn):
    from app.models.traslado_punto import RecepcionTraslado

    conn.responder("fetchrow", "select * from traslados_puntos", {"estado": "anulado", "punto_destino_id": uuid.UUID(PUNTO_DESTINO)})
    conn.responder("fetch", "from traslado_punto_items", [])
    payload = RecepcionTraslado(
        items=[{"id": str(uuid.uuid4()), "cantidad_recibida": 1}],
        firma_recibe_url="https://x/f.webp",
        recibido_por=str(uuid.uuid4()),
    )
    with pytest.raises(tp.TrasladoYaRecibido) as exc:
        await tp.registrar_recepcion(TRASLADO, payload)
    assert "anulado" in str(exc.value).lower()
