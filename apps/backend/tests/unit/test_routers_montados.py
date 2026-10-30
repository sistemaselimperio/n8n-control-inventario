"""Que cada router este realmente montado en la app, y la logica trivial de
scripts/setup_storage.py (con la red y la base simuladas: nunca se llama a
Supabase)."""

from __future__ import annotations

import importlib
import pkgutil
from types import SimpleNamespace

import httpx
import pytest

import app.routers as paquete_routers
from app.main import app
from app.routers import dashboard_auth, shifts
from scripts import setup_storage
from tests.fakes import FakeConn


def _modulos_con_router():
    for info in pkgutil.iter_modules(paquete_routers.__path__):
        modulo = importlib.import_module(f"app.routers.{info.name}")
        if hasattr(modulo, "router"):
            yield info.name, modulo


def test_toda_ruta_de_cada_router_esta_montada_en_la_app():
    """Un router olvidado en main.py deja sus endpoints inalcanzables sin que
    nada falle al arrancar."""
    montadas = {(r.path, tuple(sorted(r.methods))) for r in app.routes if hasattr(r, "methods")}
    faltantes = []
    for nombre, modulo in _modulos_con_router():
        for ruta in modulo.router.routes:
            if (ruta.path, tuple(sorted(ruta.methods))) not in montadas:
                faltantes.append((nombre, ruta.path))
    assert not faltantes, f"Rutas de routers que no estan en la app: {faltantes}"


def test_routers_conocidos():
    nombres = {nombre for nombre, _ in _modulos_con_router()}
    assert {"shifts", "dashboard_auth", "ranking", "logs", "productos"} <= nombres


def test_prefijos_de_los_routers_de_turnos_y_login():
    assert shifts.router.prefix == "/turnos"
    rutas = {r.path for r in dashboard_auth.router.routes}
    assert {"/dashboard/auth/login", "/dashboard/auth/yo", "/dashboard/usuarios"} <= rutas


# --------------------------------------------------------------------------
# scripts/setup_storage.py
# --------------------------------------------------------------------------


async def test_sin_credenciales_de_supabase_el_script_termina_sin_conectar(monkeypatch):
    vacio = SimpleNamespace(supabase_url="", supabase_secret_key="", database_url="postgresql://x@127.0.0.1:1/x")
    monkeypatch.setattr(setup_storage, "get_settings", lambda: vacio)
    llamado = []

    async def _no(*args, **kwargs):
        llamado.append(args)

    monkeypatch.setattr(setup_storage, "crear_bucket", _no)
    monkeypatch.setattr(setup_storage, "crear_policies", _no)
    with pytest.raises(SystemExit) as info:
        await setup_storage.main()
    assert "SUPABASE_URL" in str(info.value) and llamado == []


@pytest.fixture
def red(monkeypatch):
    peticiones: list[httpx.Request] = []
    guion = {"status": 200, "texto": "{}"}

    def _manejar(request: httpx.Request) -> httpx.Response:
        peticiones.append(request)
        return httpx.Response(guion["status"], text=guion["texto"])

    original = httpx.AsyncClient
    monkeypatch.setattr(
        setup_storage.httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(_manejar), **kw)
    )
    guion["peticiones"] = peticiones
    return guion


async def test_crear_bucket_publico_con_la_llave_secreta(red, capsys):
    await setup_storage.crear_bucket("https://x.supabase.co", "llave-falsa")
    (peticion,) = red["peticiones"]
    assert str(peticion.url) == "https://x.supabase.co/storage/v1/bucket"
    assert peticion.headers["authorization"] == "Bearer llave-falsa"
    assert b'"id":"evidencia"' in peticion.content.replace(b" ", b"")
    assert "creado" in capsys.readouterr().out


async def test_un_bucket_que_ya_existe_no_es_error(red, capsys):
    red["status"], red["texto"] = 400, '{"message": "The resource already exists"}'
    await setup_storage.crear_bucket("https://x.supabase.co", "llave-falsa")
    assert "ya existia" in capsys.readouterr().out


@pytest.mark.parametrize("status", [400, 401, 403, 500])
async def test_cualquier_otro_error_al_crear_el_bucket_se_propaga(red, status):
    red["status"], red["texto"] = status, "otro problema"
    with pytest.raises(httpx.HTTPStatusError):
        await setup_storage.crear_bucket("https://x.supabase.co", "llave-falsa")


async def test_las_policies_de_anon_solo_cubren_insert_select_y_update_del_bucket(monkeypatch):
    conexion = FakeConn()
    conexion.close = lambda: _cerrar(conexion)  # type: ignore[method-assign]

    async def _conectar(url):
        return conexion

    monkeypatch.setattr(setup_storage.asyncpg, "connect", _conectar)
    await setup_storage.crear_policies("postgresql://x@127.0.0.1:1/x")
    ((_, sql, _),) = conexion.llamadas
    texto = sql.lower()
    # El telefono (rol anon) puede subir, leer y re-firmar, pero NUNCA borrar.
    assert texto.count("create policy") == 3
    assert "for insert to anon" in texto and "for select to anon" in texto and "for update to anon" in texto
    assert "for delete" not in texto and "for all" not in texto
    # Todas las policies quedan acotadas al bucket de evidencia.
    assert texto.count("bucket_id = 'evidencia'") >= 4
    assert "drop policy if exists" in texto  # idempotente


async def _cerrar(conexion) -> None:
    conexion.cerrada = True
