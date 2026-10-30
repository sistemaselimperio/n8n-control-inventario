"""Extraccion con IA (app/services/vision.py). OpenAI esta siempre simulado
(fixture `vision` en conftest): no hay red ni claves reales."""

import httpx
import pytest
from openai import OpenAIError

from app.services.vision import ExtraccionFallida, extraer_datos_guia
from tests import respuestas_vision as r

URL = "https://storage.prueba/foto.webp"


async def test_alta_confianza_devuelve_el_json_estructurado(vision):
    vision.responder(r.ALTA_CONFIANZA)
    assert await extraer_datos_guia(URL) == r.ALTA_CONFIANZA


async def test_baja_confianza_se_devuelve_tal_cual(vision):
    vision.responder(r.BAJA_CONFIANZA)
    datos = await extraer_datos_guia(URL)
    assert datos["confianza"]["indicativo_numero"] == 0.5


async def test_varios_items(vision):
    vision.responder(r.VARIOS_ITEMS)
    datos = await extraer_datos_guia(URL)
    assert [i["cantidad"] for i in datos["items"]] == [4, 10, 6]


async def test_pide_salida_estructurada_estricta_con_imagen_webp(vision):
    vision.responder(r.ALTA_CONFIANZA)
    await extraer_datos_guia(URL)
    (llamada,) = vision.llamadas
    formato = llamada["response_format"]
    assert formato["type"] == "json_schema"
    assert formato["json_schema"]["strict"] is True
    assert llamada["model"] == "modelo-de-prueba"
    contenido = llamada["messages"][0]["content"]
    assert contenido[0]["image_url"]["url"].startswith("data:image/webp;base64,")
    # La lista de tipos del prompt sale de la tabla de tipos de documento.
    assert "FEI, FV1, EDP" in contenido[1]["text"]
    assert "temperature" not in llamada  # el modelo configurado la rechaza


async def test_respuesta_malformada_es_extraccion_fallida(vision):
    vision.responder(r.MALFORMADA)
    with pytest.raises(ExtraccionFallida, match="Respuesta de IA invalida"):
        await extraer_datos_guia(URL)


async def test_respuesta_vacia_es_extraccion_fallida(vision):
    vision.responder(None)
    with pytest.raises(ExtraccionFallida, match="sin contenido"):
        await extraer_datos_guia(URL)


async def test_rechazo_del_modelo_es_extraccion_fallida(vision):
    vision.responder(None)
    vision.refusal = "no puedo procesar esta imagen"
    with pytest.raises(ExtraccionFallida, match="rechazo procesar"):
        await extraer_datos_guia(URL)


async def test_error_del_proveedor_es_extraccion_fallida(vision):
    vision.error = OpenAIError("rate limit agotado")
    with pytest.raises(ExtraccionFallida, match="Fallo la extraccion con IA"):
        await extraer_datos_guia(URL)


async def test_falla_la_descarga_de_la_evidencia(vision):
    vision.error_descarga = httpx.ConnectError("sin red")
    with pytest.raises(ExtraccionFallida, match="No se pudo descargar"):
        await extraer_datos_guia(URL)
    assert vision.llamadas == []  # ni siquiera se llamo a la IA
