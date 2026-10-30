"""Scripts de mantenimiento (scripts/*.py): logica de decision y de SQL, con la
base y la red simuladas. Ninguna prueba abre una conexion ni borra nada real."""

from __future__ import annotations

import builtins
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest

from app.services.auth_pin import hashear_pin
from app.services.turnos import MODELO, Celda
from scripts import cargar_puntos, crear_admin_dashboard, generar_turnos, limpiar_datos
from tests.fakes import FakeConn


class ConexionFalsa(FakeConn):
    """FakeConn con el cierre que usan los scripts que abren su propia conexion."""

    def __init__(self) -> None:
        super().__init__()
        self.cerrada = False

    async def close(self) -> None:
        self.cerrada = True


@pytest.fixture
def conexion(monkeypatch) -> ConexionFalsa:
    """Reemplaza asyncpg.connect en los scripts: ninguna prueba abre una conexion real."""
    falsa = ConexionFalsa()
    urls: list[str] = []

    async def _conectar(url, *args, **kwargs):
        urls.append(url)
        return falsa

    for modulo in (limpiar_datos, cargar_puntos):
        monkeypatch.setattr(modulo.asyncpg, "connect", _conectar)
    falsa.urls = urls  # type: ignore[attr-defined]
    return falsa


# --------------------------------------------------------------------------
# generar_turnos
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fecha, esperado",
    [
        (datetime(2026, 1, 1), "2026-W01"),
        (datetime(2026, 3, 9), "2026-W11"),
        (datetime(2024, 12, 30), "2025-W01"),  # la semana ISO 1 de 2025 empieza en diciembre de 2024
        (datetime(2021, 1, 3), "2020-W53"),  # y el 3 de enero de 2021 aun es de 2020
        (datetime(2026, 12, 31), "2026-W53"),
    ],
)
def test_semana_iso(fecha, esperado):
    assert generar_turnos._semana_iso(fecha) == esperado


@pytest.fixture
def job(monkeypatch, pool, conn):
    """Parchea lo que importa generar_turnos (no se llama "app.*", asi que el
    fixture `pool` no lo alcanza)."""
    estado = SimpleNamespace(cerrado=0, celdas={})

    async def _get_pool():
        return pool

    async def _close_pool():
        estado.cerrado += 1

    async def _cargar_celdas(_pool, sede_id):
        return estado.celdas.get(sede_id, []), 8

    monkeypatch.setattr(generar_turnos, "get_pool", _get_pool)
    monkeypatch.setattr(generar_turnos, "close_pool", _close_pool)
    monkeypatch.setattr(generar_turnos, "cargar_celdas", _cargar_celdas)
    return estado


async def test_el_job_guarda_una_foto_por_sede_activa_con_el_modelo_y_la_semana(job, conn, capsys):
    conn.responder("fetch", "from sedes", [{"id": "id-1", "nombre": "Centro"}, {"id": "id-2", "nombre": "Polo"}])
    job.celdas = {
        "id-1": [Celda(0, 8, 2.0), Celda(0, 9, 20.0), Celda(0, 10, 20.0)],
        "id-2": [Celda(3, 15, 5.0)],
    }
    await generar_turnos.generar_recomendaciones()

    assert "where activa = true" in conn.sql_ejecutado("from sedes")[0][1]  # sedes desactivadas no
    inserts = conn.sql_ejecutado("insert into shift_recommendations")
    assert [i[2][0] for i in inserts] == ["id-1", "id-2"]
    sede_id, semana, bloques, generado, modelo = inserts[0][2]
    assert semana == generar_turnos._semana_iso(generado) and generado.tzinfo is not None
    assert modelo == MODELO
    assert [(b["dia"], b["hora_inicio"], b["hora_fin"]) for b in bloques] == [("lunes", "09:00:00", "11:00:00")]
    assert "[turnos] Centro: 1 bloques sugeridos" in capsys.readouterr().out
    assert job.cerrado == 1  # cierra el pool al terminar


async def test_el_job_escribe_con_upsert_por_sede_y_semana(job, conn):
    conn.responder("fetch", "from sedes", [{"id": "id-1", "nombre": "Centro"}])
    job.celdas = {"id-1": [Celda(0, 9, 5.0)]}
    await generar_turnos.generar_recomendaciones()
    sql = conn.sql_ejecutado("insert into shift_recommendations")[0][1]
    assert "on conflict (sede_id, semana_iso) do update" in sql
    for columna in ("bloques_sugeridos", "generado_at", "modelo_usado"):
        assert f"{columna} = excluded.{columna}" in sql


async def test_una_sede_sin_historia_se_salta_y_no_borra_su_foto_anterior(job, conn):
    conn.responder("fetch", "from sedes", [{"id": "id-1", "nombre": "Centro"}])
    await generar_turnos.generar_recomendaciones()
    assert conn.sql_ejecutado("shift_recommendations") == []
    assert job.cerrado == 1


async def test_sin_sedes_activas_no_hace_nada_y_cierra(job, conn):
    conn.responder("fetch", "from sedes", [])
    await generar_turnos.generar_recomendaciones()
    assert conn.sql_ejecutado("insert") == [] and job.cerrado == 1


async def test_el_job_solo_escribe_en_shift_recommendations(job, conn):
    conn.responder("fetch", "from sedes", [{"id": "id-1", "nombre": "Centro"}])
    job.celdas = {"id-1": [Celda(0, 9, 5.0)]}
    await generar_turnos.generar_recomendaciones()
    escrituras = [c for c in conn.llamadas if c[0] == "execute"]
    assert len(escrituras) == 1 and "shift_recommendations" in escrituras[0][1]
    assert conn.inserts_log() == []


# --------------------------------------------------------------------------
# limpiar_datos: confirmacion
# --------------------------------------------------------------------------


@pytest.fixture
def limpieza(monkeypatch):
    """Registra que haria `main` sin ejecutar nada de verdad."""
    llamadas = SimpleNamespace(tablas=[], storage=[], preguntas=0, respuesta="si")
    settings = SimpleNamespace(
        database_url="postgresql://prueba:prueba@127.0.0.1:1/prueba",
        supabase_url="https://x.supabase.co",
        supabase_secret_key="llave-falsa",
    )

    async def _tablas(url):
        llamadas.tablas.append(url)

    async def _storage(url, llave):
        llamadas.storage.append((url, llave))

    def _input(prompt=""):
        llamadas.preguntas += 1
        llamadas.prompt = prompt
        return llamadas.respuesta

    monkeypatch.setattr(limpiar_datos, "get_settings", lambda: settings)
    monkeypatch.setattr(limpiar_datos, "vaciar_tablas", _tablas)
    monkeypatch.setattr(limpiar_datos, "vaciar_storage", _storage)
    monkeypatch.setattr(builtins, "input", _input)
    llamadas.settings = settings
    return llamadas


@pytest.mark.parametrize("respuesta", ["", "no", "n", "s", "sí", "yes", "si, claro", "  ", "NO"])
async def test_sin_la_bandera_si_cualquier_respuesta_distinta_de_si_cancela_sin_borrar(limpieza, monkeypatch, capsys, respuesta):
    monkeypatch.setattr("sys.argv", ["limpiar_datos"])
    limpieza.respuesta = respuesta
    await limpiar_datos.main()
    assert limpieza.preguntas == 1
    assert limpieza.tablas == [] and limpieza.storage == []
    assert "Cancelado." in capsys.readouterr().out


@pytest.mark.parametrize("respuesta", ["si", "SI", "  Si  ", "sI\n"])
async def test_sin_la_bandera_responder_si_confirma(limpieza, monkeypatch, respuesta):
    monkeypatch.setattr("sys.argv", ["limpiar_datos"])
    limpieza.respuesta = respuesta
    await limpiar_datos.main()
    assert limpieza.tablas == [limpieza.settings.database_url]
    assert limpieza.storage == [("https://x.supabase.co", "llave-falsa")]


async def test_el_aviso_dice_que_se_borra_y_no_usa_voseo(limpieza, monkeypatch):
    monkeypatch.setattr("sys.argv", ["limpiar_datos"])
    limpieza.respuesta = "no"
    await limpiar_datos.main()
    assert "TODAS las entregas, logs y fotos" in limpieza.prompt
    assert "Escribe 'si'" in limpieza.prompt and "Escribi" not in limpieza.prompt


async def test_con_si_no_pregunta_y_borra(limpieza, monkeypatch):
    monkeypatch.setattr("sys.argv", ["limpiar_datos", "--si"])
    await limpiar_datos.main()
    assert limpieza.preguntas == 0
    assert len(limpieza.tablas) == 1 and len(limpieza.storage) == 1


async def test_sin_credenciales_de_storage_solo_vacia_la_base(limpieza, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["limpiar_datos", "--si"])
    limpieza.settings.supabase_secret_key = ""
    await limpiar_datos.main()
    assert len(limpieza.tablas) == 1 and limpieza.storage == []
    assert "Listo" in capsys.readouterr().out


async def test_si_falla_la_base_no_se_toca_el_storage(limpieza, monkeypatch):
    async def _falla(url):
        raise RuntimeError("base caida")

    monkeypatch.setattr("sys.argv", ["limpiar_datos", "--si"])
    monkeypatch.setattr(limpiar_datos, "vaciar_tablas", _falla)
    with pytest.raises(RuntimeError):
        await limpiar_datos.main()
    assert limpieza.storage == []


# --------------------------------------------------------------------------
# limpiar_datos: que tablas toca
# --------------------------------------------------------------------------


async def test_vaciar_tablas_solo_toca_entregas_y_logs(conexion, capsys):
    conexion.responder("fetchrow", "select (select count(*) from entregas)", {"entregas": 3, "logs": 9})
    await limpiar_datos.vaciar_tablas("postgresql://prueba@127.0.0.1:1/prueba")

    sentencias = [c[1].lower() for c in conexion.llamadas if c[0] == "execute"]
    assert sentencias == ["delete from entregas", "truncate table logs"]
    texto = " ".join(sentencias)
    for intacta in ("sedes", "empleados", "turnos", "productos", "puntos", "usuarios", "supervisores", "tipos_documento", "traslados", "talonarios", "shift_recommendations", "facturas_faltantes"):
        assert intacta not in texto
    assert "borradas 3 entregas y 9 logs" in capsys.readouterr().out
    assert conexion.cerrada
    assert conexion.urls == ["postgresql://prueba@127.0.0.1:1/prueba"]


async def test_vaciar_tablas_cierra_la_conexion_aunque_falle(conexion):
    conexion.responder("execute", "delete from entregas", RuntimeError("falla"))
    conexion.responder("fetchrow", "select", {"entregas": 0, "logs": 0})
    with pytest.raises(RuntimeError):
        await limpiar_datos.vaciar_tablas("postgresql://x@127.0.0.1:1/x")
    assert conexion.cerrada


# --------------------------------------------------------------------------
# limpiar_datos: Storage (HTTP simulado, nunca Supabase real)
# --------------------------------------------------------------------------


@pytest.fixture
def storage(monkeypatch):
    """Cliente HTTP con transporte simulado: registra cada peticion y responde
    con el guion `respuestas[(metodo, prefijo)]`."""
    peticiones: list[httpx.Request] = []
    guion: dict = {"listados": {}, "delete_status": 200, "list_status": 200}

    def _manejar(request: httpx.Request) -> httpx.Response:
        peticiones.append(request)
        if request.method == "POST":
            prefijo = json.loads(request.content)["prefix"]
            return httpx.Response(guion["list_status"], json=guion["listados"].get(prefijo, []))
        return httpx.Response(guion["delete_status"], json=[])

    transporte = httpx.MockTransport(_manejar)
    original = httpx.AsyncClient
    monkeypatch.setattr(limpiar_datos.httpx, "AsyncClient", lambda **kw: original(transport=transporte, **kw))
    guion["peticiones"] = peticiones
    return guion


async def test_vaciar_storage_borra_solo_los_archivos_del_bucket_evidencia(storage, capsys):
    storage["listados"] = {
        "": [{"name": "carpeta-a", "id": None}, {"name": "suelto.webp", "id": "x1"}, {"name": "carpeta-b", "id": None}],
        "carpeta-a": [{"name": "1.webp", "id": "i1"}, {"name": "2.webp", "id": "i2"}],
        "carpeta-b": [{"name": "3.webp", "id": "i3"}],
    }
    await limpiar_datos.vaciar_storage("https://x.supabase.co", "llave-falsa")

    borrado = [p for p in storage["peticiones"] if p.method == "DELETE"]
    assert len(borrado) == 1
    assert str(borrado[0].url) == "https://x.supabase.co/storage/v1/object/evidencia"
    assert json.loads(borrado[0].content) == {"prefixes": ["carpeta-a/1.webp", "carpeta-a/2.webp", "carpeta-b/3.webp"]}
    assert "borradas 3 fotos del bucket 'evidencia'" in capsys.readouterr().out


async def test_vaciar_storage_todas_las_peticiones_van_al_bucket_evidencia_con_la_llave(storage):
    storage["listados"] = {"": [{"name": "c", "id": None}], "c": [{"name": "1.webp", "id": "i"}]}
    await limpiar_datos.vaciar_storage("https://x.supabase.co", "llave-falsa")
    for peticion in storage["peticiones"]:
        assert str(peticion.url).startswith("https://x.supabase.co/storage/v1/object/")
        assert str(peticion.url).endswith("/evidencia")
        assert peticion.headers["apikey"] == "llave-falsa"
        assert peticion.headers["authorization"] == "Bearer llave-falsa"
    assert {p.url.host for p in storage["peticiones"]} == {"x.supabase.co"}


async def test_vaciar_storage_sin_fotos_no_manda_ningun_delete(storage, capsys):
    storage["listados"] = {"": []}
    await limpiar_datos.vaciar_storage("https://x.supabase.co", "llave-falsa")
    assert [p.method for p in storage["peticiones"]] == ["POST"]
    assert "no habia fotos" in capsys.readouterr().out


async def test_vaciar_storage_con_error_del_listado_no_borra_nada(storage):
    storage["list_status"] = 500
    with pytest.raises(httpx.HTTPStatusError):
        await limpiar_datos.vaciar_storage("https://x.supabase.co", "llave-falsa")
    assert all(p.method == "POST" for p in storage["peticiones"])


async def test_vaciar_storage_propaga_el_error_del_delete(storage):
    storage["listados"] = {"": [{"name": "c", "id": None}], "c": [{"name": "1.webp", "id": "i"}]}
    storage["delete_status"] = 403
    with pytest.raises(httpx.HTTPStatusError):
        await limpiar_datos.vaciar_storage("https://x.supabase.co", "llave-falsa")


# --------------------------------------------------------------------------
# cargar_puntos
# --------------------------------------------------------------------------


def test_la_lista_oficial_de_puntos_no_tiene_codigos_ni_nombres_repetidos():
    codigos = [c for c, _ in cargar_puntos.PUNTOS]
    nombres = [n for _, n in cargar_puntos.PUNTOS]
    assert len(set(codigos)) == len(codigos) and len(set(nombres)) == len(nombres)
    assert all(c == c.strip().upper() and c.isalnum() and 1 <= len(c) <= 4 for c in codigos)
    assert all(n == n.strip() and n for n in nombres)


async def test_asegurar_cuenta_actualiza_la_activa_si_existe_y_no_inserta(conn):
    conn.responder("fetchval", "update usuarios_punto", "id-existente")
    await cargar_puntos.asegurar_cuenta(conn, "punto-1", "TB — Chiquinquirá", "4821")
    assert conn.sql_ejecutado("insert into usuarios_punto") == []
    (_, sql, args) = conn.sql_ejecutado("update usuarios_punto")[0]
    assert "estado = 'activo'" in sql
    assert args[0] == "punto-1" and args[1] == "TB — Chiquinquirá"
    pin_hash, sal = args[2], args[3]
    assert pin_hash == hashear_pin("4821", sal) and "4821" not in args


async def test_asegurar_cuenta_inserta_si_no_hay_cuenta_activa(conn):
    conn.responder("fetchval", "update usuarios_punto", None)
    await cargar_puntos.asegurar_cuenta(conn, "punto-1", "TB — Chiquinquirá", "4821")
    (_, _, args) = conn.sql_ejecutado("insert into usuarios_punto")[0]
    assert args[:2] == ("TB — Chiquinquirá", "punto-1")
    assert args[2] == hashear_pin("4821", args[3]) and "4821" not in args


async def test_dos_cuentas_con_el_mismo_pin_no_comparten_hash(conn):
    conn.responder("fetchval", "update usuarios_punto", None)
    await cargar_puntos.asegurar_cuenta(conn, "p1", "A", "4821")
    await cargar_puntos.asegurar_cuenta(conn, "p2", "B", "4821")
    inserts = conn.sql_ejecutado("insert into usuarios_punto")
    assert inserts[0][2][2] != inserts[1][2][2]  # sal distinta por cuenta


@pytest.mark.parametrize("pin", ["123", "1234567", "abcd", "12 34", "12.5", "-1234", ""])
async def test_pin_invalido_termina_el_programa_sin_conectar(conexion, monkeypatch, pin):
    monkeypatch.setattr("sys.argv", ["cargar_puntos", "--pin", pin])
    with pytest.raises(SystemExit) as info:
        await cargar_puntos.main()
    assert info.value.code == 2
    assert conexion.urls == [] and conexion.llamadas == []


@pytest.mark.parametrize("pin", ["1234", "123456", "0000"])
async def test_pin_valido_se_aplica_a_todos_los_puntos(conexion, monkeypatch, pin):
    conexion.responder("fetchval", "insert into puntos", "id-punto")
    conexion.responder("fetchval", "update usuarios_punto", None)
    conexion.responder("fetchval", "select count(*)", 24)
    monkeypatch.setattr("sys.argv", ["cargar_puntos", "--pin", pin])
    await cargar_puntos.main()
    assert len(conexion.sql_ejecutado("insert into usuarios_punto")) == len(cargar_puntos.PUNTOS)
    assert conexion.cerrada


async def test_sin_pin_solo_carga_puntos_con_upsert_y_nunca_borra(conexion, monkeypatch, capsys):
    conexion.responder("fetchval", "insert into puntos", "id-punto")
    conexion.responder("fetchval", "select count(*)", 24)
    monkeypatch.setattr("sys.argv", ["cargar_puntos"])
    await cargar_puntos.main()

    inserts = conexion.sql_ejecutado("insert into puntos")
    assert len(inserts) == len(cargar_puntos.PUNTOS)
    assert "on conflict (codigo) do update" in inserts[0][1] and "activo = true" in inserts[0][1]
    assert inserts[0][2] == ("CFC", "CFC — La Cumbre")  # el nombre guarda "CODIGO — Nombre"
    assert conexion.sql_ejecutado("usuarios_punto") == []  # sin --pin no se tocan cuentas
    todo = " ".join(c[1].lower() for c in conexion.llamadas)
    assert "delete" not in todo and "truncate" not in todo and "update puntos" not in todo
    assert f"Cargados {len(cargar_puntos.PUNTOS)} puntos" in capsys.readouterr().out


# --------------------------------------------------------------------------
# crear_admin_dashboard
# --------------------------------------------------------------------------


@pytest.fixture
def admin_cli(monkeypatch):
    estado = SimpleNamespace(passwords=["clave-segura-1", "clave-segura-1"], schema=0, cerrado=0, llamado=None)

    def _getpass(prompt=""):
        return estado.passwords.pop(0)

    async def _ensure():
        estado.schema += 1

    async def _get_pool():
        class _Pool:
            def acquire(self):
                class _Ctx:
                    async def __aenter__(self_inner):
                        return "conexion"

                    async def __aexit__(self_inner, *exc):
                        return False

                return _Ctx()

        return _Pool()

    async def _close():
        estado.cerrado += 1

    async def _crear(conn, usuario, nombre, password):
        estado.llamado = (usuario, nombre, password)
        return "creado"

    monkeypatch.setattr(crear_admin_dashboard.getpass, "getpass", _getpass)
    monkeypatch.setattr(crear_admin_dashboard, "ensure_schema", _ensure)
    monkeypatch.setattr(crear_admin_dashboard, "get_pool", _get_pool)
    monkeypatch.setattr(crear_admin_dashboard, "close_pool", _close)
    monkeypatch.setattr(crear_admin_dashboard, "crear_o_actualizar_admin", _crear)
    return estado


def argv(monkeypatch, usuario="Neider", nombre="Neider A."):
    monkeypatch.setattr("sys.argv", ["crear_admin_dashboard", "--usuario", usuario, "--nombre", nombre])


async def test_crea_el_admin_con_usuario_normalizado_y_cierra_el_pool(admin_cli, monkeypatch, capsys):
    argv(monkeypatch, "  NEIDER ", "  Neider A.  ")
    await crear_admin_dashboard.main()
    assert admin_cli.llamado == ("neider", "Neider A.", "clave-segura-1")
    assert admin_cli.schema == 1 and admin_cli.cerrado == 1
    assert "admin 'neider' creado" in capsys.readouterr().out


@pytest.mark.parametrize("usuario", ["ab", "con espacio", "ñandu", "a" * 51, "mal/uso", ""])
async def test_usuario_invalido_termina_antes_de_pedir_la_contrasena(admin_cli, monkeypatch, usuario):
    argv(monkeypatch, usuario)
    with pytest.raises(SystemExit) as info:
        await crear_admin_dashboard.main()
    assert "Usuario invalido" in str(info.value)
    assert len(admin_cli.passwords) == 2 and admin_cli.schema == 0 and admin_cli.llamado is None


async def test_nombre_vacio_termina(admin_cli, monkeypatch):
    argv(monkeypatch, nombre="   ")
    with pytest.raises(SystemExit) as info:
        await crear_admin_dashboard.main()
    assert "nombre no puede quedar vacio" in str(info.value)
    assert admin_cli.llamado is None


async def test_contrasenas_distintas_terminan_sin_tocar_la_base(admin_cli, monkeypatch):
    argv(monkeypatch)
    admin_cli.passwords = ["clave-segura-1", "otra-clave-xyz"]
    with pytest.raises(SystemExit) as info:
        await crear_admin_dashboard.main()
    assert "no coinciden" in str(info.value)
    assert admin_cli.schema == 0 and admin_cli.llamado is None


@pytest.mark.parametrize("password", ["corta", "x" * 7, "x" * 201])
async def test_contrasena_fuera_de_rango_termina_sin_tocar_la_base(admin_cli, monkeypatch, password):
    argv(monkeypatch)
    admin_cli.passwords = [password, password]
    with pytest.raises(SystemExit) as info:
        await crear_admin_dashboard.main()
    assert "entre 8 y 200 caracteres" in str(info.value)
    assert admin_cli.schema == 0 and admin_cli.llamado is None


@pytest.mark.parametrize("password", ["x" * 8, "x" * 200])
async def test_contrasena_en_los_limites_se_acepta(admin_cli, monkeypatch, password):
    argv(monkeypatch)
    admin_cli.passwords = [password, password]
    await crear_admin_dashboard.main()
    assert admin_cli.llamado[2] == password


async def test_el_script_cierra_el_pool_aunque_falle_la_creacion(admin_cli, monkeypatch):
    async def _falla(conn, usuario, nombre, password):
        raise RuntimeError("base caida")

    argv(monkeypatch)
    monkeypatch.setattr(crear_admin_dashboard, "crear_o_actualizar_admin", _falla)
    with pytest.raises(RuntimeError):
        await crear_admin_dashboard.main()
    assert admin_cli.cerrado == 1


async def test_la_contrasena_no_se_acepta_por_argumento(admin_cli, monkeypatch):
    monkeypatch.setattr(
        "sys.argv", ["crear_admin_dashboard", "--usuario", "neider", "--nombre", "N", "--password", "secreta123"]
    )
    with pytest.raises(SystemExit) as info:
        await crear_admin_dashboard.main()
    assert info.value.code == 2  # argparse rechaza la opcion desconocida: nada queda en el historial


# --- crear_o_actualizar_admin (servicio que usa el script) -------------------


async def test_crear_o_actualizar_admin_crea_con_hash_y_rol_admin(conn):
    from app.services.usuarios_dashboard import crear_o_actualizar_admin

    conn.responder("fetchval", "select id from usuarios_dashboard", None)
    assert await crear_o_actualizar_admin(conn, "neider", "Neider", "clave-segura-1") == "creado"
    (_, sql, args) = conn.sql_ejecutado("insert into usuarios_dashboard")[0]
    assert "'admin'" in sql
    assert args[:2] == ("neider", "Neider") and "clave-segura-1" not in args


async def test_crear_o_actualizar_admin_existente_resetea_clave_rol_area_y_bloqueo(conn):
    from app.services.usuarios_dashboard import crear_o_actualizar_admin

    conn.responder("fetchval", "select id from usuarios_dashboard", "id-1")
    assert await crear_o_actualizar_admin(conn, "neider", "Neider", "clave-nueva-2") == "actualizado"
    (_, sql, args) = conn.sql_ejecutado("update usuarios_dashboard")[0]
    for fragmento in ("rol = 'admin'", "area = 'todo'", "activo = true", "intentos_fallidos = 0", "bloqueado_hasta = null"):
        assert fragmento in sql
    assert "clave-nueva-2" not in args
    assert conn.sql_ejecutado("insert into usuarios_dashboard") == []
