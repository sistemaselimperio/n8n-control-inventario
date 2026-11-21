"""Puntos (bodegas del flujo de traslados) y sus usuarios -- lista DISTINTA de
sedes/empleados de Despachos (ver el plan "traslados-entre-puntos" y
app/models/traslado_punto.py). Mismo mecanismo de login por PIN que empleados
(ver app/services/auth_pin.py), reusando la misma validacion de formato de PIN.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator

from app.models.empleado import _validar_pin


# Otros nombres con los que el sistema contable escribe el punto (ver
# app/services/puntos_alias.py). El recorte y la validacion contra otros
# puntos los hace el servicio.
NombreAlterno = Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)]
ListaAlias = Annotated[list[NombreAlterno], Field(max_length=20)]


class PuntoCrear(BaseModel):
    nombre: str
    alias: ListaAlias = Field(default_factory=list)


class UsuarioPuntoCrear(BaseModel):
    nombre: str
    pin: str

    @field_validator("pin")
    @classmethod
    def _pin_valido(cls, v: str) -> str:
        return _validar_pin(v)


class PinLoginPunto(BaseModel):
    """Payload de POST /puntos/auth/pin -- el usuario de punto ya se eligio en
    el paso anterior (mismo patron que PinLogin de empleados), el PIN solo
    confirma esa identidad puntual."""

    pin: str
    usuario_id: str

    @field_validator("pin")
    @classmethod
    def _pin_valido(cls, v: str) -> str:
        return _validar_pin(v)


class PuntoActualizar(BaseModel):
    nombre: str | None = None
    activo: bool | None = None
    # Bodega propia (TB8, TB9...): en el modulo de traslados no genera comprobantes.
    es_interna: bool | None = None
    # None = no tocar; lista vacia = quitar todos los otros nombres.
    alias: ListaAlias | None = None


class UsuarioPuntoActualizar(BaseModel):
    nombre: str | None = None
    estado: Literal["activo", "inactivo"] | None = None
