"""Reglas puras del modulo Traslados (sin base de datos ni red): excepciones de
dominio, autorizacion por accion y estado, resolucion de puntos a partir del
texto del PDF, plan de comprobantes y deteccion de la imagen de firma.

Estados de un comprobante:

    pendiente --confirmar--> confirmado --devolver (encargada/admin)--> devuelto
    pendiente --devolver---> devuelto  --reenviar (encargada/admin)--> pendiente

Salida e ingreso son independientes: ninguna regla depende del orden entre ellos.
"""

import re
import unicodedata
from dataclasses import dataclass

from app.models.traslado import TIPOS_COMPROBANTE
from app.models.traslado_punto import normalizar_numero_syscafe
from app.services.pdf_traslado_bodega import sugerir_punto
from app.services.traslados_bodega import MAX_BYTES_PDF

__all__ = ["MAX_BYTES_PDF", "MAX_BYTES_FIRMA", "MAX_ARCHIVOS_POR_PETICION", "TIPOS_COMPROBANTE"]

MAX_BYTES_FIRMA = 2 * 1024 * 1024
MAX_ARCHIVOS_POR_PETICION = 20

# Advertencias que bloquean el envio. Son textos fijos a proposito: al editar un
# borrador se recalculan y se reemplazan sin tocar las demas (las del parser).
MSG_SIN_NUMERO = "No se pudo determinar el número del traslado. Escríbelo manualmente"
MSG_SIN_ORIGEN = "No se pudo determinar el punto de origen. Elígelo manualmente"
MSG_SIN_DESTINO = "No se pudo determinar el punto de destino. Elígelo manualmente"
MSG_MISMO_PUNTO = "El origen y el destino son el mismo punto. Corrige uno de los dos"
MSG_AMBOS_INTERNOS = "El origen y el destino son bodegas internas: no hay comprobantes que generar"
_BLOQUEANTES = {MSG_SIN_NUMERO, MSG_SIN_ORIGEN, MSG_SIN_DESTINO, MSG_MISMO_PUNTO, MSG_AMBOS_INTERNOS}


class TrasladoNoEncontrado(Exception):
    """No existe, o el usuario no tiene alcance sobre el (404: no se revela cual)."""


class SinPermiso(Exception):
    """El perfil no puede hacer esta accion (403)."""


class EstadoNoPermitido(Exception):
    """El estado actual no admite la accion o alguien se adelanto (409)."""


class DatoInvalido(Exception):
    """Dato de entrada que no sirve (422)."""


class NoSePuedeEnviar(DatoInvalido):
    """El borrador aun no esta completo; `advertencias` dice que falta (422)."""

    def __init__(self, advertencias: list[str]) -> None:
        super().__init__("No se puede enviar: " + "; ".join(advertencias))
        self.advertencias = advertencias


class ComprobanteDuplicado(Exception):
    """Ya existe un comprobante con ese (numero, punto, tipo) (409)."""

    def __init__(self, mensaje: str, comprobante_id: str | None = None) -> None:
        super().__init__(mensaje)
        self.comprobante_id = comprobante_id


# --------------------------- autorizacion ---------------------------


def autorizar_accion(perfil, accion: str, comprobante: dict) -> None:
    """Valida que `perfil` pueda hacer `accion` ('confirmar', 'devolver' o
    'reenviar') sobre el comprobante (dict con estado y punto_id).

    Orden: alcance (404) -> permiso (403) -> estado (409). El permiso va antes
    que el estado para no revelar a quien no le toca el estado del comprobante."""
    if accion not in ("confirmar", "devolver", "reenviar"):
        raise ValueError(f"Accion desconocida: {accion}")
    if not perfil.ve(comprobante["punto_id"]):
        raise TrasladoNoEncontrado("Comprobante no encontrado")
    estado = comprobante["estado"]
    es_dueno = perfil.tipo == "admin" or perfil.tipo == "punto"  # el alcance ya se valido arriba

    if accion == "confirmar":
        if not es_dueno:
            raise SinPermiso("Solo el punto de este comprobante puede confirmarlo")
        if estado != "pendiente":
            raise EstadoNoPermitido(f"El comprobante ya está {estado}: solo se puede confirmar uno pendiente")
    elif accion == "devolver":
        if estado == "confirmado":
            if not perfil.gestiona:
                raise SinPermiso("Solo la encargada puede devolver un comprobante ya confirmado")
        elif not (es_dueno or (estado == "devuelto" and perfil.gestiona)):
            raise SinPermiso("Solo el punto de este comprobante puede devolverlo")
        if estado == "devuelto":
            raise EstadoNoPermitido("El comprobante ya está devuelto")
    else:  # reenviar
        if not perfil.gestiona:
            raise SinPermiso("Solo la encargada puede reenviar un comprobante devuelto")
        if estado != "devuelto":
            raise EstadoNoPermitido(f"El comprobante está {estado}: solo se puede reenviar uno devuelto")


# --------------------------- numero ---------------------------


def normalizar_numero(valor: str | None) -> str | None:
    """Numero en formato "CODIGO-NUMERO" (ver normalizar_numero_syscafe); vacio
    devuelve None y un valor que no es un numero valido lanza DatoInvalido."""
    try:
        return normalizar_numero_syscafe(valor)
    except ValueError as exc:
        raise DatoInvalido(str(exc)) from exc


# --------------------------- puntos ---------------------------


def _texto_plano(texto: str) -> str:
    sin_tildes = "".join(c for c in unicodedata.normalize("NFD", texto or "") if unicodedata.category(c) != "Mn")
    limpio = re.sub(r"\s+", " ", sin_tildes.replace("—", "-").replace("–", "-")).strip().lower()
    return re.sub(r"^bodega\s+", "", limpio)


def resolver_punto(texto: str | None, puntos: list[dict]) -> dict | None:
    """Punto al que corresponde el texto leido del PDF ("Bodega:" o "Destino:").

    Primero por CODIGO (el texto entero o su primera palabra, ej. "TB9 - X") y
    solo si no hay codigo, por nombre con sugerir_punto. Devuelve None si no
    hay candidato o si hay mas de uno: nunca se adivina."""
    buscado = _texto_plano(texto or "")
    if not buscado:
        return None
    candidatos = {buscado, re.split(r"[\s-]+", buscado, maxsplit=1)[0]}
    por_codigo = [p for p in puntos if p.get("codigo") and p["codigo"].strip().lower() in candidatos]
    if len(por_codigo) == 1:
        return por_codigo[0]
    if por_codigo:
        return None
    return sugerir_punto(texto, puntos)


# --------------------------- plan de comprobantes ---------------------------


@dataclass(frozen=True)
class PlanComprobante:
    tipo: str
    punto_id: str


@dataclass(frozen=True)
class Evaluacion:
    comprobantes: list[PlanComprobante]
    bloqueantes: list[str]


def evaluar_traslado(numero: str | None, origen: dict | None, destino: dict | None) -> Evaluacion:
    """Que comprobantes genera un traslado y que impide enviarlo.

    Un lado interno (es_interna) no genera comprobante. Si algo bloquea, no se
    planifica ninguno: el traslado queda en borrador hasta completarlo."""
    bloqueantes: list[str] = []
    if not numero:
        bloqueantes.append(MSG_SIN_NUMERO)
    if origen is None:
        bloqueantes.append(MSG_SIN_ORIGEN)
    if destino is None:
        bloqueantes.append(MSG_SIN_DESTINO)
    if origen is not None and destino is not None:
        if str(origen["id"]) == str(destino["id"]):
            bloqueantes.append(MSG_MISMO_PUNTO)
        elif origen.get("es_interna") and destino.get("es_interna"):
            bloqueantes.append(MSG_AMBOS_INTERNOS)
    if bloqueantes:
        return Evaluacion([], bloqueantes)
    plan = []
    if not origen.get("es_interna"):
        plan.append(PlanComprobante("salida", str(origen["id"])))
    if not destino.get("es_interna"):
        plan.append(PlanComprobante("ingreso", str(destino["id"])))
    return Evaluacion(plan, [])


def fusionar_advertencias(previas: list[str], bloqueantes: list[str]) -> list[str]:
    """Quita de `previas` las advertencias bloqueantes y agrega las nuevas; las
    demas (las que dejo el parser del PDF) se conservan."""
    return [a for a in previas if a not in _BLOQUEANTES] + list(bloqueantes)


# --------------------------- imagen de firma ---------------------------


def detectar_imagen(contenido: bytes) -> tuple[str, str] | None:
    """(extension, content-type) segun los primeros bytes (PNG, JPEG o WebP);
    None si no es una de esas imagenes. No se confia en el content-type del cliente."""
    if contenido.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if contenido.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if contenido[:4] == b"RIFF" and contenido[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None
