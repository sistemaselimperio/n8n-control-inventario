"""Perfil de un usuario del dashboard dentro del modulo Traslados y las
dependencias de FastAPI que lo exigen. Solo se acepta sesion (Authorization:
Bearer): el modulo es nuevo y no admite el token legacy X-Admin-Token.

Perfiles (se deducen de rol + area + punto del usuario, leidos de la base en
cada peticion, ver permisos_dashboard._usuario_desde_header):

- admin: todo, en cualquier punto.
- encargada: supervisor del area "traslados" SIN punto. Ve todos los puntos;
  sube, completa, envia, corrige, reenvia, devuelve confirmados y borra.
- punto: supervisor del area "traslados" CON punto. Solo ve los comprobantes
  de su punto y los confirma o devuelve (cuando estan pendientes).
- lectura: consulta del area "traslados" (limitada a su punto si tiene uno) y
  supervisor/consulta del area "todo" (ven todo). Nunca escriben.
- Cualquier usuario del area "bodega" no entra al modulo (403).
"""

from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, HTTPException

from app.services.permisos_dashboard import actor_actual, usuario_dashboard

_MSG_SIN_PERMISO = "No tienes permiso para esta acción"

TipoPerfil = Literal["admin", "encargada", "punto", "lectura"]


@dataclass(frozen=True)
class PerfilTraslados:
    tipo: TipoPerfil
    usuario: dict
    # Punto al que esta limitado (None = ve todos los puntos).
    punto_id: str | None = None

    @property
    def actor(self) -> str:
        """Texto para logs, mismo formato que el resto del dashboard."""
        return f"dashboard:{self.usuario['usuario']}"

    @property
    def gestiona(self) -> bool:
        """Admin o encargada: pueden subir, completar, enviar, corregir y borrar."""
        return self.tipo in ("admin", "encargada")

    def ve(self, punto_id: str | None) -> bool:
        return self.punto_id is None or str(punto_id) == self.punto_id


def perfil_de(usuario: dict) -> PerfilTraslados | None:
    """Perfil del usuario de la sesion, o None si no tiene acceso al modulo."""
    rol = usuario["rol"]
    if rol == "admin":
        return PerfilTraslados("admin", usuario)
    area = usuario.get("area") or "todo"
    if area == "todo":
        # Supervisor o consulta de area "todo": lectura completa, nunca escritura.
        return PerfilTraslados("lectura", usuario)
    if area != "traslados":
        return None
    punto_id = usuario.get("punto_id")
    if rol == "supervisor":
        return PerfilTraslados("punto" if punto_id else "encargada", usuario, punto_id or None)
    return PerfilTraslados("lectura", usuario, punto_id or None)


async def perfil_traslados(usuario: dict = Depends(usuario_dashboard)) -> PerfilTraslados:
    """Cualquier perfil con acceso al modulo (401 sin sesion, 403 sin acceso)."""
    perfil = perfil_de(usuario)
    if perfil is None:
        raise HTTPException(status_code=403, detail=_MSG_SIN_PERMISO)
    actor_actual.set(perfil.actor)
    return perfil


async def requiere_gestion_traslados(perfil: PerfilTraslados = Depends(perfil_traslados)) -> PerfilTraslados:
    """Solo admin o encargada."""
    if not perfil.gestiona:
        raise HTTPException(status_code=403, detail=_MSG_SIN_PERMISO)
    return perfil


async def requiere_escritura_traslados(perfil: PerfilTraslados = Depends(perfil_traslados)) -> PerfilTraslados:
    """Cualquier perfil que pueda escribir (admin, encargada, punto): quedan
    fuera los de solo lectura. Que accion puede hacer cada uno sobre un
    comprobante concreto lo decide traslados_reglas.autorizar_accion."""
    if perfil.tipo == "lectura":
        raise HTTPException(status_code=403, detail=_MSG_SIN_PERMISO)
    return perfil


__all__ = [
    "PerfilTraslados",
    "perfil_de",
    "perfil_traslados",
    "requiere_escritura_traslados",
    "requiere_gestion_traslados",
]
