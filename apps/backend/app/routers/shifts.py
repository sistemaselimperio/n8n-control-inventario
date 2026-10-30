"""Turnos y recomendaciones de turno (Figura 2 del diagrama de arquitectura).

El job semanal que calcula shift_recommendations vive fuera de este proceso
web (corre como un nodo cron de n8n o un script standalone en
scripts/generar_turnos.py) y escribe directamente en la tabla
shift_recommendations. Este router solo expone lectura: el antiguo
POST /turnos escribia sin credenciales y ningun cliente lo usaba, asi que se elimino.
"""

from fastapi import APIRouter, Query

from app.db import get_pool
from app.services.turnos import SEMANAS_HISTORIAL, calcular_bloques, cargar_celdas, umbral_pico

router = APIRouter(prefix="/turnos", tags=["turnos"])


@router.get("")
async def listar_turnos(sede_id: str | None = None) -> list[dict]:
    pool = await get_pool()
    if sede_id:
        rows = await pool.fetch(
            "select * from turnos where sede_id = $1 order by fecha", sede_id
        )
    else:
        rows = await pool.fetch("select * from turnos order by fecha")
    return [{**dict(row), "id": str(row["id"])} for row in rows]


@router.get("/carga")
async def carga_por_hora(
    sede_id: str, semanas: int = Query(SEMANAS_HISTORIAL, ge=1, le=52)
) -> dict:
    """Mapa de carga (dia x hora local) y bloques sugeridos de la sede,
    calculados en vivo -- pagina /turnos del dashboard. Mismo calculo que la
    foto semanal de scripts/generar_turnos.py (ver app/services/turnos.py)."""
    pool = await get_pool()
    celdas, semanas_cubiertas = await cargar_celdas(pool, sede_id, semanas)
    umbral = umbral_pico(celdas)
    return {
        "sede_id": sede_id,
        "semanas": semanas_cubiertas,
        "umbral_pico": round(umbral, 2) if umbral is not None else None,
        "celdas": [
            {
                "dia": c.dia,
                "hora": c.hora,
                "promedio": round(c.promedio, 2),
                "pico": umbral is not None and c.promedio >= umbral,
            }
            for c in celdas
        ],
        "bloques": calcular_bloques(celdas, umbral),
    }


@router.get("/recomendaciones")
async def listar_recomendaciones(sede_id: str | None = None) -> list[dict]:
    pool = await get_pool()
    if sede_id:
        rows = await pool.fetch(
            "select * from shift_recommendations where sede_id = $1 order by semana_iso desc",
            sede_id,
        )
    else:
        rows = await pool.fetch("select * from shift_recommendations order by semana_iso desc")
    return [{**dict(row), "id": str(row["id"])} for row in rows]
