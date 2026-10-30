"""Consulta de la tabla de auditoria (append-only). Ver Figura 1: cada paso
del pipeline escribe aqui; este router solo expone lectura para el
dashboard de trazabilidad.
"""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.db import get_pool
from app.services.permisos_dashboard import usuario_dashboard_opcional

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("")
async def listar_logs(
    entidad_id: str | None = None,
    sede_id: str | None = None,
    # Acotado: un LIMIT negativo hace fallar a Postgres (HTTP 500) y, sin tope, un
    # pedido anonimo con entidad_id podia pedir millones de filas. Los clientes
    # (dashboard y movil) piden 150 o 200.
    limit: int = Query(100, ge=1, le=1000),
    usuario: dict | None = Depends(usuario_dashboard_opcional),
) -> list[dict]:
    # Sin sesion del dashboard solo se puede pedir el historial de UNA entidad
    # (lo usa la app movil, que no tiene sesion de dashboard). El listado
    # completo de auditoria exige sesion.
    if usuario is None and not entidad_id:
        raise HTTPException(status_code=401, detail="Inicia sesión")
    pool = await get_pool()
    condiciones = []
    valores: list = []

    if entidad_id:
        valores.append(entidad_id)
        condiciones.append(f"l.entidad_id = ${len(valores)}")
    if sede_id:
        valores.append(sede_id)
        condiciones.append(f"l.sede_id = ${len(valores)}")

    where = f"where {' and '.join(condiciones)}" if condiciones else ""
    valores.append(limit)

    # actor_nombre -- mismo patron que operador_nombre/bodeguero_nombre en
    # _SELECT_ENTREGAS_BASE (routers/entregas.py): join contra empleados por
    # actor_id, null si no matchea (ej. actor_id="system" del sync en tiempo
    # real, o "supervisor" de una correccion del dashboard) -- el cliente ya
    # sabe caer al id crudo en ese caso, mismo criterio que en entregas.
    # actor_rol sale del mismo join: el dashboard lo usa para no contar como
    # "bodeguero" a punto_venta, que tambien genera entrega_actualizada (sin
    # items) al marcar FAIA desde el modal de PantallaCapturaFoto.
    rows = await pool.fetch(
        f"""
        select l.*, e.nombre as actor_nombre, e.rol as actor_rol
        from logs l
        left join empleados e on e.id::text = l.actor_id
        {where}
        order by l."timestamp" desc
        limit ${len(valores)}
        """,
        *valores,
    )
    return [{**dict(row), "id": str(row["id"])} for row in rows]
