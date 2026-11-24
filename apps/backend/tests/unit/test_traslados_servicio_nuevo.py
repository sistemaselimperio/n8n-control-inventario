"""Servicio del modulo Traslados (app/services/traslados.py) con la base
simulada (FakeConn) y Storage reemplazado: subida de PDFs, duplicados,
borradores, edicion, envio, confirmar, devolver, reenviar y borrado definitivo.
Las reglas puras estan en test_traslados_reglas.py."""

import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import pytest

from app.services import storage_evidencia as st
from app.services import traslados as svc
from app.services import traslados_reglas as r
from app.services.permisos_traslados import perfil_de
from tests.fakes import violacion_unica

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "npt_1839_layout.txt"
TEXTO = FIXTURE.read_text(encoding="utf-8")
PDF = b"%PDF-1.4\n%contenido de prueba\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 30

BVT = "11111111-1111-1111-1111-111111111111"  # origen del PDF de prueba (BODEGA VENTAS)
PDT = "22222222-2222-2222-2222-222222222222"  # destino (BODEGA PUENTE DE TIERRA)
TB9 = "33333333-3333-3333-3333-333333333333"
TRASLADO = "44444444-4444-4444-4444-444444444444"
COMP_SALIDA = "55555555-5555-5555-5555-555555555555"
COMP_INGRESO = "66666666-6666-6666-6666-666666666666"

PUNTOS = [
    {"id": uuid.UUID(BVT), "nombre": "BVT — Bodega Ventas", "codigo": "BVT", "es_interna": False},
    {"id": uuid.UUID(PDT), "nombre": "PDT — Puente de Tierra", "codigo": "PDT", "es_interna": False},
    {"id": uuid.UUID(TB9), "nombre": "TB9 — Bodega Central", "codigo": "TB9", "es_interna": True},
]


def usuario(rol="supervisor", area="traslados", punto_id=None, cedula="1234567", nombre="Ana", login="ana") -> dict:
    return {"id": str(uuid.uuid4()), "usuario": login, "nombre": nombre, "rol": rol, "area": area, "punto_id": punto_id, "cedula": cedula}


ENCARGADA = perfil_de(usuario())
ADMIN = perfil_de(usuario("admin", "todo"))
PUNTO_PDT = perfil_de(usuario(punto_id=PDT, nombre="Pedro", login="pedro"))
PUNTO_BVT = perfil_de(usuario(punto_id=BVT, nombre="Beto", login="beto"))
LECTURA = perfil_de(usuario("consulta"))


@pytest.fixture
def storage(monkeypatch):
    class Registro:
        subidas: list[tuple[str, bytes, str]] = []
        borradas: list[str] = []

    Registro.subidas, Registro.borradas = [], []

    async def subir(ruta, contenido, content_type):
        Registro.subidas.append((ruta, contenido, content_type))

    async def borrar(ruta):
        Registro.borradas.append(ruta)

    monkeypatch.setattr(st, "subir", subir)
    monkeypatch.setattr(st, "borrar", borrar)
    monkeypatch.setattr(st, "url_publica", lambda ruta: f"https://storage.prueba/{ruta}")
    return Registro


@pytest.fixture
def texto_pdf(monkeypatch):
    """Reemplaza la lectura del PDF por el texto indicado (por defecto, el del NPT-1839)."""
    actual = {"texto": TEXTO}
    monkeypatch.setattr(svc, "extraer_texto_pdf", lambda contenido: actual["texto"])
    return actual


def _insertar_traslado(*args):
    """Devuelve la fila 'insertada' con los argumentos recibidos."""
    (id_, numero, nombre, ruta, estado, advertencias, fecha, concepto, elaboro, origen_t, destino_t, items,
     origen_id, destino_id, archivos, creado_por, enviado_at) = args
    return {
        "id": uuid.UUID(id_), "numero": numero, "archivo_nombre": nombre, "pdf_ruta": ruta, "estado": estado,
        "advertencias": advertencias, "fecha": fecha, "concepto": concepto, "elaboro": elaboro,
        "origen_texto": origen_t, "destino_texto": destino_t, "items": items,
        "origen_punto_id": None if origen_id is None else uuid.UUID(origen_id),
        "destino_punto_id": None if destino_id is None else uuid.UUID(destino_id),
        "archivos": archivos, "creado_por": creado_por, "creado_at": datetime.now(UTC),
        "actualizado_at": datetime.now(UTC), "enviado_at": enviado_at,
    }


def _insertar_comprobante(traslado_id, numero, tipo, punto_id):
    return {
        "id": uuid.uuid4(), "traslado_id": uuid.UUID(traslado_id), "numero": numero, "tipo": tipo,
        "punto_id": uuid.UUID(punto_id), "estado": "pendiente", "responsable_usuario_id": None,
        "responsable_nombre": None, "responsable_cedula": None, "firma_ruta": None, "observacion": None,
        "motivo_devolucion": None, "resuelto_at": None, "creado_at": datetime.now(UTC),
        "actualizado_at": datetime.now(UTC),
    }


@pytest.fixture
def base(pool, conn, storage, texto_pdf):
    """Base lista para subir PDFs: puntos activos e inserts que devuelven lo insertado."""
    conn.responder("fetch", "from puntos where activo = true", PUNTOS)
    conn.responder("fetchrow", "any($2::text[])", None)
    conn.responder("fetchrow", "insert into traslados (", _insertar_traslado)
    conn.responder("fetchrow", "insert into traslado_comprobantes (", _insertar_comprobante)
    return conn


# --------------------------- subir PDF ---------------------------


async def test_pdf_completo_crea_traslado_enviado_con_salida_e_ingreso(base, storage):
    res = await svc.procesar_pdf("NPT 1839.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "creado" and res["archivo"] == "NPT 1839.pdf"
    traslado = res["traslado"]
    assert traslado["estado"] == "enviado" and traslado["numero"] == "NPT-1839"
    assert traslado["origen_punto_id"] == BVT and traslado["destino_punto_id"] == PDT
    assert traslado["origen_punto"]["codigo"] == "BVT" and traslado["destino_punto"]["es_interna"] is False
    assert [(c["tipo"], c["punto_id"], c["estado"]) for c in traslado["comprobantes"]] == [
        ("salida", BVT, "pendiente"),
        ("ingreso", PDT, "pendiente"),
    ]
    assert all(c["numero"] == "NPT-1839" for c in traslado["comprobantes"])
    assert base.eventos_log() == ["traslado_creado", "traslado_comprobante_creado", "traslado_comprobante_creado"]
    assert storage.subidas[0][0].startswith("traslados/") and storage.subidas[0][0].endswith(".pdf")
    assert storage.subidas[0][1] == PDF and storage.subidas[0][2] == "application/pdf"
    assert traslado["pdf_url"] == f"https://storage.prueba/{storage.subidas[0][0]}"


async def test_el_traslado_guarda_los_datos_leidos_del_pdf(base):
    await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    (_, _, args) = base.sql_ejecutado("insert into traslados (")[0]
    assert args[1] == "NPT-1839" and args[4] == "enviado"
    assert args[6].isoformat() == "2026-11-02"  # fecha como date, no texto
    assert args[9] == "BODEGA VENTAS" and args[10] == "BODEGA PUENTE DE TIERRA"
    assert len(args[11]) == 27  # items del PDF
    assert args[15] == "dashboard:ana"


async def test_origen_interno_solo_genera_ingreso(base, conn):
    conn._reglas = [x for x in conn._reglas if x[1] != "from puntos where activo = true"]
    # El origen del PDF es ahora una bodega interna: ese lado no firma.
    conn.responder("fetch", "from puntos where activo = true", [{**PUNTOS[0], "es_interna": True}, PUNTOS[1]])
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "creado"
    assert [c["tipo"] for c in res["traslado"]["comprobantes"]] == ["ingreso"]
    assert len(base.sql_ejecutado("insert into traslado_comprobantes (")) == 1


async def test_destino_se_resuelve_por_el_alias_del_punto(base, conn, texto_pdf):
    conn._reglas = [x for x in conn._reglas if x[1] != "from puntos where activo = true"]
    conn.responder(
        "fetch", "from puntos where activo = true", [PUNTOS[0], {**PUNTOS[1], "alias": ["Bodega Principal"]}, PUNTOS[2]]
    )
    texto_pdf["texto"] = TEXTO.replace("BODEGA PUENTE DE TIERRA", "BODEGA PRINCIPAL")
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "creado" and res["traslado"]["destino_punto_id"] == PDT
    (_, sql, _) = conn.sql_ejecutado("from puntos where activo = true")[0]
    assert "alias" in sql  # la carga de puntos activos trae los otros nombres


async def test_alias_compartido_por_dos_puntos_deja_el_traslado_en_borrador(base, conn, texto_pdf):
    conn._reglas = [x for x in conn._reglas if x[1] != "from puntos where activo = true"]
    conn.responder(
        "fetch",
        "from puntos where activo = true",
        [PUNTOS[0], {**PUNTOS[1], "alias": ["Principal"]}, {**PUNTOS[2], "alias": ["Bodega Principal"]}],
    )
    texto_pdf["texto"] = TEXTO.replace("BODEGA PUENTE DE TIERRA", "BODEGA PRINCIPAL")
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "borrador" and res["traslado"]["destino_punto_id"] is None


async def test_destino_no_identificado_deja_borrador_sin_comprobantes(base, conn, texto_pdf):
    texto_pdf["texto"] = TEXTO.replace("BODEGA PUENTE DE TIERRA", "BODEGA DESCONOCIDA")
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "borrador"
    traslado = res["traslado"]
    assert traslado["estado"] == "borrador" and traslado["destino_punto_id"] is None
    assert traslado["origen_punto_id"] == BVT and traslado["destino_texto"] == "BODEGA DESCONOCIDA"
    assert r.MSG_SIN_DESTINO in traslado["advertencias"]
    assert traslado["comprobantes"] == []
    assert base.sql_ejecutado("insert into traslado_comprobantes (") == []
    assert base.eventos_log() == ["traslado_creado"]


async def test_pdf_sin_numero_legible_queda_borrador_con_advertencia(base, texto_pdf):
    texto_pdf["texto"] = re.sub(r"N\s?PT\s?-\s?1839", "", TEXTO)
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "borrador"
    assert res["traslado"]["numero"] is None
    assert r.MSG_SIN_NUMERO in res["traslado"]["advertencias"]
    # Aun asi se rescatan origen y destino del pie para no escribirlos a mano.
    assert res["traslado"]["origen_punto_id"] == BVT and res["traslado"]["destino_punto_id"] == PDT


async def test_las_advertencias_del_parser_se_conservan(base, texto_pdf):
    texto_pdf["texto"] = TEXTO.replace("439.00", "440.00")
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "creado"
    assert any("no coincide" in a for a in res["traslado"]["advertencias"])


async def test_pdf_ya_cargado_se_reporta_duplicado_sin_crear_nada(base, conn, storage):
    existente = {
        "id": uuid.UUID(COMP_SALIDA), "traslado_id": uuid.UUID(TRASLADO), "numero": "NPT-1839", "tipo": "salida",
        "punto_id": uuid.UUID(BVT), "estado": "confirmado", "punto_nombre": "BVT — Bodega Ventas",
    }
    conn._reglas = [x for x in conn._reglas if "any($2::text[])" not in x[1]]
    conn.responder("fetchrow", "any($2::text[])", existente)
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "duplicado" and res["traslado"] is None
    assert "NPT-1839" in res["detalle"]
    assert res["comprobante_existente"]["id"] == COMP_SALIDA and res["comprobante_existente"]["estado"] == "confirmado"
    assert base.sql_ejecutado("insert into traslados (") == []
    assert storage.subidas == []  # ni siquiera se sube el PDF
    # El intento queda en el historial del comprobante original.
    assert base.eventos_log() == ["traslado_duplicado_bloqueado"]
    assert base.inserts_log()[0][2] == COMP_SALIDA


async def test_carrera_entre_dos_cargas_cae_en_duplicado_y_limpia_storage(base, conn, storage):
    conn._reglas = [x for x in conn._reglas if x[1] != "insert into traslados ("]
    conn.responder("fetchrow", "insert into traslados (", violacion_unica("traslado_comprobantes_numero_punto_tipo_key"))
    existente = {
        "id": uuid.UUID(COMP_SALIDA), "traslado_id": uuid.UUID(TRASLADO), "numero": "NPT-1839", "tipo": "salida",
        "punto_id": uuid.UUID(BVT), "estado": "pendiente", "punto_nombre": "BVT — Bodega Ventas",
    }
    # 1a consulta (previa): nada. 2a (tras la carrera): ya existe.
    conn._reglas = [x for x in conn._reglas if "any($2::text[])" not in x[1]]
    conn.responder("fetchrow", "any($2::text[])", None, existente)
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "duplicado"
    assert storage.borradas == [storage.subidas[0][0]]
    assert "traslado_duplicado_bloqueado" in base.eventos_log() and "traslado_creado" not in base.eventos_log()


async def test_violacion_unica_de_otra_constraint_no_se_disfraza_de_duplicado(base, conn, storage):
    conn._reglas = [x for x in conn._reglas if x[1] != "insert into traslados ("]
    conn.responder("fetchrow", "insert into traslados (", violacion_unica("otra_constraint"))
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "error"
    assert storage.borradas == [storage.subidas[0][0]]


@pytest.mark.parametrize(
    "contenido, fragmento",
    [
        pytest.param(b"", "vacío", id="vacio"),
        pytest.param(b"no es pdf", "PDF válido", id="no-es-pdf"),
        pytest.param(b"%PDF-" + b"0" * (r.MAX_BYTES_PDF + 1), "5 MB", id="muy-grande"),
    ],
)
async def test_archivos_invalidos_se_reportan_como_error(base, storage, contenido, fragmento):
    res = await svc.procesar_pdf("a.pdf", contenido, ENCARGADA)
    assert res["resultado"] == "error" and fragmento in res["detalle"]
    assert storage.subidas == [] and base.sql_ejecutado("insert into traslados (") == []


async def test_pdf_ilegible_se_reporta_como_error(base, monkeypatch):
    def _falla(contenido):
        raise svc.PdfTrasladoInvalido("El PDF no tiene texto legible")

    monkeypatch.setattr(svc, "extraer_texto_pdf", _falla)
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "error" and "texto legible" in res["detalle"]


async def test_pdf_sin_tabla_de_productos_es_error_no_borrador(base, texto_pdf):
    texto_pdf["texto"] = "algo que no es un traslado"
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "error"


async def test_storage_caido_se_reporta_como_error(base, monkeypatch):
    async def _falla(*a, **k):
        raise st.StorageNoDisponible("sin storage")

    monkeypatch.setattr(st, "subir", _falla)
    res = await svc.procesar_pdf("a.pdf", PDF, ENCARGADA)
    assert res["resultado"] == "error" and base.sql_ejecutado("insert into traslados (") == []


async def test_el_nombre_del_archivo_se_limpia(base):
    await svc.procesar_pdf("C:\\fakepath\\sub/NPT 1839.pdf", PDF, ENCARGADA)
    (_, _, args) = base.sql_ejecutado("insert into traslados (")[0]
    assert args[2] == "NPT 1839.pdf"


async def test_subir_varios_archivos_devuelve_un_resultado_por_archivo(base, texto_pdf):
    res = await svc.subir_pdfs([("a.pdf", PDF), ("b.txt", b"nada"), ("c.pdf", PDF)], ENCARGADA)
    assert [x["resultado"] for x in res] == ["creado", "error", "creado"]
    assert [x["archivo"] for x in res] == ["a.pdf", "b.txt", "c.pdf"]


async def test_un_error_inesperado_en_un_archivo_no_tumba_a_los_demas(base, monkeypatch):
    llamadas = []
    original = svc.procesar_pdf

    async def _inestable(nombre, contenido, perfil):
        llamadas.append(nombre)
        if nombre == "malo.pdf":
            raise RuntimeError("boom")
        return await original(nombre, contenido, perfil)

    monkeypatch.setattr(svc, "procesar_pdf", _inestable)
    res = await svc.subir_pdfs([("malo.pdf", PDF), ("bueno.pdf", PDF)], ENCARGADA)
    assert [x["resultado"] for x in res] == ["error", "creado"] and llamadas == ["malo.pdf", "bueno.pdf"]


async def test_solo_admin_y_encargada_pueden_subir(base):
    for perfil in (PUNTO_PDT, LECTURA):
        with pytest.raises(r.SinPermiso):
            await svc.subir_pdfs([("a.pdf", PDF)], perfil)
    assert (await svc.subir_pdfs([("a.pdf", PDF)], ADMIN))[0]["resultado"] == "creado"


# --------------------------- editar y enviar borrador ---------------------------


def _borrador(**extra) -> dict:
    fila = {
        "id": uuid.UUID(TRASLADO), "numero": None, "archivo_nombre": "a.pdf", "pdf_ruta": f"traslados/{TRASLADO}/x.pdf",
        "estado": "borrador", "advertencias": ["La suma no coincide", r.MSG_SIN_NUMERO, r.MSG_SIN_DESTINO],
        "fecha": None, "concepto": None, "elaboro": None, "origen_texto": "BODEGA VENTAS", "destino_texto": "??",
        "items": [], "origen_punto_id": uuid.UUID(BVT), "destino_punto_id": None, "archivos": [],
        "creado_por": "dashboard:ana", "creado_at": datetime.now(UTC), "actualizado_at": datetime.now(UTC), "enviado_at": None,
        "origen_nombre": "BVT — Bodega Ventas", "origen_codigo": "BVT", "origen_es_interna": False,
        "destino_nombre": None, "destino_codigo": None, "destino_es_interna": None,
    }
    fila.update(extra)
    return fila


def _guion_borrador(conn, fila=None, releido=None):
    conn.responder("fetchrow", "from traslados where id = $1::uuid for update", fila or _borrador())
    conn.responder("fetchrow", "from puntos where id = $1::uuid", lambda pid: next(
        (dict(p, activo=True) for p in PUNTOS if str(p["id"]) == pid), None))
    conn.responder("fetchrow", "update traslados set", lambda *a: {**(fila or _borrador()), "actualizado_at": datetime.now(UTC)})
    conn.responder("fetchrow", "from traslados t", releido or fila or _borrador())
    conn.responder("fetch", "from traslado_comprobantes c", [])


async def test_editar_completa_el_borrador_y_recalcula_advertencias(pool, conn, storage):
    _guion_borrador(conn)
    await svc.editar_borrador(ENCARGADA, TRASLADO, {"numero": " npt 1839 ", "destino_punto_id": PDT})
    (_, sql, args) = conn.sql_ejecutado("update traslados set")[0]
    # Se guardo el numero normalizado y el destino; la advertencia del parser sigue y las bloqueantes ya no.
    assert "NPT-1839" in args and PDT in args
    advertencias = next(a for a in args if isinstance(a, list))
    assert advertencias == ["La suma no coincide"]
    assert conn.eventos_log() == ["traslado_editado"]


async def test_editar_con_null_borra_el_valor(pool, conn, storage):
    _guion_borrador(conn, _borrador(numero="NPT-1", destino_punto_id=uuid.UUID(PDT)))
    await svc.editar_borrador(ENCARGADA, TRASLADO, {"destino_punto_id": None})
    (_, _, args) = conn.sql_ejecutado("update traslados set")[0]
    advertencias = next(a for a in args if isinstance(a, list))
    assert r.MSG_SIN_DESTINO in advertencias


async def test_editar_rechaza_punto_inexistente_o_numero_invalido(pool, conn, storage):
    _guion_borrador(conn)
    with pytest.raises(r.DatoInvalido):
        await svc.editar_borrador(ENCARGADA, TRASLADO, {"destino_punto_id": str(uuid.uuid4())})
    with pytest.raises(r.DatoInvalido):
        await svc.editar_borrador(ENCARGADA, TRASLADO, {"numero": "???"})
    assert conn.sql_ejecutado("update traslados set") == []


async def test_solo_se_edita_un_borrador(pool, conn, storage):
    _guion_borrador(conn, _borrador(estado="enviado"))
    with pytest.raises(r.EstadoNoPermitido):
        await svc.editar_borrador(ENCARGADA, TRASLADO, {"numero": "NPT-1"})


async def test_editar_y_enviar_exigen_gestion(pool, conn, storage):
    _guion_borrador(conn)
    for perfil in (PUNTO_PDT, LECTURA):
        with pytest.raises(r.SinPermiso):
            await svc.editar_borrador(perfil, TRASLADO, {"numero": "NPT-1"})
        with pytest.raises(r.SinPermiso):
            await svc.enviar(perfil, TRASLADO)


async def test_editar_traslado_inexistente_es_404(pool, conn, storage):
    conn.responder("fetchrow", "from traslados where id = $1::uuid for update", None)
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.editar_borrador(ENCARGADA, TRASLADO, {"numero": "NPT-1"})


async def test_enviar_borrador_incompleto_se_rechaza_con_las_advertencias(pool, conn, storage):
    _guion_borrador(conn)
    with pytest.raises(svc.NoSePuedeEnviar) as info:
        await svc.enviar(ENCARGADA, TRASLADO)
    assert r.MSG_SIN_NUMERO in info.value.advertencias and r.MSG_SIN_DESTINO in info.value.advertencias
    assert conn.sql_ejecutado("insert into traslado_comprobantes (") == []


async def test_enviar_borrador_completo_crea_comprobantes_y_cambia_estado(pool, conn, storage):
    completo = _borrador(numero="NPT-1839", destino_punto_id=uuid.UUID(PDT), advertencias=["La suma no coincide"])
    enviado = {**completo, "estado": "enviado", "enviado_at": datetime.now(UTC)}
    _guion_borrador(conn, completo, releido=enviado)
    conn.responder("fetchrow", "insert into traslado_comprobantes (", _insertar_comprobante)
    conn.responder("fetchrow", "any($2::text[])", None)
    conn.responder("fetchrow", "update traslados", enviado)
    res = await svc.enviar(ENCARGADA, TRASLADO)
    assert res["estado"] == "enviado"
    assert len(conn.sql_ejecutado("insert into traslado_comprobantes (")) == 2
    (_, sql, _) = conn.sql_ejecutado("update traslados set")[0]
    assert "estado = 'enviado'" in sql
    assert conn.eventos_log() == ["traslado_enviado", "traslado_comprobante_creado", "traslado_comprobante_creado"]


async def test_enviar_dos_veces_o_uno_ya_enviado_es_409(pool, conn, storage):
    _guion_borrador(conn, _borrador(estado="enviado", numero="NPT-1"))
    with pytest.raises(r.EstadoNoPermitido):
        await svc.enviar(ENCARGADA, TRASLADO)


async def test_enviar_un_numero_ya_cargado_es_duplicado_y_no_cambia_el_estado(pool, conn, storage):
    completo = _borrador(numero="NPT-1839", destino_punto_id=uuid.UUID(PDT))
    _guion_borrador(conn, completo)
    conn.responder("fetchrow", "any($2::text[])", {
        "id": uuid.UUID(COMP_SALIDA), "traslado_id": uuid.UUID(TRASLADO), "numero": "NPT-1839", "tipo": "salida",
        "punto_id": uuid.UUID(BVT), "estado": "pendiente", "punto_nombre": "BVT"})
    with pytest.raises(r.ComprobanteDuplicado):
        await svc.enviar(ENCARGADA, TRASLADO)
    assert conn.sql_ejecutado("insert into traslado_comprobantes (") == []


async def test_enviar_con_carrera_en_la_base_es_duplicado(pool, conn, storage):
    completo = _borrador(numero="NPT-1839", destino_punto_id=uuid.UUID(PDT))
    _guion_borrador(conn, completo)
    conn.responder("fetchrow", "any($2::text[])", None)
    conn.responder("fetchrow", "insert into traslado_comprobantes (", violacion_unica("traslado_comprobantes_numero_punto_tipo_key"))
    with pytest.raises(r.ComprobanteDuplicado):
        await svc.enviar(ENCARGADA, TRASLADO)
    assert "traslado_enviado" not in conn.eventos_log()


# --------------------------- confirmar ---------------------------


def _comprobante(estado="pendiente", tipo="salida", punto_id=PDT, **extra) -> dict:
    fila = {
        "id": uuid.UUID(COMP_SALIDA if tipo == "salida" else COMP_INGRESO), "traslado_id": uuid.UUID(TRASLADO),
        "numero": "NPT-1839", "tipo": tipo, "punto_id": uuid.UUID(punto_id), "estado": estado,
        "responsable_usuario_id": None, "responsable_nombre": None, "responsable_cedula": None, "firma_ruta": None,
        "observacion": None, "motivo_devolucion": None, "resuelto_at": None, "creado_at": datetime.now(UTC),
        "actualizado_at": datetime.now(UTC), "punto_nombre": "PDT — Puente de Tierra", "punto_codigo": "PDT",
    }
    fila.update(extra)
    return fila


def _guion_comprobante(conn, fila=None, actualizada=None):
    fila = fila or _comprobante()
    conn.responder("fetchrow", "where c.id = $1::uuid", fila)
    conn.responder("fetchrow", "update traslado_comprobantes set", actualizada if actualizada is not None else {**fila, "estado": "x"})
    conn.responder("fetchrow", "from traslados t", _borrador(estado="enviado", numero="NPT-1839"))
    conn.responder("fetch", "from logs", [])
    conn.responder("fetch", "from traslado_comprobantes c", [fila])


async def test_el_punto_confirma_con_firma_y_observacion(pool, conn, storage):
    _guion_comprobante(conn)
    res = await svc.confirmar(PUNTO_PDT, COMP_SALIDA, PNG, "  todo completo ")
    assert res["id"] == COMP_SALIDA
    (_, sql, args) = conn.sql_ejecutado("update traslado_comprobantes set")[0]
    assert "estado = 'confirmado'" in sql and "estado = 'pendiente'" in sql  # solo si sigue pendiente
    assert PUNTO_PDT.usuario["id"] in args and "Pedro" in args and "1234567" in args and "todo completo" in args
    ruta, contenido, tipo = storage.subidas[0]
    assert ruta.startswith(f"traslados-firmas/{COMP_SALIDA}/") and ruta.endswith(".png")
    assert contenido == PNG and tipo == "image/png" and ruta in args
    assert conn.eventos_log() == ["traslado_comprobante_confirmado"]
    assert conn.inserts_log()[0][2] == COMP_SALIDA and conn.inserts_log()[0][3] == "dashboard:pedro"
    # La ruta de la firma queda anotada en el traslado para el borrado definitivo.
    assert any("archivos = archivos ||" in c[1] for c in conn.llamadas)


async def test_confirmar_sin_firma_o_con_firma_invalida_es_422_sin_subir(pool, conn, storage):
    _guion_comprobante(conn)
    for firma in (b"", b"%PDF-1.4 no es imagen", b"GIF89a....."):
        with pytest.raises(r.DatoInvalido):
            await svc.confirmar(PUNTO_PDT, COMP_SALIDA, firma, None)
    with pytest.raises(r.DatoInvalido):
        await svc.confirmar(PUNTO_PDT, COMP_SALIDA, PNG + b"0" * r.MAX_BYTES_FIRMA, None)
    assert storage.subidas == [] and conn.sql_ejecutado("update traslado_comprobantes set") == []


async def test_el_punto_confirma_aunque_su_usuario_no_tenga_cedula(pool, conn, storage):
    # Basta con la sesion del punto y la firma: la cedula es opcional y queda null.
    _guion_comprobante(conn)
    sin_cedula = perfil_de(usuario(punto_id=PDT, cedula=None))
    await svc.confirmar(sin_cedula, COMP_SALIDA, PNG, None)
    (_, _, args) = conn.sql_ejecutado("update traslado_comprobantes set")[0]
    assert args[3] is None
    assert len(storage.subidas) == 1


async def test_el_punto_devuelve_un_pendiente_aunque_no_tenga_cedula(pool, conn, storage):
    _guion_comprobante(conn)
    sin_cedula = perfil_de(usuario(punto_id=PDT, cedula=None))
    await svc.devolver(sin_cedula, COMP_SALIDA, "No llegó")
    assert len(conn.sql_ejecutado("update traslado_comprobantes set")) == 1


async def test_confirmar_de_otro_punto_es_404_y_de_la_encargada_es_403(pool, conn, storage):
    _guion_comprobante(conn)
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.confirmar(PUNTO_BVT, COMP_SALIDA, PNG, None)
    with pytest.raises(r.SinPermiso):
        await svc.confirmar(ENCARGADA, COMP_SALIDA, PNG, None)
    with pytest.raises(r.SinPermiso):
        await svc.confirmar(LECTURA, COMP_SALIDA, PNG, None)
    assert storage.subidas == []


async def test_confirmar_uno_ya_confirmado_es_409(pool, conn, storage):
    _guion_comprobante(conn, _comprobante("confirmado"))
    with pytest.raises(r.EstadoNoPermitido):
        await svc.confirmar(PUNTO_PDT, COMP_SALIDA, PNG, None)


async def test_confirmar_si_alguien_se_adelanta_borra_la_firma_subida(pool, conn, storage):
    _guion_comprobante(conn, actualizada=None)
    conn._reglas = [x for x in conn._reglas if x[1] != "update traslado_comprobantes set"]
    conn.responder("fetchrow", "update traslado_comprobantes set", None)  # el guard estado='pendiente' no encontro fila
    with pytest.raises(r.EstadoNoPermitido):
        await svc.confirmar(PUNTO_PDT, COMP_SALIDA, PNG, None)
    assert storage.borradas == [storage.subidas[0][0]]


async def test_confirmar_comprobante_inexistente_es_404(pool, conn, storage):
    conn.responder("fetchrow", "where c.id = $1::uuid", None)
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.confirmar(PUNTO_PDT, COMP_SALIDA, PNG, None)


async def test_salida_e_ingreso_se_confirman_en_cualquier_orden(pool, conn, storage):
    """Cada comprobante es independiente: confirmar el ingreso no pide la salida."""
    _guion_comprobante(conn, _comprobante(tipo="ingreso", punto_id=PDT))
    await svc.confirmar(PUNTO_PDT, COMP_INGRESO, PNG, None)
    assert conn.eventos_log() == ["traslado_comprobante_confirmado"]
    assert not any("tipo = 'salida'" in c[1] for c in conn.llamadas)


# --------------------------- devolver ---------------------------


async def test_el_punto_devuelve_un_pendiente_con_motivo(pool, conn, storage):
    _guion_comprobante(conn)
    await svc.devolver(PUNTO_PDT, COMP_SALIDA, "  Número equivocado ")
    (_, sql, args) = conn.sql_ejecutado("update traslado_comprobantes set")[0]
    assert "estado = 'devuelto'" in sql and "Número equivocado" in args and "Pedro" in args and "1234567" in args
    assert "pendiente" in args  # el guard exige el estado que se leyo
    assert conn.eventos_log() == ["traslado_comprobante_devuelto"]
    assert storage.subidas == [] and storage.borradas == []


async def test_devolver_un_pendiente_exige_motivo(pool, conn, storage):
    _guion_comprobante(conn)
    for motivo in ("", "   ", None, "x" * 501):
        with pytest.raises(r.DatoInvalido):
            await svc.devolver(PUNTO_PDT, COMP_SALIDA, motivo)
    assert conn.sql_ejecutado("update traslado_comprobantes set") == []


async def test_la_encargada_devuelve_un_confirmado_aunque_no_tenga_cedula(pool, conn, storage):
    confirmado = _comprobante("confirmado", firma_ruta=f"traslados-firmas/{COMP_SALIDA}/f.png")
    _guion_comprobante(conn, confirmado)
    sin_cedula = perfil_de(usuario(cedula=None))
    await svc.devolver(sin_cedula, COMP_SALIDA, "Firma ilegible")
    (_, sql, args) = conn.sql_ejecutado("update traslado_comprobantes set")[0]
    assert "confirmado" in args
    assert "firma_ruta = null" in sql
    # La firma anterior queda en el log (no se borra de Storage: es evidencia).
    assert conn.inserts_log()[0][6]["firma_ruta_anterior"] == f"traslados-firmas/{COMP_SALIDA}/f.png"
    assert storage.borradas == []


async def test_el_punto_no_puede_revertir_un_confirmado(pool, conn, storage):
    _guion_comprobante(conn, _comprobante("confirmado"))
    with pytest.raises(r.SinPermiso):
        await svc.devolver(PUNTO_PDT, COMP_SALIDA, "me equivoque")


async def test_devolver_uno_ya_devuelto_es_409(pool, conn, storage):
    _guion_comprobante(conn, _comprobante("devuelto"))
    with pytest.raises(r.EstadoNoPermitido):
        await svc.devolver(ENCARGADA, COMP_SALIDA, "otra vez")


async def test_devolver_si_alguien_se_adelanta_es_409(pool, conn, storage):
    _guion_comprobante(conn)
    conn._reglas = [x for x in conn._reglas if x[1] != "update traslado_comprobantes set"]
    conn.responder("fetchrow", "update traslado_comprobantes set", None)
    with pytest.raises(r.EstadoNoPermitido):
        await svc.devolver(PUNTO_PDT, COMP_SALIDA, "motivo")
    assert conn.eventos_log() == []


# --------------------------- reenviar ---------------------------


def _guion_reenvio(conn, comprobante=None):
    comprobante = comprobante or _comprobante("devuelto", motivo_devolucion="Número equivocado")
    _guion_comprobante(conn, comprobante, {**comprobante, "estado": "pendiente"})
    conn._reglas = [x for x in conn._reglas if x[1] != "from traslados t"]
    conn.responder("fetchrow", "from traslados where id = $1::uuid", _borrador(
        estado="enviado", numero="NPT-1839", origen_punto_id=uuid.UUID(BVT), destino_punto_id=uuid.UUID(PDT)))
    conn.responder("fetchrow", "from traslados t", _borrador(estado="enviado", numero="NPT-1839"))
    conn.responder("fetchrow", "from puntos where id = $1::uuid", lambda pid: next(
        (dict(p, activo=True) for p in PUNTOS if str(p["id"]) == pid), None))


async def test_reenviar_sin_cambios_vuelve_a_pendiente_y_limpia_la_resolucion(pool, conn, storage):
    _guion_reenvio(conn)
    await svc.reenviar(ENCARGADA, COMP_SALIDA)
    (_, sql, args) = conn.sql_ejecutado("update traslado_comprobantes set")[0]
    assert "estado = 'pendiente'" in sql and "estado = 'devuelto'" in sql
    for limpio in ("responsable_nombre = null", "firma_ruta = null", "motivo_devolucion = null", "observacion = null"):
        assert limpio in sql
    assert conn.eventos_log() == ["traslado_comprobante_reenviado"]
    assert storage.subidas == []


async def test_reenviar_corrige_numero_y_punto(pool, conn, storage):
    _guion_reenvio(conn)
    await svc.reenviar(ENCARGADA, COMP_SALIDA, numero="npt 1840", punto_id=BVT)
    (_, _, args) = conn.sql_ejecutado("update traslado_comprobantes set")[0]
    assert "NPT-1840" in args and BVT in args
    # El punto del lado corregido tambien se refleja en el traslado.
    assert any("origen_punto_id" in c[1] for c in conn.sql_ejecutado("update traslados set"))
    detalle = conn.inserts_log()[0][6]
    assert detalle["numero_anterior"] == "NPT-1839" and detalle["numero"] == "NPT-1840"
    assert detalle["punto_anterior"] == PDT and detalle["punto"] == BVT


async def test_reenviar_con_pdf_nuevo_lo_sube_y_lo_anota(pool, conn, storage):
    _guion_reenvio(conn)
    await svc.reenviar(ENCARGADA, COMP_SALIDA, pdf=PDF, pdf_nombre="corregido.pdf")
    ruta, contenido, tipo = storage.subidas[0]
    assert ruta.startswith(f"traslados/{TRASLADO}/") and ruta.endswith(".pdf") and tipo == "application/pdf"
    (_, sql, args) = conn.sql_ejecutado("update traslados set")[0]
    assert "pdf_ruta = " in sql and ruta in args and "corregido.pdf" in args
    assert conn.inserts_log()[0][6]["pdf_reemplazado"] is True
    assert storage.borradas == []  # el PDF anterior se conserva hasta el borrado definitivo


async def test_reenviar_pdf_invalido_o_punto_invalido_es_422(pool, conn, storage):
    _guion_reenvio(conn)
    with pytest.raises(r.DatoInvalido):
        await svc.reenviar(ENCARGADA, COMP_SALIDA, pdf=b"no es pdf", pdf_nombre="x.pdf")
    with pytest.raises(r.DatoInvalido):
        await svc.reenviar(ENCARGADA, COMP_SALIDA, punto_id=str(uuid.uuid4()))
    with pytest.raises(r.DatoInvalido):
        await svc.reenviar(ENCARGADA, COMP_SALIDA, punto_id=TB9)  # un punto interno no firma comprobantes
    with pytest.raises(r.DatoInvalido):
        await svc.reenviar(ENCARGADA, COMP_SALIDA, numero="???")
    assert conn.sql_ejecutado("update traslado_comprobantes set") == [] and storage.subidas == []


async def test_reenviar_no_puede_dejar_origen_y_destino_en_el_mismo_punto(pool, conn, storage):
    # La salida (la que se corrige) es de BVT y el destino del traslado es PDT.
    _guion_reenvio(conn, _comprobante("devuelto", punto_id=BVT))
    with pytest.raises(r.DatoInvalido):
        await svc.reenviar(ENCARGADA, COMP_SALIDA, punto_id=PDT)


async def test_reenviar_a_un_numero_ya_cargado_es_duplicado_y_limpia_el_pdf(pool, conn, storage):
    _guion_reenvio(conn)
    conn._reglas = [x for x in conn._reglas if x[1] != "update traslado_comprobantes set"]
    conn.responder("fetchrow", "update traslado_comprobantes set", violacion_unica("traslado_comprobantes_numero_punto_tipo_key"))
    with pytest.raises(r.ComprobanteDuplicado):
        await svc.reenviar(ENCARGADA, COMP_SALIDA, numero="NPT-1", pdf=PDF, pdf_nombre="x.pdf")
    assert storage.borradas == [storage.subidas[0][0]]
    assert conn.eventos_log() == []


async def test_solo_la_encargada_reenvia_y_solo_un_devuelto(pool, conn, storage):
    _guion_reenvio(conn)
    for perfil in (PUNTO_PDT, LECTURA):
        with pytest.raises(r.SinPermiso):
            await svc.reenviar(perfil, COMP_SALIDA)
    conn._reglas.clear()
    _guion_reenvio(conn, _comprobante("pendiente"))
    with pytest.raises(r.EstadoNoPermitido):
        await svc.reenviar(ENCARGADA, COMP_SALIDA)


# --------------------------- borrado definitivo ---------------------------


async def test_borrado_definitivo_quita_filas_y_todos_los_archivos(pool, conn, storage):
    conn.responder("fetchrow", "from traslados where id = $1::uuid", _borrador(
        estado="enviado", numero="NPT-1839", pdf_ruta="traslados/t/a.pdf",
        archivos=["traslados/t/a.pdf", "traslados/t/b.pdf", "traslados-firmas/c/f1.png"]))
    conn.responder("fetch", "from traslado_comprobantes where traslado_id", [
        {"id": uuid.UUID(COMP_SALIDA), "firma_ruta": "traslados-firmas/c/f2.png", "punto_id": uuid.UUID(BVT)},
        {"id": uuid.UUID(COMP_INGRESO), "firma_ruta": None, "punto_id": uuid.UUID(PDT)},
    ])
    res = await svc.eliminar(ENCARGADA, TRASLADO)
    assert res == {"ok": True, "archivos_borrados": 4}
    assert sorted(storage.borradas) == sorted(
        ["traslados/t/a.pdf", "traslados/t/b.pdf", "traslados-firmas/c/f1.png", "traslados-firmas/c/f2.png"]
    )
    assert conn.sql_ejecutado("delete from traslados where id = $1::uuid")  # los comprobantes caen en cascada
    assert conn.eventos_log() == ["traslado_eliminado"]
    assert conn.inserts_log()[0][6]["numero"] == "NPT-1839"
    assert conn.sql_ejecutado("delete from logs") == [] and conn.sql_ejecutado("update logs") == []


async def test_borrar_exige_gestion_y_que_exista(pool, conn, storage):
    for perfil in (PUNTO_PDT, LECTURA):
        with pytest.raises(r.SinPermiso):
            await svc.eliminar(perfil, TRASLADO)
    conn.responder("fetchrow", "from traslados where id = $1::uuid", None)
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.eliminar(ADMIN, TRASLADO)
    assert storage.borradas == []


# --------------------------- lecturas ---------------------------


async def test_detalle_de_traslado_incluye_historial_por_comprobante(pool, conn, storage):
    conn.responder("fetchrow", "from traslados t", _borrador(estado="enviado", numero="NPT-1839", destino_punto_id=uuid.UUID(PDT)))
    conn.responder("fetch", "from traslado_comprobantes c", [_comprobante(), _comprobante(tipo="ingreso", punto_id=BVT)])
    ahora = datetime.now(UTC)
    conn.responder("fetch", "from logs", [
        {"evento": "traslado_creado", "entidad_tipo": "traslado", "entidad_id": TRASLADO, "actor_id": "dashboard:ana",
         "resultado": "enviado", "detalle": {}, "timestamp": ahora},
        {"evento": "traslado_comprobante_creado", "entidad_tipo": "traslado_comprobante", "entidad_id": COMP_SALIDA,
         "actor_id": "dashboard:ana", "resultado": "ok", "detalle": {}, "timestamp": ahora},
    ])
    res = await svc.detalle_traslado(ENCARGADA, TRASLADO)
    assert [e["evento"] for e in res["historial"]] == ["traslado_creado"]
    salida = res["comprobantes"][0]
    assert [e["evento"] for e in salida["historial"]] == ["traslado_comprobante_creado"]
    assert res["comprobantes"][1]["historial"] == []
    assert salida["historial"][0]["actor"] == "dashboard:ana"


async def test_un_punto_solo_ve_sus_comprobantes_y_no_el_historial_del_traslado(pool, conn, storage):
    conn.responder("fetchrow", "from traslados t", _borrador(estado="enviado", numero="NPT-1839"))
    conn.responder("fetch", "from traslado_comprobantes c", [_comprobante(punto_id=PDT)])
    conn.responder("fetch", "from logs", [])
    res = await svc.detalle_traslado(PUNTO_PDT, TRASLADO)
    assert [c["punto_id"] for c in res["comprobantes"]] == [PDT]
    assert "historial" not in res
    (_, sql, args) = conn.sql_ejecutado("from traslado_comprobantes c")[0]
    assert "c.punto_id = " in sql and PDT in args  # el filtro viaja a la consulta


async def test_un_punto_sin_comprobantes_en_el_traslado_recibe_404(pool, conn, storage):
    conn.responder("fetchrow", "from traslados t", _borrador(estado="enviado", numero="NPT-1839"))
    conn.responder("fetch", "from traslado_comprobantes c", [])
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.detalle_traslado(PUNTO_PDT, TRASLADO)


async def test_detalle_de_comprobante_de_otro_punto_es_404(pool, conn, storage):
    _guion_comprobante(conn, _comprobante(punto_id=PDT))
    with pytest.raises(r.TrasladoNoEncontrado):
        await svc.detalle_comprobante(PUNTO_BVT, COMP_SALIDA)
    res = await svc.detalle_comprobante(PUNTO_PDT, COMP_SALIDA)
    assert res["id"] == COMP_SALIDA and res["punto_codigo"] == "PDT"
    assert res["traslado"]["pdf_url"].startswith("https://storage.prueba/")


async def test_listar_comprobantes_aplica_filtros_y_alcance(pool, conn, storage):
    conn.responder("fetchval", "count(*) from traslado_comprobantes c", 1)
    conn.responder("fetch", "from traslado_comprobantes c", [dict(_comprobante(), archivo_nombre="a.pdf", traslado_pdf_ruta="x.pdf")])
    res = await svc.listar_comprobantes(
        PUNTO_PDT, punto_id=None, estado="pendiente", tipo="salida", q="1839", limit=20, offset=40
    )
    assert res["total"] == 1 and res["items"][0]["archivo_nombre"] == "a.pdf"
    (_, sql, args) = conn.sql_ejecutado("from traslado_comprobantes c")[0]
    assert "c.punto_id = " in sql and "c.estado = " in sql and "c.tipo = " in sql and "ilike" in sql
    assert PDT in args and "pendiente" in args and "salida" in args and "%1839%" in args
    assert args[-2:] == (20, 40)


async def test_la_busqueda_escapa_los_comodines_de_like(pool, conn, storage):
    conn.responder("fetchval", "count(*) from traslado_comprobantes c", 0)
    conn.responder("fetch", "from traslado_comprobantes c", [])
    await svc.listar_comprobantes(ENCARGADA, punto_id=None, estado=None, tipo=None, q="50%_", limit=10, offset=0)
    (_, _, args) = conn.sql_ejecutado("from traslado_comprobantes c")[0]
    assert "%50\\%\\_%" in args


async def test_listar_traslados_incrusta_comprobantes_y_respeta_el_alcance(pool, conn, storage):
    conn.responder("fetchval", "count(*) from traslados t", 1)
    conn.responder("fetch", "from traslados t", [_borrador(estado="enviado", numero="NPT-1839")])
    conn.responder("fetch", "from traslado_comprobantes c", [_comprobante(), _comprobante(tipo="ingreso", punto_id=BVT)])
    res = await svc.listar_traslados(ENCARGADA, estado="enviado", punto_id=None, q=None, limit=50, offset=0)
    assert res["total"] == 1 and len(res["items"][0]["comprobantes"]) == 2
    assert "items" not in res["items"][0]  # el listado no arrastra los renglones del PDF


async def test_puntos_para_traslados_solo_activos_y_acotados_al_alcance(pool, conn, storage):
    conn.responder("fetch", "from puntos where activo = true", PUNTOS)
    todos = await svc.puntos_para_traslados(ENCARGADA)
    assert [p["codigo"] for p in todos] == ["BVT", "PDT", "TB9"] and todos[2]["es_interna"] is True
    solo = await svc.puntos_para_traslados(PUNTO_PDT)
    assert [p["codigo"] for p in solo] == ["PDT"]


async def test_puntos_para_traslados_no_expone_los_alias(pool, conn, storage):
    conn.responder("fetch", "from puntos where activo = true", [{**PUNTOS[0], "alias": ["Principal"]}])
    (punto,) = await svc.puntos_para_traslados(ENCARGADA)
    assert set(punto) == {"id", "nombre", "codigo", "es_interna"}


async def test_asyncpg_no_se_traga_errores_ajenos(pool, conn, storage):
    """Cualquier otra excepcion de la base sube tal cual (no se disfraza de 409)."""
    _guion_comprobante(conn)
    conn._reglas = [x for x in conn._reglas if x[1] != "update traslado_comprobantes set"]
    conn.responder("fetchrow", "update traslado_comprobantes set", asyncpg.DataError("boom"))
    with pytest.raises(asyncpg.DataError):
        await svc.devolver(PUNTO_PDT, COMP_SALIDA, "motivo")
