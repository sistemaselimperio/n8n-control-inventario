"""Modulo Traslados (comprobantes de salida e ingreso) contra Postgres real:
semilla de es_interna, barrera anti-duplicado, carga concurrente del mismo PDF,
flujo confirmar / devolver / reenviar por HTTP con sesiones reales, historial
desde logs y borrado definitivo. Storage simulado; el PDF se simula con el
texto de tests/fixtures/npt_1839_layout.txt (el parser real si corre)."""

import asyncio
from pathlib import Path

import asyncpg
import pytest

from app import db
from app.services import storage_evidencia as st
from app.services import traslados as svc
from app.services.permisos_traslados import perfil_de
from app.services.sesion_dashboard import crear_token, obtener_secreto
from tests.helpers import fila_usuario_dashboard
from tests.integration.datos_traslados import crear_punto, crear_usuario_dashboard

pytestmark = pytest.mark.integration

TEXTO = (Path(__file__).resolve().parent.parent / "fixtures" / "npt_1839_layout.txt").read_text(encoding="utf-8")
PDF = b"%PDF-1.4\n%contenido de prueba\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 30


@pytest.fixture(autouse=True)
def _storage(monkeypatch):
    registro = {"subidas": [], "borradas": []}

    async def subir(ruta, contenido, content_type):
        registro["subidas"].append(ruta)

    async def borrar(ruta):
        registro["borradas"].append(ruta)

    monkeypatch.setattr(st, "subir", subir)
    monkeypatch.setattr(st, "borrar", borrar)
    monkeypatch.setattr(st, "url_publica", lambda ruta: f"https://storage.prueba/{ruta}")
    monkeypatch.setattr(svc, "extraer_texto_pdf", lambda contenido: TEXTO)
    return registro


async def _usuario(pool, usuario, *, rol="supervisor", area="traslados", punto_id=None, cedula=None) -> tuple[str, dict, dict]:
    """Usuario del dashboard real: (id, encabezado, dict de sesion)."""
    fila = fila_usuario_dashboard(usuario=usuario, rol=rol, area=area)
    id_ = str(
        await pool.fetchval(
            "insert into usuarios_dashboard (usuario, nombre, rol, area, punto_id, cedula, pass_hash, pass_salt)"
            " values ($1, $2, $3, $4, $5::uuid, $6, $7, $8) returning id",
            usuario, f"Nombre {usuario}", rol, area, punto_id, cedula, fila["pass_hash"], fila["pass_salt"],
        )
    )
    token, _ = crear_token(id_, obtener_secreto())
    sesion = {"id": id_, "usuario": usuario, "nombre": f"Nombre {usuario}", "rol": rol, "area": area,
              "punto_id": punto_id, "cedula": cedula}
    return id_, {"Authorization": f"Bearer {token}"}, sesion


async def _puntos(pool) -> tuple[str, str, str]:
    """(origen del PDF, destino del PDF, bodega interna)."""
    origen = await crear_punto(pool, "BVT — Bodega Ventas", "BVT")
    destino = await crear_punto(pool, "PDT — Puente de Tierra", "PDT")
    interna = await crear_punto(pool, "TB9 — Bodega Central", "TB9")
    return origen, destino, interna


# --------------------------- esquema ---------------------------


async def test_es_interna_se_siembra_una_sola_vez(pg):
    await pg.execute("alter table puntos drop column es_interna")  # simula la base anterior a esta funcion
    for codigo in ("TB8", "TB9", "TBE", "TB", "CFC"):
        await crear_punto(pg, f"{codigo} — Algo", codigo)
    await db.ensure_schema()
    internas = {f["codigo"] for f in await pg.fetch("select codigo from puntos where es_interna")}
    assert internas == {"TB8", "TB9", "TBE", "TB"}
    # Una edicion posterior desde /creador sobrevive a los siguientes arranques.
    await pg.execute("update puntos set es_interna = false where codigo = 'TB9'")
    await pg.execute("update puntos set es_interna = true where codigo = 'CFC'")
    await db.ensure_schema()
    await db.ensure_schema()
    internas = {f["codigo"] for f in await pg.fetch("select codigo from puntos where es_interna")}
    assert internas == {"TB8", "TBE", "TB", "CFC"}


async def test_semilla_de_alias_crea_bv_gua_y_marca_vet_una_sola_vez(pg):
    await pg.execute("alter table puntos drop column alias")  # simula la base anterior a esta funcion
    await crear_punto(pg, "VET — Veterinaria", "VET")
    await db.ensure_schema()
    filas = {f["codigo"]: f for f in await pg.fetch("select codigo, nombre, es_interna, alias from puntos")}
    assert set(filas) == {"VET", "BV", "GUA"}
    assert filas["VET"]["es_interna"] is True
    assert filas["BV"]["nombre"] == "BV — Bodega Ventas" and filas["BV"]["es_interna"] is True
    assert "Principal" in filas["BV"]["alias"] and "Bodega Agroquímicos Estación" in filas["BV"]["alias"]
    assert filas["GUA"]["nombre"] == "GUA — Guasca" and filas["GUA"]["es_interna"] is False and filas["GUA"]["alias"] == []
    # Lo que se edite despues desde /creador sobrevive a los siguientes arranques.
    await pg.execute("update puntos set alias = '{Solo uno}', es_interna = false where codigo = 'BV'")
    await pg.execute("update puntos set es_interna = false where codigo = 'VET'")
    await pg.execute("delete from puntos where codigo = 'GUA'")
    await db.ensure_schema()
    await db.ensure_schema()
    filas = {f["codigo"]: f for f in await pg.fetch("select codigo, es_interna, alias from puntos")}
    assert set(filas) == {"VET", "BV"}
    assert filas["BV"]["alias"] == ["Solo uno"] and filas["BV"]["es_interna"] is False
    assert filas["VET"]["es_interna"] is False


async def test_semilla_de_alias_no_pisa_un_punto_que_ya_existe(pg):
    await pg.execute("alter table puntos drop column alias")
    await crear_punto(pg, "BV — Bodega de Ventas Antigua", "BV")
    await crear_punto(pg, "GUA — Guasca", "GUA")  # mismo nombre que la semilla
    await db.ensure_schema()
    filas = {f["codigo"]: f for f in await pg.fetch("select codigo, nombre, es_interna, alias from puntos")}
    assert set(filas) == {"BV", "GUA"}
    assert filas["BV"]["nombre"] == "BV — Bodega de Ventas Antigua"
    assert filas["BV"]["es_interna"] is False and filas["BV"]["alias"] == []


async def test_la_base_rechaza_un_comprobante_repetido(pg):
    origen, _, _ = await _puntos(pg)
    for n in (1, 2):
        await pg.execute("insert into traslados (id, numero, creado_por) values (gen_random_uuid(), 'NPT-1', 'x')")
    traslados = [f["id"] for f in await pg.fetch("select id from traslados")]
    insert = "insert into traslado_comprobantes (traslado_id, numero, tipo, punto_id) values ($1, 'NPT-1', 'salida', $2::uuid)"
    await pg.execute(insert, traslados[0], origen)
    with pytest.raises(asyncpg.UniqueViolationError) as info:
        await pg.execute(insert, traslados[1], origen)
    assert info.value.constraint_name == "traslado_comprobantes_numero_punto_tipo_key"
    # Mismo numero y tipo en OTRO punto si se permite.
    await pg.execute(insert, traslados[1], await crear_punto(pg, "OTRO — X", "OTRO"))


async def test_estados_invalidos_los_rechaza_la_base(pg):
    origen, _, _ = await _puntos(pg)
    await pg.execute("insert into traslados (id, numero, creado_por) values (gen_random_uuid(), 'NPT-1', 'x')")
    traslado = await pg.fetchval("select id from traslados")
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute("update traslados set estado = 'otro'")
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute(
            "insert into traslado_comprobantes (traslado_id, numero, tipo, punto_id, estado) values ($1, 'N-1', 'salida', $2::uuid, 'raro')",
            traslado, origen,
        )


# --------------------------- carga de PDFs ---------------------------


async def test_pdf_completo_y_repetido(pg, _storage):
    origen, destino, _ = await _puntos(pg)
    _, _, sesion = await _usuario(pg, "enc")
    perfil = perfil_de(sesion)
    res = await svc.procesar_pdf("NPT 1839.pdf", PDF, perfil)
    assert res["resultado"] == "creado"
    assert {(c["tipo"], c["punto_id"]) for c in res["traslado"]["comprobantes"]} == {("salida", origen), ("ingreso", destino)}

    repetido = await svc.procesar_pdf("copia.pdf", PDF, perfil)
    assert repetido["resultado"] == "duplicado" and repetido["comprobante_existente"]["numero"] == "NPT-1839"
    assert await pg.fetchval("select count(*) from traslados") == 1
    assert await pg.fetchval("select count(*) from traslado_comprobantes") == 2
    assert len(_storage["subidas"]) == 1  # el repetido ni siquiera subio su PDF
    eventos = [f["evento"] for f in await pg.fetch('select evento from logs order by "timestamp", id')]
    assert eventos.count("traslado_duplicado_bloqueado") == 1


async def test_origen_interno_no_genera_salida(pg):
    _, destino, interna = await _puntos(pg)
    await pg.execute("update puntos set es_interna = true where codigo = 'BVT'")
    _, _, sesion = await _usuario(pg, "enc")
    res = await svc.procesar_pdf("a.pdf", PDF, perfil_de(sesion))
    assert [(c["tipo"], c["punto_id"]) for c in res["traslado"]["comprobantes"]] == [("ingreso", destino)]


async def test_destino_desconocido_queda_en_borrador_y_se_completa_y_envia(pg):
    origen, destino, _ = await _puntos(pg)
    await pg.execute("update puntos set nombre = 'PDT — Otro nombre', codigo = 'XXX' where codigo = 'PDT'")
    _, _, sesion = await _usuario(pg, "enc")
    perfil = perfil_de(sesion)
    res = await svc.procesar_pdf("a.pdf", PDF, perfil)
    assert res["resultado"] == "borrador" and res["traslado"]["destino_punto_id"] is None
    traslado_id = res["traslado"]["id"]
    assert await pg.fetchval("select count(*) from traslado_comprobantes") == 0

    with pytest.raises(svc.NoSePuedeEnviar):
        await svc.enviar(perfil, traslado_id)
    editado = await svc.editar_borrador(perfil, traslado_id, {"destino_punto_id": destino})
    assert not any("destino" in a for a in editado["advertencias"])
    enviado = await svc.enviar(perfil, traslado_id)
    assert enviado["estado"] == "enviado" and len(enviado["comprobantes"]) == 2


async def test_la_misma_carga_en_paralelo_crea_solo_un_traslado(pg):
    await _puntos(pg)
    _, _, sesion = await _usuario(pg, "enc")
    perfil = perfil_de(sesion)
    resultados = await asyncio.gather(*(svc.procesar_pdf(f"{i}.pdf", PDF, perfil) for i in range(4)))
    assert sorted(r["resultado"] for r in resultados) == ["creado", "duplicado", "duplicado", "duplicado"]
    assert await pg.fetchval("select count(*) from traslados") == 1
    assert await pg.fetchval("select count(*) from traslado_comprobantes") == 2


# --------------------------- flujo por HTTP ---------------------------


async def _traslado_creado(pg) -> tuple[dict, dict, dict, dict]:
    origen, destino, _ = await _puntos(pg)
    _, h_enc, enc = await _usuario(pg, "enc")
    _, h_dest, _ = await _usuario(pg, "pdt", punto_id=destino, cedula="1234567")
    _, h_orig, _ = await _usuario(pg, "bvt", punto_id=origen, cedula="7654321")
    res = await svc.procesar_pdf("a.pdf", PDF, perfil_de(enc))
    comprobantes = {c["tipo"]: c["id"] for c in res["traslado"]["comprobantes"]}
    return {"traslado": res["traslado"]["id"], **comprobantes}, h_enc, h_dest, h_orig


async def test_flujo_confirmar_devolver_y_reenviar(pg, cliente):
    ids, h_enc, h_dest, h_orig = await _traslado_creado(pg)

    # Cada punto ve solo lo suyo.
    lista = (await cliente.get("/traslados/comprobantes", headers=h_dest)).json()
    assert lista["total"] == 1 and lista["items"][0]["tipo"] == "ingreso"
    assert (await cliente.get(f"/traslados/comprobantes/{ids['salida']}", headers=h_dest)).status_code == 404
    todos = (await cliente.get("/traslados/comprobantes", headers=h_enc)).json()
    assert todos["total"] == 2

    # El ingreso se confirma sin esperar a la salida.
    ruta = f"/traslados/comprobantes/{ids['ingreso']}"
    sin_firma = await cliente.post(f"{ruta}/confirmar", headers=h_dest)
    assert sin_firma.status_code == 422
    ok = await cliente.post(
        f"{ruta}/confirmar", headers=h_dest, files={"firma": ("f.png", PNG, "image/png")}, data={"observacion": "Completo"}
    )
    assert ok.status_code == 200, ok.text
    cuerpo = ok.json()
    assert cuerpo["estado"] == "confirmado" and cuerpo["responsable_nombre"] == "Nombre pdt"
    assert cuerpo["responsable_cedula"] == "1234567" and cuerpo["observacion"] == "Completo"
    assert cuerpo["firma_url"].startswith("https://storage.prueba/traslados-firmas/")

    # Ya resuelto: ni confirmar de nuevo ni revertir desde el punto.
    assert (await cliente.post(f"{ruta}/confirmar", headers=h_dest, files={"firma": ("f.png", PNG, "image/png")})).status_code == 409
    assert (await cliente.post(f"{ruta}/devolver", headers=h_dest, json={"motivo": "me equivoque"})).status_code == 403
    # El punto de la salida no puede tocar el ingreso.
    assert (await cliente.post(f"{ruta}/devolver", headers=h_orig, json={"motivo": "x"})).status_code == 404

    # La encargada devuelve el confirmado, lo corrige y lo reenvia.
    assert (await cliente.post(f"{ruta}/devolver", headers=h_enc, json={})).status_code == 422
    dev = await cliente.post(f"{ruta}/devolver", headers=h_enc, json={"motivo": "Firma ilegible"})
    assert dev.status_code == 200 and dev.json()["estado"] == "devuelto" and dev.json()["firma_url"] is None
    assert dev.json()["motivo_devolucion"] == "Firma ilegible"
    re = await cliente.post(f"{ruta}/reenviar", headers=h_enc, data={"numero": "NPT-1840"})
    assert re.status_code == 200 and re.json()["estado"] == "pendiente" and re.json()["numero"] == "NPT-1840"
    assert re.json()["responsable_nombre"] is None and re.json()["motivo_devolucion"] is None
    assert (await cliente.post(f"{ruta}/reenviar", headers=h_enc)).status_code == 409  # ya no esta devuelto

    # El punto lo devuelve el mismo (pendiente -> devuelto) y la salida sigue pendiente.
    assert (await cliente.post(f"{ruta}/devolver", headers=h_dest, json={"motivo": "Cantidad distinta"})).status_code == 200
    salida = (await cliente.get(f"/traslados/comprobantes/{ids['salida']}", headers=h_orig)).json()
    assert salida["estado"] == "pendiente"

    # Historial completo y en orden.
    historial = (await cliente.get(f"{ruta}", headers=h_enc)).json()["historial"]
    assert [e["evento"] for e in historial] == [
        "traslado_comprobante_creado",
        "traslado_comprobante_confirmado",
        "traslado_comprobante_devuelto",
        "traslado_comprobante_reenviado",
        "traslado_comprobante_devuelto",
    ]
    assert historial[1]["actor"] == "dashboard:pdt" and historial[2]["actor"] == "dashboard:enc"
    # Un usuario de punto tampoco ve el detalle del traslado completo (solo sus comprobantes).
    detalle = (await cliente.get(f"/traslados/{ids['traslado']}", headers=h_dest)).json()
    assert [c["tipo"] for c in detalle["comprobantes"]] == ["ingreso"] and "historial" not in detalle


async def test_un_usuario_de_punto_sin_cedula_puede_firmar(pg, cliente):
    ids, _, _, _ = await _traslado_creado(pg)
    destino = await pg.fetchval("select id from puntos where codigo = 'PDT'")
    _, h_sin, _ = await _usuario(pg, "sincedula", punto_id=str(destino))
    res = await cliente.post(
        f"/traslados/comprobantes/{ids['ingreso']}/confirmar", headers=h_sin, files={"firma": ("f.png", PNG, "image/png")}
    )
    assert res.status_code == 200
    fila = await pg.fetchrow("select estado, responsable_cedula from traslado_comprobantes where tipo = 'ingreso'")
    assert fila["estado"] == "confirmado" and fila["responsable_cedula"] is None


async def test_reenviar_a_un_numero_que_ya_existe_es_409(pg, cliente):
    ids, h_enc, h_dest, _ = await _traslado_creado(pg)
    await cliente.post(f"/traslados/comprobantes/{ids['ingreso']}/devolver", headers=h_dest, json={"motivo": "x"})
    # Otro traslado con otro numero para el mismo punto de destino.
    destino = await pg.fetchval("select id from puntos where codigo = 'PDT'")
    otro = await pg.fetchval("insert into traslados (numero, creado_por) values ('NPT-9', 'x') returning id")
    await pg.execute(
        "insert into traslado_comprobantes (traslado_id, numero, tipo, punto_id) values ($1, 'NPT-9', 'ingreso', $2)", otro, destino
    )
    res = await cliente.post(f"/traslados/comprobantes/{ids['ingreso']}/reenviar", headers=h_enc, data={"numero": "NPT-9"})
    assert res.status_code == 409
    assert await pg.fetchval("select estado from traslado_comprobantes where id = $1::uuid", ids["ingreso"]) == "devuelto"


# --------------------------- borrado definitivo ---------------------------


async def test_borrado_definitivo_quita_filas_y_archivos_pero_no_los_logs(pg, cliente, _storage):
    ids, h_enc, h_dest, _ = await _traslado_creado(pg)
    await cliente.post(
        f"/traslados/comprobantes/{ids['ingreso']}/confirmar", headers=h_dest, files={"firma": ("f.png", PNG, "image/png")}
    )
    antes = await pg.fetchval("select count(*) from logs")
    assert (await cliente.delete(f"/traslados/{ids['traslado']}", headers=h_dest)).status_code == 403
    res = await cliente.delete(f"/traslados/{ids['traslado']}", headers=h_enc)
    assert res.status_code == 200 and res.json()["archivos_borrados"] == 2  # el PDF y la firma
    assert await pg.fetchval("select count(*) from traslados") == 0
    assert await pg.fetchval("select count(*) from traslado_comprobantes") == 0
    assert len(_storage["borradas"]) == 2
    assert await pg.fetchval("select count(*) from logs") == antes + 1  # solo se agrego el evento de borrado
    assert await pg.fetchval("select count(*) from logs where evento = 'traslado_eliminado'") == 1
    assert (await cliente.delete(f"/traslados/{ids['traslado']}", headers=h_enc)).status_code == 404


async def test_no_se_puede_borrar_un_punto_con_comprobantes(pg):
    from app.services import borrado_admin

    await _traslado_creado(pg)
    destino = await pg.fetchval("select id from puntos where codigo = 'PDT'")
    with pytest.raises(borrado_admin.TieneHistorial):
        await borrado_admin.eliminar_punto(str(destino))


# --------------------------- usuarios del dashboard ---------------------------


async def test_alta_de_usuario_con_punto_y_cedula_y_login(pg, cliente):
    origen, _, _ = await _puntos(pg)
    admin_id, h_admin, _ = await _usuario(pg, "root", rol="admin", area="todo")
    creado = await cliente.post(
        "/dashboard/usuarios",
        headers=h_admin,
        json={"usuario": "luisa", "nombre": "Luisa", "rol": "supervisor", "area": "traslados", "punto_id": origen,
              "cedula": "1.234.567", "password": "clave-segura-1"},
    )
    assert creado.status_code == 201 and creado.json()["punto_id"] == origen and creado.json()["cedula"] == "1234567"
    login = await cliente.post("/dashboard/auth/login", json={"usuario": "luisa", "password": "clave-segura-1"})
    assert login.json()["usuario"]["punto_id"] == origen and login.json()["usuario"]["cedula"] == "1234567"
    yo = await cliente.get("/dashboard/auth/yo", headers={"Authorization": f"Bearer {login.json()['token']}"})
    assert yo.json()["punto_id"] == origen

    uid = creado.json()["id"]
    quitado = await cliente.patch(f"/dashboard/usuarios/{uid}", headers=h_admin, json={"punto_id": None, "cedula": "7654321"})
    assert quitado.json()["punto_id"] is None and quitado.json()["cedula"] == "7654321"
    invalido = await cliente.patch(f"/dashboard/usuarios/{uid}", headers=h_admin, json={"area": "bodega", "punto_id": origen})
    assert invalido.status_code == 422
    inexistente = await cliente.post(
        "/dashboard/usuarios", headers=h_admin,
        json={"usuario": "pedro", "nombre": "Pedro", "rol": "supervisor", "area": "traslados",
              "punto_id": "99999999-9999-9999-9999-999999999999", "password": "clave-segura-1"},
    )
    assert inexistente.status_code == 422


async def test_alias_de_punto_ida_y_vuelta_y_resolucion_del_pdf(pg, cliente):
    await _puntos(pg)
    _, h_admin, _ = await _usuario(pg, "root", rol="admin", area="todo")
    pdt = str(await pg.fetchval("select id from puntos where codigo = 'PDT'"))
    bvt = str(await pg.fetchval("select id from puntos where codigo = 'BVT'"))
    res = await cliente.patch(f"/puntos/{pdt}", headers=h_admin, json={"alias": [" Bodega Principal ", "principal", ""]})
    assert res.status_code == 200 and res.json()["alias"] == ["Bodega Principal"]
    lista = (await cliente.get("/puntos", params={"incluir_inactivos": "true"}, headers=h_admin)).json()
    assert {p["codigo"]: p["alias"] for p in lista}["PDT"] == ["Bodega Principal"]
    # Otro punto activo no puede usar el mismo nombre alterno.
    repetido = await cliente.patch(f"/puntos/{bvt}", headers=h_admin, json={"alias": ["BODEGA PRINCIPAL"]})
    assert repetido.status_code == 409
    # El punto puede volver a guardar su propio alias, y limpiarlo.
    assert (await cliente.patch(f"/puntos/{pdt}", headers=h_admin, json={"alias": ["Bodega Principal"]})).status_code == 200
    limpio = await cliente.patch(f"/puntos/{pdt}", headers=h_admin, json={"alias": []})
    assert limpio.status_code == 200 and limpio.json()["alias"] == []
    # El selector de traslados conserva su forma (sin alias).
    assert set((await cliente.get("/traslados/puntos", headers=h_admin)).json()[0]) <= {"id", "nombre", "codigo", "es_interna"}


async def test_editar_es_interna_desde_el_admin(pg, cliente):
    await _puntos(pg)
    _, h_admin, _ = await _usuario(pg, "root", rol="admin", area="todo")
    punto = await pg.fetchval("select id from puntos where codigo = 'PDT'")
    res = await cliente.patch(f"/puntos/{punto}", headers=h_admin, json={"es_interna": True})
    assert res.status_code == 200 and res.json()["es_interna"] is True
    lista = (await cliente.get("/puntos", params={"incluir_inactivos": "true"}, headers=h_admin)).json()
    assert {p["codigo"]: p["es_interna"] for p in lista}["PDT"] is True
    # El listado publico del movil no cambia de forma.
    assert set((await cliente.get("/puntos")).json()[0]) == {"id", "nombre", "codigo"}
