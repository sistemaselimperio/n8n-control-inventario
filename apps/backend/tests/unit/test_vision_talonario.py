"""Lectura del talonario con IA (app/services/vision_talonario.py). OpenAI esta
siempre simulado: no hay red ni claves reales.

vision_talonario importa `_descargar_imagen` y `AsyncOpenAI` a su propio
espacio de nombres, asi que el doble del fixture `vision` (que parchea
app.services.vision) no le llega: aqui se parchea el modulo correcto."""

import json
from types import SimpleNamespace

import httpx
import pytest
from openai import OpenAIError

from app.services import vision_talonario as vt
from app.services.vision import ExtraccionFallida
from tests.conftest import VisionFalsa, _png_minimo

URL = "https://storage.prueba/talonario.webp"

ALTA_CONFIANZA = {
    "numero_talonario": "A 6305",
    "destino": "CFC — La Cumbre",
    "transportador": "Pedro Perez",
    "fecha": "2026-03-05",
    "llega_directo": False,
    "items": [
        {"cantidad": 3, "producto": "SAL BLANCA", "marca": "REFISAL", "presentacion": "40 KG", "fecha_vencimiento": "2027-01-31"}
    ],
    "texto_libre": "",
    "confianza": {"numero_talonario": 0.98, "destino": 0.95, "transportador": 0.9, "fecha": 0.97},
}
BAJA_CONFIANZA = {
    **ALTA_CONFIANZA,
    "numero_talonario": "",
    "destino": "",
    "confianza": {"numero_talonario": 0.1, "destino": 0.2, "transportador": 0.9, "fecha": 0.97},
}
MALFORMADA = '{"numero_talonario": "A 6305", "items": ['


@pytest.fixture
def ia(monkeypatch) -> VisionFalsa:
    guion = VisionFalsa()

    async def _descargar(url: str):
        if guion.error_descarga is not None:
            raise guion.error_descarga
        return _png_minimo(), "image/png"

    class _Completions:
        async def create(self, **kwargs):
            guion.llamadas.append(kwargs)
            if guion.error is not None:
                raise guion.error
            mensaje = SimpleNamespace(content=guion.contenido, refusal=guion.refusal)
            return SimpleNamespace(choices=[SimpleNamespace(message=mensaje)])

    class _ClienteFalso:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs
            self.chat = SimpleNamespace(completions=_Completions())

    monkeypatch.setattr(vt, "_descargar_imagen", _descargar)
    monkeypatch.setattr(vt, "AsyncOpenAI", _ClienteFalso)
    return guion


# ---------------------------------------------------------------------------
# _armar_prompt
# ---------------------------------------------------------------------------


def test_prompt_base_sin_destinos_ni_letras_es_el_prompt_fijo():
    assert vt._armar_prompt([]) == vt._TALONARIO_PROMPT
    assert vt._armar_prompt([], []) == vt._TALONARIO_PROMPT
    assert vt._armar_prompt([], None) == vt._TALONARIO_PROMPT


def test_prompt_lista_los_destinos_registrados():
    prompt = vt._armar_prompt(["CFC — La Cumbre", "BDG — Bodega"])
    assert prompt.startswith(vt._TALONARIO_PROMPT)
    assert "CFC — La Cumbre; BDG — Bodega" in prompt
    assert "exactamente como aparece en esa lista" in prompt


def test_prompt_indica_las_letras_de_los_talonarios_activos_con_ejemplo():
    prompt = vt._armar_prompt([], ["A", "V"])
    assert "usan: A, V" in prompt
    assert "'A 120'" in prompt  # el ejemplo usa la primera letra
    assert "Los puntos de destino registrados" not in prompt


def test_prompt_con_letras_y_destinos_incluye_ambos_en_ese_orden():
    prompt = vt._armar_prompt(["CFC"], ["V"])
    assert prompt.index("usan: V") < prompt.index("Los puntos de destino registrados son: CFC")


def test_el_prompt_fijo_pide_fechas_iso_y_llega_directo():
    assert "YYYY-MM-DD" in vt._TALONARIO_PROMPT
    assert "Llega directo" in vt._TALONARIO_PROMPT


def test_el_esquema_es_estricto_y_exige_todas_sus_propiedades():
    esquema = vt._TALONARIO_SCHEMA
    assert esquema["additionalProperties"] is False
    assert set(esquema["required"]) == set(esquema["properties"])
    item = esquema["properties"]["items"]["items"]
    assert set(item["required"]) == set(item["properties"])
    confianza = esquema["properties"]["confianza"]
    assert set(confianza["required"]) == set(confianza["properties"])


# ---------------------------------------------------------------------------
# extraer_datos_talonario
# ---------------------------------------------------------------------------


async def test_lectura_de_alta_confianza_devuelve_el_json(ia):
    ia.responder(ALTA_CONFIANZA)
    assert await vt.extraer_datos_talonario(URL) == ALTA_CONFIANZA


async def test_lectura_de_baja_confianza_se_devuelve_tal_cual(ia):
    ia.responder(BAJA_CONFIANZA)
    datos = await vt.extraer_datos_talonario(URL)
    assert datos["confianza"]["numero_talonario"] == 0.1  # la decision de rechazar la toma el servicio, no la lectura


async def test_pide_salida_estructurada_estricta_con_imagen_webp(ia):
    ia.responder(ALTA_CONFIANZA)
    await vt.extraer_datos_talonario(URL, ["CFC — La Cumbre"], ["A"])
    (llamada,) = ia.llamadas
    formato = llamada["response_format"]
    assert formato["type"] == "json_schema"
    assert formato["json_schema"]["strict"] is True
    assert formato["json_schema"]["name"] == "extraccion_talonario"
    assert llamada["model"] == "modelo-de-prueba"
    contenido = llamada["messages"][0]["content"]
    assert contenido[0]["image_url"]["url"].startswith("data:image/webp;base64,")
    assert "CFC — La Cumbre" in contenido[1]["text"] and "usan: A" in contenido[1]["text"]
    assert "temperature" not in llamada


async def test_sin_destinos_ni_letras_usa_el_prompt_fijo(ia):
    ia.responder(ALTA_CONFIANZA)
    await vt.extraer_datos_talonario(URL)
    assert ia.llamadas[0]["messages"][0]["content"][1]["text"] == vt._TALONARIO_PROMPT


async def test_respuesta_malformada_es_extraccion_fallida(ia):
    ia.responder(MALFORMADA)
    with pytest.raises(ExtraccionFallida, match="Respuesta de IA invalida"):
        await vt.extraer_datos_talonario(URL)


async def test_respuesta_vacia_es_extraccion_fallida(ia):
    ia.responder(None)
    with pytest.raises(ExtraccionFallida, match="sin contenido"):
        await vt.extraer_datos_talonario(URL)


async def test_rechazo_del_modelo_es_extraccion_fallida(ia):
    ia.responder(None)
    ia.refusal = "no puedo procesar esta imagen"
    with pytest.raises(ExtraccionFallida, match="rechazo procesar"):
        await vt.extraer_datos_talonario(URL)


async def test_el_rechazo_tiene_prioridad_sobre_el_contenido(ia):
    ia.responder(ALTA_CONFIANZA)
    ia.refusal = "no"
    with pytest.raises(ExtraccionFallida, match="rechazo procesar"):
        await vt.extraer_datos_talonario(URL)


async def test_error_del_proveedor_es_extraccion_fallida(ia):
    ia.error = OpenAIError("limite de cuota")
    with pytest.raises(ExtraccionFallida, match="Fallo la lectura del talonario con IA"):
        await vt.extraer_datos_talonario(URL)


async def test_error_de_descarga_es_extraccion_fallida_y_no_llama_a_la_ia(ia):
    ia.error_descarga = httpx.ConnectError("sin red")
    with pytest.raises(ExtraccionFallida, match="No se pudo descargar la foto del talonario"):
        await vt.extraer_datos_talonario(URL)
    assert ia.llamadas == []


async def test_el_cliente_se_crea_con_la_clave_y_el_timeout_configurados(ia, monkeypatch):
    creados = []
    original = vt.AsyncOpenAI

    def _espia(**kwargs):
        creados.append(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(vt, "AsyncOpenAI", _espia)
    ia.responder(json.dumps(ALTA_CONFIANZA))
    await vt.extraer_datos_talonario(URL)
    assert creados == [{"api_key": "sk-prueba-no-real", "timeout": 30.0}]
