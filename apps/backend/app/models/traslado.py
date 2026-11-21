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


class DevolverRequest(BaseModel):
    motivo: str = Field(min_length=1, max_length=MAX_MOTIVO)

    @field_validator("motivo")
    @classmethod
    def _motivo(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("El motivo no puede quedar vacío")
        return v
