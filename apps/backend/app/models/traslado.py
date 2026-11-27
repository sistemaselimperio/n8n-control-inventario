"""Modelos del modulo Traslados (comprobantes de salida e ingreso entre
puntos): constantes de estado y cuerpos de entrada. El esquema esta en
app/db.py y la logica en app/services/traslados.py."""

from datetime import date
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

# Deben coincidir con los check de traslados / traslado_comprobantes en
# app/db.py (hay un test que lo vigila).
TIPOS_COMPROBANTE = ("salida", "ingreso")
ESTADOS_COMPROBANTE = ("pendiente", "confirmado", "devuelto")
ESTADOS_TRASLADO = ("borrador", "enviado")

MAX_MOTIVO = 500
MAX_OBSERVACION = 500


def _uuid_o_none(valor: str | None) -> str | None:
    if valor is None:
        return None
    try:
        return str(UUID(valor))
    except ValueError:
        raise ValueError("El identificador del punto no es válido") from None


class TrasladoEditar(BaseModel):
    """Completa o corrige un traslado en borrador. Solo se aplica lo que viene;
    un null EXPLICITO borra el valor (se distingue con model_fields_set)."""

    numero: str | None = None
    origen_punto_id: str | None = None
    destino_punto_id: str | None = None
    fecha: date | None = None
    concepto: str | None = Field(default=None, max_length=300)

    @field_validator("origen_punto_id", "destino_punto_id")
    @classmethod
    def _punto(cls, v: str | None) -> str | None:
        return _uuid_o_none(v)


def _texto_o_none(valor: str | None) -> str | None:
    valor = (valor or "").strip()
    return valor or None


def receptor_id_valido(valor: str | None) -> str | None:
    """UUID del receptor o None si no se indico; ValueError si no es un UUID."""
    valor = _texto_o_none(valor)
    if valor is None:
        return None
    try:
        return str(UUID(valor))
    except ValueError:
        raise ValueError("El identificador del receptor no es válido") from None


class DevolverRequest(BaseModel):
    """Motivo y, para un comprobante pendiente, quien recibe: `receptor_id` (de
    la lista del punto) o `receptor_nombre` + `receptor_cedula` (otra persona).
    Que sea exactamente uno de los dos lo valida el servicio."""

    motivo: str = Field(min_length=1, max_length=MAX_MOTIVO)
    receptor_id: str | None = None
    receptor_nombre: str | None = Field(default=None, max_length=200)
    receptor_cedula: str | None = Field(default=None, max_length=50)

    @field_validator("receptor_id")
    @classmethod
    def _receptor_id(cls, v: str | None) -> str | None:
        return receptor_id_valido(v)

    @field_validator("receptor_nombre", "receptor_cedula")
    @classmethod
    def _receptor_texto(cls, v: str | None) -> str | None:
        return _texto_o_none(v)

    @field_validator("motivo")
    @classmethod
    def _motivo(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("El motivo no puede quedar vacío")
        return v
