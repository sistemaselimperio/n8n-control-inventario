"""Lectura del PDF "TRASLADO ENTRE BODEGAS" que genera el sistema contable.

Es un PDF con texto (no un escaneo), asi que no se usa IA: se extrae el texto
con pypdf en modo "layout" (conserva las columnas separadas por espacios) y se
aplican reglas fijas. Las funciones de parseo son puras y devuelven un
borrador; lo que no se pudo leer o no cuadra queda en `advertencias` para que
el supervisor lo corrija a mano antes de enviar (ver
app/services/traslados_bodega.py).
"""

import io
import re
import unicodedata
from datetime import date

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from app.models.traslado_punto import normalizar_numero_syscafe

MAX_PAGINAS = 20


class PdfTrasladoInvalido(Exception):
    """El archivo no es un PDF legible, no tiene texto o no trae el encabezado
    o los renglones esperados -- se traduce a 422 en el router."""


# ---------------------------------------------------------------------------
# Extraccion de texto
# ---------------------------------------------------------------------------


def _texto_de_pagina(pagina) -> str:
    try:
        return pagina.extract_text(extraction_mode="layout") or ""
    except KeyError:
        # Pagina sin contenido (pypdf lanza KeyError '/Contents'): cuenta como vacia.
        return ""


def extraer_texto_pdf(contenido: bytes) -> str:
    """Texto de todas las paginas, en modo layout. Lanza PdfTrasladoInvalido si
    no es un PDF, esta protegido o no tiene texto (por ejemplo un escaneo)."""
    if not contenido.startswith(b"%PDF-"):
        raise PdfTrasladoInvalido("El archivo no es un PDF válido")
    try:
        lector = PdfReader(io.BytesIO(contenido))
        if lector.is_encrypted:
            raise PdfTrasladoInvalido("El PDF está protegido con contraseña")
        if len(lector.pages) > MAX_PAGINAS:
            raise PdfTrasladoInvalido(f"El PDF tiene más de {MAX_PAGINAS} páginas")
        paginas = [_texto_de_pagina(pagina) for pagina in lector.pages]
    except PdfTrasladoInvalido:
        raise
    except (PyPdfError, ValueError, KeyError, OSError, RecursionError) as exc:
        raise PdfTrasladoInvalido("No se pudo leer el PDF") from exc
    texto = "\n".join(paginas)
    if not texto.strip():
        raise PdfTrasladoInvalido(
            "El PDF no tiene texto legible (¿es un escaneo?). Sube el PDF original del sistema contable"
        )
    return texto


# ---------------------------------------------------------------------------
# Parseo del texto
# ---------------------------------------------------------------------------

_MESES = {
    "jan": 1, "ene": 1, "feb": 2, "mar": 3, "apr": 4, "abr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "ago": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12, "dic": 12,
}  # fmt: skip

_ENCABEZADO_TABLA = re.compile(r"^\s*Referencia\b.*\bPrecio\b")
_INICIO_PIE = re.compile(r"^\s*Bodega:")
# El numero sale con espacios intercalados en el PDF ("N PT - 1839").
_NUMERO = re.compile(r"\b([A-Z](?:\s?[A-Z]){1,3})\s*-\s*(\d{1,7})(?![\d-])")
_FECHA = re.compile(r"\b([A-Za-z]{3})-(\d{2})-(\d{4})\b")
_ITEM = re.compile(r"^\s*([0-9A-Za-z\-]+)\s+(.+?)\s+(\d+\.\d{1,2})\s+([\d,]*\d\.\d{1,2})\s*$")
_TOTAL = re.compile(r"Totales\s+([\d,]*\d(?:\.\d+)?)")


def _numero(valor: float) -> int | float:
    return int(valor) if float(valor).is_integer() else float(valor)


def _formato(valor: int | float) -> str:
    return str(int(valor)) if float(valor).is_integer() else str(valor)


def _primer_grupo(patron: str, lineas: list[str]) -> str | None:
    for linea in lineas:
        coincidencia = re.search(patron, linea)
        if coincidencia:
            return coincidencia.group(1).strip() or None
    return None


def _leer_fecha(lineas: list[str]) -> str | None:
    for linea in lineas:
        for mes, dia, anio in _FECHA.findall(linea):
            numero_mes = _MESES.get(mes.lower())
            if numero_mes is None:
                continue
            try:
                return date(int(anio), numero_mes, int(dia)).isoformat()
            except ValueError:
                continue
    return None


def _leer_elaboro(lineas: list[str]) -> str | None:
    for i, linea in enumerate(lineas):
        if "Elabor" in linea:
            for siguiente in lineas[i + 1 :]:
                if siguiente.strip():
                    return re.split(r"\s{2,}", siguiente.strip())[0]
            return None
    return None


def _separar_empaque(descripcion: str) -> tuple[str, str]:
    """El empaque es la ultima palabra antes de la cantidad; el detalle puede
    repetir esa misma palabra ("... X LIBRA LIBRA")."""
    palabras = descripcion.split()
    if len(palabras) < 2:
        return descripcion.strip(), ""
    return " ".join(palabras[:-1]), palabras[-1]


def parsear_traslado_bodega(texto: str) -> dict:
    """Borrador del traslado a partir del texto del PDF: `numero` ("NPT-1839"),
    `fecha` (ISO), `concepto`, `origen`, `destino_texto`, `elaboro`,
    `total_documento`, `items` ({referencia, detalle, empaque, cantidad,
    precio}) y `advertencias` (lo que no se pudo leer o no cuadra). Lanza
    PdfTrasladoInvalido si no hay numero de traslado o ningun renglon."""
    lineas = texto.splitlines()
    indice_tabla = next((i for i, linea in enumerate(lineas) if _ENCABEZADO_TABLA.match(linea)), None)
    if indice_tabla is None:
        raise PdfTrasladoInvalido("No se encontró la tabla de productos del traslado. ¿Es el PDF correcto?")
    encabezado = lineas[:indice_tabla]
    resto = lineas[indice_tabla + 1 :]
    indice_pie = next((i for i, linea in enumerate(resto) if _INICIO_PIE.match(linea)), len(resto))
    cuerpo, pie = resto[:indice_pie], resto[indice_pie:]

    advertencias: list[str] = []

    numero = None
    for linea in encabezado:
        coincidencia = _NUMERO.search(linea)
        if coincidencia:
            prefijo = re.sub(r"\s+", "", coincidencia.group(1))
            try:
                numero = normalizar_numero_syscafe(f"{prefijo}-{coincidencia.group(2)}")
            except ValueError:
                numero = None
            break
    if numero is None:
        raise PdfTrasladoInvalido("No se encontró el número del traslado (ej. NPT-1839) en el PDF")

    fecha = _leer_fecha(encabezado)
    if fecha is None:
        advertencias.append("No se pudo leer la fecha del traslado")
    concepto = _primer_grupo(r"Concepto\s+(.*?)(?:\s{2,}|$)", encabezado)

    items: list[dict] = []
    for linea in cuerpo:
        if not linea.strip() or _ENCABEZADO_TABLA.match(linea):
            continue
        coincidencia = _ITEM.match(linea)
        if coincidencia:
            referencia, descripcion, cantidad, precio = coincidencia.groups()
            detalle, empaque = _separar_empaque(descripcion)
            items.append(
                {
                    "referencia": referencia,
                    "detalle": detalle,
                    "empaque": empaque,
                    "cantidad": _numero(float(cantidad)),
                    "precio": float(precio.replace(",", "")),
                }
            )
        elif re.match(r"\s*\d", linea):
            # Parece un renglon (empieza por la referencia) pero no se pudo leer.
            advertencias.append(f"No se pudo leer el renglón: {' '.join(linea.split())}")

    if not items:
        raise PdfTrasladoInvalido("No se encontraron productos en el PDF")

    origen = _primer_grupo(r"Bodega:\s+(.+?)(?:\s{2,}|$)", pie)
    destino_texto = _primer_grupo(r"Destino:\s+(.+?)\s*$", pie)
    if not destino_texto:
        advertencias.append("No se pudo leer la bodega de destino")

    total_documento = None
    for linea in pie:
        coincidencia = _TOTAL.search(linea)
        if coincidencia:
            total_documento = _numero(float(coincidencia.group(1).replace(",", "")))
            break
    suma = sum(i["cantidad"] for i in items)
    if total_documento is None:
        advertencias.append("No se encontró el total del documento: no se pudo validar la suma de cantidades")
    elif suma != total_documento:
        advertencias.append(
            f"La suma de las cantidades ({_formato(suma)}) no coincide con el total del documento "
            f"({_formato(total_documento)}). Revisa los renglones"
        )

    return {
        "numero": numero,
        "fecha": fecha,
        "concepto": concepto,
        "origen": origen,
        "destino_texto": destino_texto,
        "elaboro": _leer_elaboro(pie),
        "total_documento": total_documento,
        "items": items,
        "advertencias": advertencias,
    }


# ---------------------------------------------------------------------------
# Punto de destino sugerido
# ---------------------------------------------------------------------------


def _clave(texto: str) -> str:
    """Minusculas, sin tildes, espacios colapsados y sin el "bodega" inicial."""
    sin_tildes = "".join(c for c in unicodedata.normalize("NFD", texto or "") if unicodedata.category(c) != "Mn")
    limpio = re.sub(r"\s+", " ", sin_tildes.replace("—", "-").replace("–", "-")).strip().lower()
    return re.sub(r"^bodega\s+", "", limpio)


def _variantes_punto(punto: dict) -> set[str]:
    """Nombre completo y nombre sin el prefijo "CODIGO — " del punto."""
    variantes = {_clave(punto["nombre"])}
    codigo = _clave(punto.get("codigo") or "")
    prefijo, separador, resto = punto["nombre"].partition("—")
    if not separador:
        prefijo, separador, resto = punto["nombre"].partition("-")
    if separador and (not codigo or _clave(prefijo) == codigo):
        variantes.add(_clave(resto))
    return {v for v in variantes if v}


def sugerir_punto(destino_texto: str | None, puntos: list[dict]) -> dict | None:
    """Punto cuyo nombre coincide con el destino leido ("BODEGA PUENTE DE
    TIERRA"), ignorando tildes, mayusculas, el "bodega" inicial y el codigo del
    punto. Primero coincidencia exacta y, si no hay, por contenido; solo se
    devuelve si el candidato es unico."""
    buscado = _clave(destino_texto or "")
    if not buscado:
        return None
    exactos = [p for p in puntos if buscado in _variantes_punto(p)]
    if len(exactos) == 1:
        return exactos[0]
    if exactos:
        return None
    parciales = [
        p
        for p in puntos
        if any(len(v) >= 4 and (v in buscado or buscado in v) for v in _variantes_punto(p))
    ]
    return parciales[0] if len(parciales) == 1 else None
