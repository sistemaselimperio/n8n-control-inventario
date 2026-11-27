"""Administracion de los receptores por punto desde /creador (ver
app/services/receptores_punto.py). Todo exige sesion admin (o X-Admin-Token
legacy): la lista incluye cedulas. La lectura que usa el modal de cada punto
esta en /traslados/puntos/{punto_id}/receptores.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.models.receptor_punto import ReceptorActualizar, ReceptorCrear
from app.services import receptores_punto as servicio
from app.services.permisos_dashboard import requiere_admin
from app.services.usuarios import DatoInvalido, RegistroNoEncontrado

router = APIRouter(prefix="/receptores-punto", tags=["receptores-punto"], dependencies=[Depends(requiere_admin)])

_NO_ENCONTRADO = "Receptor no encontrado"


@router.get("")
async def listar_receptores(punto_id: UUID | None = None, incluir_inactivos: bool = False) -> list[dict]:
    """Receptores (con `punto_nombre`), por punto y nombre. Sin
    incluir_inactivos=true solo los activos."""
    return await servicio.listar(
        punto_id=None if punto_id is None else str(punto_id), incluir_inactivos=incluir_inactivos
    )


@router.post("", status_code=201)
async def crear_receptor(payload: ReceptorCrear) -> dict:
    try:
        return await servicio.crear(payload)
    except DatoInvalido as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.patch("/{receptor_id}")
async def actualizar_receptor(receptor_id: UUID, payload: ReceptorActualizar) -> dict:
    try:
        return await servicio.actualizar(str(receptor_id), payload)
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail=_NO_ENCONTRADO) from exc
    except DatoInvalido as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/{receptor_id}")
async def eliminar_receptor(receptor_id: UUID) -> dict:
    """Borrado definitivo: los comprobantes ya firmados conservan el nombre y
    la cedula del receptor (copiados al confirmar)."""
    try:
        await servicio.eliminar(str(receptor_id))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail=_NO_ENCONTRADO) from exc
    return {"ok": True}
