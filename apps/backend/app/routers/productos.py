"""Catalogo codigo -> nombre de producto, auto-completado a medida que se
procesan/corrigen facturas (ver app/services/productos.py). El alta y la
correccion manual de aca son para completar/arreglar a mano lo que la
extraccion automatica no pudo resolver.
"""

from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app.db import get_pool
from app.models.producto import ProductoActualizar, ProductoCreate
from app.services import productos as servicio_productos
from app.services.permisos_dashboard import requiere_supervisor_area
from app.services.usuarios import RegistroNoEncontrado

router = APIRouter(prefix="/productos", tags=["productos"])


def _con_id(row: dict) -> dict:
    row = dict(row)
    row["id"] = str(row["id"])
    return row


@router.get("")
async def listar_productos(buscar: str | None = None) -> list[dict]:
    pool = await get_pool()
    if buscar:
        rows = await pool.fetch(
            "select * from productos where codigo ilike $1 or nombre ilike $1 order by codigo",
            f"%{buscar}%",
        )
    else:
        rows = await pool.fetch("select * from productos order by codigo")
    return [_con_id(row) for row in rows]


@router.post("", status_code=201, dependencies=[Depends(requiere_supervisor_area("todo", "bodega"))])
async def crear_producto(producto: ProductoCreate) -> dict:
    pool = await get_pool()
    try:
        row = await pool.fetchrow(
            "insert into productos (codigo, nombre) values ($1, $2) returning *",
            producto.codigo,
            producto.nombre,
        )
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="Ya existe un producto con ese código.") from exc
    return _con_id(row)


@router.patch("/{producto_id}", dependencies=[Depends(requiere_supervisor_area("todo", "bodega"))])
async def actualizar_producto(producto_id: UUID, cambios: ProductoActualizar) -> dict:
    codigo = cambios.codigo.strip() if cambios.codigo is not None else None
    nombre = cambios.nombre.strip() if cambios.nombre is not None else None
    if codigo == "" or nombre == "":
        raise HTTPException(status_code=422, detail="El código y el nombre no pueden quedar vacíos.")
    if codigo is None and nombre is None:
        raise HTTPException(status_code=422, detail="No hay cambios para guardar.")

    pool = await get_pool()
    try:
        row = await pool.fetchrow(
            """
            update productos
            set codigo = coalesce($2, codigo), nombre = coalesce($3, nombre)
            where id = $1::uuid
            returning *
            """,
            str(producto_id),
            codigo,
            nombre,
        )
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="Ya existe un producto con ese código.") from exc
    if row is None:
        raise HTTPException(status_code=404, detail="Producto no encontrado.")
    return _con_id(row)


@router.delete("/{producto_id}", dependencies=[Depends(requiere_supervisor_area("todo", "bodega"))])
async def eliminar_producto(producto_id: UUID) -> dict:
    """Quita el producto del catalogo (sin historial que proteger: no hay FKs).
    Si una entrega futura trae el mismo codigo, se vuelve a crear solo."""
    try:
        await servicio_productos.eliminar_producto(str(producto_id))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Producto no encontrado.") from exc
    return {"ok": True}
