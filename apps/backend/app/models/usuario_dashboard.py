import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

RolDashboard = Literal["admin", "supervisor", "consulta"]
AreaDashboard = Literal["todo", "bodega", "traslados"]

PASSWORD_MIN = 8
PASSWORD_MAX = 200

_PATRON_USUARIO = re.compile(r"^[a-z0-9._@-]{3,50}$")


def normalizar_usuario(valor: str) -> str:
    return valor.strip().lower()


def _usuario_valido(valor: str) -> str:
    valor = normalizar_usuario(valor)
    if not _PATRON_USUARIO.match(valor):
        raise ValueError("El usuario debe tener entre 3 y 50 caracteres (letras, números, punto, guion o @)")
    return valor


def normalizar_cedula(valor: str | None) -> str | None:
    """Cedula solo con digitos (acepta puntos y espacios al escribirla); vacia
    cuenta como "sin cedula". Se guarda como texto: no se hacen cuentas con ella."""
    if valor is None:
        return None
    limpia = re.sub(r"[.\s]", "", valor)
    if not limpia:
        return None
    if not re.fullmatch(r"\d{5,15}", limpia):
        raise ValueError("La cédula debe tener entre 5 y 15 dígitos")
    return limpia


def _punto_valido(valor: str | None) -> str | None:
    if valor is None:
        return None
    try:
        return str(UUID(valor))
    except ValueError:
        raise ValueError("El punto no es válido") from None


class LoginRequest(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=PASSWORD_MAX)


class CambiarPasswordRequest(BaseModel):
    actual: str = Field(min_length=1, max_length=PASSWORD_MAX)
    nueva: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


class UsuarioDashboardCrear(BaseModel):
    usuario: str
    nombre: str = Field(min_length=1, max_length=100)
    rol: RolDashboard
    area: AreaDashboard = "todo"
    # Solo area "traslados": con punto el usuario ve y resuelve los comprobantes
    # de ese punto; sin punto es la encargada (ve todos). La cedula la firma el
    # usuario al confirmar o devolver un comprobante (ver app/services/traslados.py).
    punto_id: str | None = None
    cedula: str | None = None
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)

    @field_validator("punto_id")
    @classmethod
    def _punto(cls, v: str | None) -> str | None:
        return _punto_valido(v)

    @field_validator("cedula")
    @classmethod
    def _cedula(cls, v: str | None) -> str | None:
        return normalizar_cedula(v)

    @field_validator("usuario")
    @classmethod
    def _usuario(cls, v: str) -> str:
        return _usuario_valido(v)

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("El nombre no puede quedar vacío")
        return v


class UsuarioDashboardActualizar(BaseModel):
    """Solo se actualiza lo que viene."""

    nombre: str | None = Field(default=None, min_length=1, max_length=100)
    rol: RolDashboard | None = None
    area: AreaDashboard | None = None
    activo: bool | None = None
    # A diferencia del resto, aqui un null EXPLICITO quita el valor (el router
    # distingue "no enviado" de null con model_fields_set).
    punto_id: str | None = None
    cedula: str | None = None

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("El nombre no puede quedar vacío")
        return v

    @field_validator("punto_id")
    @classmethod
    def _punto(cls, v: str | None) -> str | None:
        return _punto_valido(v)

    @field_validator("cedula")
    @classmethod
    def _cedula(cls, v: str | None) -> str | None:
        return normalizar_cedula(v)


class PasswordNueva(BaseModel):
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)
