"""Red de seguridad de la API: una excepcion no prevista siempre sale como
JSON legible (el cliente movil espera poder hacer res.json())."""

import httpx
import pytest

from app.main import app


@pytest.fixture
async def cliente_sin_reraise():
    # Por defecto el transporte re-lanza la excepcion de la app: aqui interesa
    # la respuesta que recibiria un cliente real.
    transporte = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transporte, base_url="http://prueba") as c:
        yield c


async def test_una_excepcion_no_manejada_responde_500_en_json_y_sin_voseo(cliente_sin_reraise, pool, conn):
    conn.responder("fetch", "from sedes", RuntimeError("falla inesperada con datos internos"))
    res = await cliente_sin_reraise.get("/sedes")
    assert res.status_code == 500
    assert res.headers["content-type"].startswith("application/json")
    # Mensaje en espanol neutro (sin voseo) y sin filtrar el detalle de la excepcion.
    assert res.json() == {"detail": "Error interno del servidor, intenta de nuevo."}
    assert "datos internos" not in res.text


async def test_health_informa_el_marcador_de_build(cliente):
    res = await cliente.get("/health")
    assert res.status_code == 200
    cuerpo = res.json()
    assert cuerpo["status"] == "ok" and cuerpo["build"] and isinstance(cuerpo["build"], str)
