"""Lectura del talonario de traslados entre puntos a partir de una foto, con
el mismo LLM de vision que las guias de Despachos.

Vive aparte de app/services/vision.py a proposito: Despachos no se toca. De
ese modulo solo se reutilizan, sin modificarlos, la descarga de la foto
(_descargar_imagen) y la excepcion ExtraccionFallida (asi el router de
traslados la mapea a 422 igual que entregas.py).
"""

import base64
import io
import json

import httpx
from openai import AsyncOpenAI, OpenAIError
from PIL import Image

from app.config import get_settings
from app.services.vision import ExtraccionFallida, _descargar_imagen

# Talonario de traslados entre puntos: encabezado (numero, destino,
# transportador, fecha) + productos. Mismo criterio que _EXTRACTION_SCHEMA:
# strict, todas las propiedades requeridas, y lo ilegible viaja como cadena
# vacia con confianza baja (el servicio decide que hacer con eso, ver
# extraer_talonario en app/services/traslados_puntos.py).
_TALONARIO_SCHEMA = {
    "type": "object",
    "properties": {
        "numero_talonario": {
            "type": "string",
            "description": "Numero impreso dentro del recuadro de la esquina superior derecha del talonario.",
        },
        "destino": {"type": "string", "description": "Punto/bodega de destino del traslado, tal cual esta escrito."},
        "transportador": {"type": "string", "description": "Nombre de quien transporta la mercancia."},
        "fecha": {"type": "string", "description": "Fecha del talonario en formato YYYY-MM-DD, o cadena vacia."},
        "llega_directo": {
            "type": "boolean",
            "description": (
                "true si en el campo 'bodega origen' dice 'Llega directo' (o algo equivalente, como "
                "'directo' o 'llega directo del proveedor'); false si trae una bodega u otro texto, o esta vacio."
            ),
        },
        "items": {
            "type": "array",
            "description": "Productos del talonario, uno por renglon.",
            "items": {
                "type": "object",
                "properties": {
                    "cantidad": {"type": "integer"},
                    "producto": {"type": "string"},
                    "marca": {"type": "string"},
                    "presentacion": {"type": "string"},
                    "fecha_vencimiento": {
                        "type": "string",
                        "description": "Fecha de vencimiento YYYY-MM-DD, o cadena vacia si el renglon no la trae.",
                    },
                },
                "required": ["cantidad", "producto", "marca", "presentacion", "fecha_vencimiento"],
                "additionalProperties": False,
            },
        },
        "texto_libre": {
            "type": "string",
            "description": (
                "Transcripcion literal, tal cual esta escrito, de cualquier texto libre (a mano o impreso) que "
                "aparezca en el area de contenido de la hoja, fuera o por encima de los renglones de productos "
                "(por ejemplo, anotaciones escritas sobre los encabezados de la tabla). Cadena vacia si no hay."
            ),
        },
        "confianza": {
            "type": "object",
            "description": "Score 0-1 de confianza por cada campo del encabezado.",
            "properties": {
                "numero_talonario": {"type": "number"},
                "destino": {"type": "number"},
                "transportador": {"type": "number"},
                "fecha": {"type": "number"},
            },
            "required": ["numero_talonario", "destino", "transportador", "fecha"],
            "additionalProperties": False,
        },
    },
    "required": ["numero_talonario", "destino", "transportador", "fecha", "llega_directo", "items", "texto_libre", "confianza"],
    "additionalProperties": False,
}

_TALONARIO_PROMPT = (
    "Esta es una foto de un talonario de traslado entre bodegas. La foto puede "
    "venir rotada o al reves (90, 180 o 270 grados) -- fijate en la orientacion "
    "del texto y leelo como corresponde. Transcribi: numero_talonario (el "
    "numero impreso dentro del recuadro de la esquina superior derecha), "
    "destino (a que bodega/punto va la mercancia), transportador (quien la "
    "lleva), fecha, y la lista de productos con cantidad, producto, marca, "
    "presentacion y fecha de vencimiento (si el renglon la trae). Tambien "
    "llega_directo: true solo si el campo 'bodega origen' dice 'Llega directo' "
    "(la mercancia llega del proveedor al punto, sin bodega que despache); en "
    "ese caso destino y transportador pueden quedar vacios. Las fechas "
    "son colombianas, en formato dd/mm/aaaa: conviertelas SIEMPRE a ISO "
    "YYYY-MM-DD (ej. '05/03/2026' -> '2026-03-05'). Si un dato no esta o no "
    "se lee, usa cadena vacia (o fecha_vencimiento vacia) y una confianza "
    "baja en vez de inventar un valor. Asigna un score de confianza entre 0 y "
    "1 a numero_talonario, destino, transportador y fecha segun que tan "
    "legible estaba cada uno. Lista todos los productos, uno por renglon. "
    "Ademas, en texto_libre transcribe literalmente, sin resumir ni corregir, "
    "cualquier texto libre escrito en el area de contenido de la hoja fuera de "
    "los renglones de productos (por ejemplo, notas escritas a mano sobre los "
    "encabezados de la tabla), en una sola linea: une los renglones con un "
    "espacio, sin saltos de linea. Si no hay, usa "
    "cadena vacia."
)


def _armar_prompt(destinos: list[str], letras: list[str] | None = None) -> str:
    """Agrega al prompt los puntos de destino registrados, para que el modelo
    devuelva uno de ellos (tal cual esta escrito en la lista) en vez de la
    transcripcion literal de la letra a mano, y las letras de prefijo de los
    talonarios activos, para que lea bien la letra del numero (V, no U)."""
    prompt = _TALONARIO_PROMPT
    if letras:
        prompt += (
            " El numero empieza con una letra de prefijo; los talonarios activos "
            f"usan: {', '.join(letras)}. Transcríbelo como letra + numero (ej. "
            f"'{letras[0]} 120')."
        )
    if not destinos:
        return prompt
    lista = "; ".join(destinos)
    return (
        f"{prompt} Los puntos de destino registrados son: {lista}. "
        "Si el destino escrito corresponde a uno de ellos (aunque este "
        "abreviado, incompleto o mal escrito), devuelve en destino el nombre "
        "exactamente como aparece en esa lista. Si no corresponde a ninguno, "
        "transcribelo tal cual con una confianza baja."
    )


async def extraer_datos_talonario(
    evidencia_url: str, destinos: list[str] | None = None, letras: list[str] | None = None
) -> dict:
    """Lee la foto de un talonario de traslado (encabezado + productos).

    `destinos` son los nombres de los puntos validos como destino; se le
    muestran al modelo para que elija entre ellos (ver _armar_prompt).
    `letras` son los prefijos de los talonarios activos del punto origen.

    Devuelve el dict validado contra _TALONARIO_SCHEMA. Lanza ExtraccionFallida
    si no se pudo descargar la foto, el proveedor de IA rehusa la solicitud o
    falla la extraccion. Mismo criterio que extraer_datos_guia en vision.py:
    WebP calidad 80, timeout de 30 s y sin temperature (el modelo la rechaza).
    """
    settings = get_settings()
    try:
        image_bytes, _ = await _descargar_imagen(evidencia_url)
    except httpx.HTTPError as exc:
        raise ExtraccionFallida(f"No se pudo descargar la foto del talonario: {exc}") from exc

    imagen = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    buffer = io.BytesIO()
    imagen.save(buffer, format="WEBP", quality=80)
    image_b64 = base64.standard_b64encode(buffer.getvalue()).decode("utf-8")

    client = AsyncOpenAI(api_key=settings.openai_api_key, timeout=30.0)
    try:
        response = await client.chat.completions.create(
            model=settings.vision_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/webp;base64,{image_b64}"}},
                        {"type": "text", "text": _armar_prompt(destinos or [], letras)},
                    ],
                }
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "extraccion_talonario",
                    "strict": True,
                    "schema": _TALONARIO_SCHEMA,
                },
            },
        )
    except OpenAIError as exc:
        raise ExtraccionFallida(f"Fallo la lectura del talonario con IA: {exc}") from exc

    mensaje = response.choices[0].message
    if getattr(mensaje, "refusal", None):
        raise ExtraccionFallida(f"El modelo de vision rechazo procesar la imagen: {mensaje.refusal}")
    if not mensaje.content:
        raise ExtraccionFallida("Respuesta sin contenido estructurado.")

    try:
        return json.loads(mensaje.content)
    except json.JSONDecodeError as exc:
        raise ExtraccionFallida(f"Respuesta de IA invalida: {exc}") from exc
