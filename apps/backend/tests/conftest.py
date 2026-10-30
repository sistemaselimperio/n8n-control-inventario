"""Configuracion comun de la suite.

Regla de oro: los tests NUNCA leen secretos reales. Antes de importar la app
se fijan variables de entorno falsas y se desactiva la lectura del archivo
`.env` (que en una maquina de desarrollo trae la DATABASE_URL de produccion).
"""

from __future__ import annotations

import os
import sys

# --- Entorno seguro: debe ocurrir ANTES de importar cualquier modulo de app ---
_ENTORNO_PRUEBA = {
    # URL inalcanzable a proposito: si algun test intentara abrir un pool real,
    # fallaria en vez de tocar una base verdadera.
    "DATABASE_URL": "postgresql://prueba:prueba@127.0.0.1:1/prueba",
    "OPENAI_API_KEY": "sk-prueba-no-real",
    "VISION_MODEL": "modelo-de-prueba",
    "SUPABASE_URL": "",
    "SUPABASE_SECRET_KEY": "",
    "DASHBOARD_ORIGIN": "http://localhost:3000",
    "MIN_CONFIDENCE": "0.75",
    "MIN_CONFIDENCE_RECHAZO": "0.35",
    "ADMIN_DELETE_TOKEN": "token-admin-de-prueba",
    "DASHBOARD_SESSION_SECRET": "secreto-de-sesion-de-prueba",
}
os.environ.update(_ENTORNO_PRUEBA)

from app import config  # noqa: E402

# Ignora el .env del disco: las variables de arriba son la unica fuente.
config.Settings.model_config["env_file"] = None
config.get_settings.cache_clear()

import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402
from tests.fakes import FakeConn, FakePool  # noqa: E402

_get_pool_original = db.get_pool


def _parchear_get_pool(monkeypatch: pytest.MonkeyPatch, reemplazo) -> None:
    """Varios modulos hacen `from app.db import get_pool`, asi que parchear solo
    `app.db.get_pool` no alcanza: se reemplaza en cada modulo que lo importo."""
    for nombre, modulo in list(sys.modules.items()):
        if nombre.startswith("app.") or nombre == "app":
            if getattr(modulo, "get_pool", None) is _get_pool_original:
                monkeypatch.setattr(modulo, "get_pool", reemplazo)
    monkeypatch.setattr(db, "get_pool", reemplazo)


@pytest.fixture(autouse=True)
def _ajustes_limpios():
    """Cada test arranca con la cache de settings vacia (los tests que cambian
    variables de entorno no se contaminan entre si)."""
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.fixture
def conn() -> FakeConn:
    return FakeConn()


@pytest.fixture
def pool(conn: FakeConn, monkeypatch: pytest.MonkeyPatch) -> FakePool:
    """Pool falso instalado en todos los modulos de la app."""
    falso = FakePool(conn)

    async def _get_pool_falso():
        return falso

    _parchear_get_pool(monkeypatch, _get_pool_falso)
    return falso


@pytest_asyncio.fixture
async def cliente():
    """Cliente HTTP contra la app ASGI, sin correr el lifespan (asi no se llama
    a ensure_schema ni se abre un pool)."""
    transporte = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transporte, base_url="http://prueba") as c:
        yield c


@pytest.fixture
def admin_headers() -> dict[str, str]:
    return {"X-Admin-Token": _ENTORNO_PRUEBA["ADMIN_DELETE_TOKEN"]}


# ---------------------------------------------------------------------------
# OpenAI siempre falso
# ---------------------------------------------------------------------------


def _png_minimo() -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(buffer, format="PNG")
    return buffer.getvalue()


class VisionFalsa:
    """Guion del cliente de vision: define que contesta el 'modelo'."""

    def __init__(self) -> None:
        self.contenido: str | None = None
        self.refusal: str | None = None
        self.error: BaseException | None = None
        self.error_descarga: BaseException | None = None
        self.llamadas: list[dict] = []

    def responder(self, datos: dict | str | None) -> "VisionFalsa":
        import json

        self.contenido = datos if isinstance(datos, str) or datos is None else json.dumps(datos)
        return self


@pytest.fixture
def vision(monkeypatch: pytest.MonkeyPatch) -> VisionFalsa:
    """Reemplaza la descarga de la foto y el cliente de OpenAI en
    app.services.vision. Nada sale a la red."""
    from types import SimpleNamespace

    from app.services import vision as modulo

    guion = VisionFalsa()

    async def _descargar(url: str):
        if guion.error_descarga is not None:
            raise guion.error_descarga
        return _png_minimo(), "image/png"

    async def _frase_ejemplos() -> str:
        return "FEI, FV1, EDP"

    class _Completions:
        async def create(self, **kwargs):
            guion.llamadas.append(kwargs)
            if guion.error is not None:
                raise guion.error
            mensaje = SimpleNamespace(content=guion.contenido, refusal=guion.refusal)
            return SimpleNamespace(choices=[SimpleNamespace(message=mensaje)])

    class _ClienteFalso:
        def __init__(self, **kwargs) -> None:
            self.chat = SimpleNamespace(completions=_Completions())

    monkeypatch.setattr(modulo, "_descargar_imagen", _descargar)
    monkeypatch.setattr(modulo, "frase_ejemplos", _frase_ejemplos)
    monkeypatch.setattr(modulo, "AsyncOpenAI", _ClienteFalso)
    return guion
