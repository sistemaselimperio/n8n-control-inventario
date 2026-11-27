"""Receptores por punto: las personas que reciben traslados en cada punto (ver
app/services/receptores_punto.py). Cada punto entra al dashboard con UN usuario
compartido, asi que al confirmar o devolver se elige quien recibe de esta lista
(o se escribe a mano una "otra persona", que no se agrega a la lista)."""

import re
from uuid import UUID

from pydantic import BaseModel, field_validator

MAX_NOMBRE = 120
MIN_DIGITOS_CEDULA = 5
MAX_DIGITOS_CEDULA = 15


def normalizar_cedula(valor: str | None) -> str:
    """Solo digitos: quita puntos, espacios y guiones. Lanza ValueError si queda
    vacia, con otros caracteres o fuera de 5 a 15 digitos."""
    limpia = re.sub(r"[.\s-]", "", valor or "")
    if not limpia.isascii() or not limpia.isdigit():
        raise ValueError("La cédula debe tener solo números")
    if not MIN_DIGITOS_CEDULA <= len(limpia) <= MAX_DIGITOS_CEDULA:
        raise ValueError(f"La cédula debe tener entre {MIN_DIGITOS_CEDULA} y {MAX_DIGITOS_CEDULA} dígitos")
    return limpia


def normalizar_nombre(valor: str | None) -> str:
    """Recorta, colapsa espacios y exige de 1 a 120 caracteres (ValueError si no)."""
    limpio = re.sub(r"\s+", " ", valor or "").strip()
    if not limpio:
        raise ValueError("El nombre no puede quedar vacío")
    if len(limpio) > MAX_NOMBRE:
        raise ValueError(f"El nombre no puede superar los {MAX_NOMBRE} caracteres")
    return limpio


def _uuid(valor: str) -> str:
    try:
        return str(UUID(valor))
    except ValueError:
        raise ValueError("El identificador del punto no es válido") from None


class ReceptorCrear(BaseModel):
    punto_id: str
    nombre: str
    cedula: str

    @field_validator("punto_id")
    @classmethod
    def _punto(cls, v: str) -> str:
        return _uuid(v)

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, v: str) -> str:
        return normalizar_nombre(v)

    @field_validator("cedula")
    @classmethod
    def _cedula(cls, v: str) -> str:
        return normalizar_cedula(v)


class ReceptorActualizar(BaseModel):
    """Solo se aplica lo que viene (se distingue con model_fields_set)."""

    punto_id: str | None = None
    nombre: str | None = None
    cedula: str | None = None
    activo: bool | None = None

    @field_validator("punto_id")
    @classmethod
    def _punto(cls, v: str | None) -> str | None:
        return None if v is None else _uuid(v)

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, v: str | None) -> str | None:
        return None if v is None else normalizar_nombre(v)

    @field_validator("cedula")
    @classmethod
    def _cedula(cls, v: str | None) -> str | None:
        return None if v is None else normalizar_cedula(v)
