"""Receptores por punto contra Postgres real: esquema idempotente y unico por
(punto, cedula), administracion por HTTP, confirmar con receptor de la lista u
"otra persona", historial que sobrevive al borrado del receptor y el script de
carga masiva. Storage simulado (ver test_traslados_comprobantes_integracion.py)."""

import asyncpg
import pytest

from app import db
from app.services import storage_evidencia as st
from app.services import traslados as svc
from app.services.permisos_traslados import perfil_de
from scripts import crear_receptores
from tests.integration.datos_traslados import crear_punto
from tests.integration.test_traslados_comprobantes_integracion import (
    PDF,
    PNG,
    TEXTO,
    _puntos,
    _receptor,
    _traslado_creado,
    _usuario,
)

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _storage(monkeypatch):
    async def subir(ruta, contenido, content_type):
        return None

    async def borrar(ruta):
        return None

    monkeypatch.setattr(st, "subir", subir)
    monkeypatch.setattr(st, "borrar", borrar)
    monkeypatch.setattr(st, "url_publica", lambda ruta: f"https://storage.prueba/{ruta}")
    monkeypatch.setattr(svc, "extraer_texto_pdf", lambda contenido: TEXTO)


# --------------------------- esquema ---------------------------


async def test_el_esquema_es_idempotente_y_la_cedula_es_unica_por_punto(pg):
    await db.ensure_schema()
    await db.ensure_schema()
    origen, destino, _ = await _puntos(pg)
    await _receptor(pg, origen, cedula="1234567")
    with pytest.raises(asyncpg.UniqueViolationError) as info:
        await _receptor(pg, origen, nombre="Otro", cedula="1234567")
    assert info.value.constraint_name == "receptores_punto_punto_id_cedula_key"
    # La misma persona puede estar en varios puntos.
    await _receptor(pg, destino, cedula="1234567")
    assert await pg.fetchval("select count(*) from receptores_punto") == 2


async def test_receptores_punto_no_esta_en_la_publicacion_realtime(pg):
    publicadas = await pg.fetch("select tablename from pg_publication_tables where pubname = 'supabase_realtime'")
    assert "receptores_punto" not in {f["tablename"] for f in publicadas}


# --------------------------- administracion por HTTP ---------------------------


async def test_crud_de_receptores_con_sesion_admin(pg, cliente):
    origen, destino, _ = await _puntos(pg)
    _, h_admin, _ = await _usuario(pg, "root", rol="admin", area="todo")
    _, h_enc, _ = await _usuario(pg, "enc")
    assert (await cliente.get("/receptores-punto", headers=h_enc)).status_code == 403

    creado = await cliente.post(
        "/receptores-punto", headers=h_admin, json={"punto_id": origen, "nombre": "Luis  Pérez", "cedula": "1.234.567"}
    )
    assert creado.status_code == 201, creado.text
    rid = creado.json()["id"]
    assert creado.json()["nombre"] == "Luis Pérez" and creado.json()["cedula"] == "1234567" and creado.json()["activo"] is True
    duplicado = await cliente.post(
        "/receptores-punto", headers=h_admin, json={"punto_id": origen, "nombre": "Otro", "cedula": "1234567"}
    )
    assert duplicado.status_code == 409 and "cédula" in duplicado.json()["detail"]
    inexistente = await cliente.post(
        "/receptores-punto",
        headers=h_admin,
        json={"punto_id": "99999999-9999-9999-9999-999999999999", "nombre": "X", "cedula": "1234567"},
    )
    assert inexistente.status_code == 409

    # Editar: nombre, cedula y punto; chocar con otro receptor del punto destino es 409.
    otro = (
        await cliente.post("/receptores-punto", headers=h_admin, json={"punto_id": destino, "nombre": "Ana", "cedula": "7654321"})
    ).json()["id"]
    editado = await cliente.patch(f"/receptores-punto/{rid}", headers=h_admin, json={"nombre": "Luis P.", "cedula": "11 111 111"})
    assert editado.status_code == 200 and editado.json()["cedula"] == "11111111"
    assert (await cliente.patch(f"/receptores-punto/{otro}", headers=h_admin, json={"punto_id": origen, "cedula": "11111111"})).status_code == 409
    movido = await cliente.patch(f"/receptores-punto/{otro}", headers=h_admin, json={"punto_id": origen})
    assert movido.status_code == 200 and movido.json()["punto_id"] == origen

    # Listados: el admin ve inactivos; el modal del punto solo activos y solo los de su punto.
    await cliente.patch(f"/receptores-punto/{otro}", headers=h_admin, json={"activo": False})
    todos = (await cliente.get("/receptores-punto", headers=h_admin, params={"incluir_inactivos": "true"})).json()
    assert {r["nombre"]: r["activo"] for r in todos} == {"Luis P.": True, "Ana": False}
    assert all(r["punto_nombre"] == "BVT — Bodega Ventas" for r in todos)
    activos = (await cliente.get("/receptores-punto", headers=h_admin)).json()
    assert [r["nombre"] for r in activos] == ["Luis P."]
    assert (await cliente.get("/receptores-punto", headers=h_admin, params={"punto_id": destino})).json() == []

    _, h_punto, _ = await _usuario(pg, "bvt", punto_id=origen)
    _, h_otro, _ = await _usuario(pg, "pdt", punto_id=destino)
    del_punto = await cliente.get(f"/traslados/puntos/{origen}/receptores", headers=h_punto)
    assert del_punto.json() == [{"id": rid, "nombre": "Luis P.", "cedula": "11111111"}]
    assert (await cliente.get(f"/traslados/puntos/{origen}/receptores", headers=h_otro)).status_code == 404
    assert len((await cliente.get(f"/traslados/puntos/{origen}/receptores", headers=h_enc)).json()) == 1

    # Borrado definitivo y rastro en logs sin cedula.
    assert (await cliente.delete(f"/receptores-punto/{rid}", headers=h_admin)).json() == {"ok": True}
    assert (await cliente.delete(f"/receptores-punto/{rid}", headers=h_admin)).status_code == 404
    eventos = await pg.fetch("select resultado, detalle::text as detalle from logs where entidad_tipo = 'receptor_punto'")
    assert {e["resultado"] for e in eventos} >= {"creado", "actualizado", "eliminado"}
    assert not any("1234567" in e["detalle"] or "11111111" in e["detalle"] for e in eventos)


async def test_un_punto_con_receptores_no_se_borra(pg):
    from app.services import borrado_admin

    origen, _, _ = await _puntos(pg)
    await _receptor(pg, origen)
    with pytest.raises(borrado_admin.TieneHistorial):
        await borrado_admin.eliminar_punto(origen)


# --------------------------- confirmar / devolver ---------------------------


async def test_confirmar_con_receptor_de_la_lista_y_borrarlo_conserva_el_historial(pg, cliente):
    ids, h_enc, h_dest, _ = await _traslado_creado(pg)
    destino = str(await pg.fetchval("select id from puntos where codigo = 'PDT'"))
    receptor = await _receptor(pg, destino)
    res = await cliente.post(
        f"/traslados/comprobantes/{ids['ingreso']}/confirmar", headers=h_dest,
        files={"firma": ("f.png", PNG, "image/png")}, data={"receptor_id": receptor},
    )
    assert res.status_code == 200, res.text
    log = await pg.fetchrow("select detalle from logs where evento = 'traslado_comprobante_confirmado'")
    assert log["detalle"]["receptor_id"] == receptor and log["detalle"]["receptor_fuera_de_lista"] is False

    await pg.execute("delete from receptores_punto where id = $1::uuid", receptor)
    fila = await pg.fetchrow("select receptor_id, responsable_nombre, responsable_cedula from traslado_comprobantes where tipo = 'ingreso'")
    assert fila["receptor_id"] is None and fila["responsable_nombre"] == "Luis Pérez" and fila["responsable_cedula"] == "7654321"
    detalle = (await cliente.get(f"/traslados/comprobantes/{ids['ingreso']}", headers=h_enc)).json()
    assert detalle["responsable_nombre"] == "Luis Pérez" and detalle["receptor_id"] is None


async def test_confirmar_con_otra_persona_no_la_agrega_a_la_lista(pg, cliente):
    ids, _, h_dest, _ = await _traslado_creado(pg)
    res = await cliente.post(
        f"/traslados/comprobantes/{ids['ingreso']}/confirmar", headers=h_dest,
        files={"firma": ("f.png", PNG, "image/png")},
        data={"receptor_nombre": "Marta  Ríos", "receptor_cedula": "52.123.456"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["responsable_nombre"] == "Marta Ríos" and res.json()["responsable_cedula"] == "52123456"
    assert res.json()["receptor_id"] is None
    assert await pg.fetchval("select count(*) from receptores_punto") == 0
    log = await pg.fetchrow("select detalle from logs where evento = 'traslado_comprobante_confirmado'")
    assert log["detalle"]["receptor_fuera_de_lista"] is True and log["detalle"]["receptor_id"] is None


async def test_un_receptor_inactivo_o_de_otro_punto_no_sirve(pg, cliente):
    ids, _, h_dest, _ = await _traslado_creado(pg)
    origen = str(await pg.fetchval("select id from puntos where codigo = 'BVT'"))
    destino = str(await pg.fetchval("select id from puntos where codigo = 'PDT'"))
    inactivo = await _receptor(pg, destino, cedula="1111111", activo=False)
    ajeno = await _receptor(pg, origen, cedula="2222222")
    ruta = f"/traslados/comprobantes/{ids['ingreso']}"
    for receptor in (inactivo, ajeno):
        res = await cliente.post(
            f"{ruta}/confirmar", headers=h_dest, files={"firma": ("f.png", PNG, "image/png")}, data={"receptor_id": receptor}
        )
        assert res.status_code == 422, res.text
        dev = await cliente.post(f"{ruta}/devolver", headers=h_dest, json={"motivo": "x", "receptor_id": receptor})
        assert dev.status_code == 422
    assert await pg.fetchval("select estado from traslado_comprobantes where tipo = 'ingreso'") == "pendiente"


async def test_la_encargada_devuelve_un_confirmado_sin_receptor(pg, cliente):
    ids, h_enc, h_dest, _ = await _traslado_creado(pg)
    ruta = f"/traslados/comprobantes/{ids['ingreso']}"
    await cliente.post(
        f"{ruta}/confirmar", headers=h_dest, files={"firma": ("f.png", PNG, "image/png")},
        data={"receptor_nombre": "Marta Ríos", "receptor_cedula": "52123456"},
    )
    res = await cliente.post(f"{ruta}/devolver", headers=h_enc, json={"motivo": "Firma ilegible"})
    assert res.status_code == 200, res.text
    assert res.json()["estado"] == "devuelto" and res.json()["receptor_id"] is None
    assert res.json()["responsable_nombre"] == "Nombre enc"


# --------------------------- script de carga masiva ---------------------------


async def test_el_script_hace_upsert_idempotente_contra_la_base_real(pg, tmp_path, monkeypatch):
    await crear_punto(pg, "NVL — Villa de Leyva", "NVL")
    await crear_punto(pg, "TB — Chiquinquirá", "TB")
    ruta = tmp_path / "r.csv"
    ruta.write_text(
        "nombre,cedula,punto\nLuis P,1.234.567,Villa de Leyva\nAna Gil,7654321,Chiquinquira\n", encoding="utf-8"
    )
    monkeypatch.setattr("sys.argv", ["crear_receptores", str(ruta), "--si"])
    await crear_receptores.main()
    await pg.execute("update receptores_punto set activo = false")
    ruta.write_text("nombre,cedula,punto\nLuis Pérez,1234567,NVL\n", encoding="utf-8")
    await crear_receptores.main()

    filas = {f["cedula"]: f for f in await pg.fetch("select nombre, cedula, activo from receptores_punto")}
    assert set(filas) == {"1234567", "7654321"}
    assert filas["1234567"]["nombre"] == "Luis Pérez" and filas["1234567"]["activo"] is True  # reactivado
    assert filas["7654321"]["activo"] is False  # el script nunca desactiva ni borra a los demas
