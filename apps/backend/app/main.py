import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import close_pool, ensure_schema
from app.routers import auth, dashboard_auth, empleados, entregas, facturas_faltantes, logs, productos, ranking, sedes, shifts, tipos_documento, traslados_puntos

logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_schema()
    yield
    await close_pool()


app = FastAPI(
    title="Control Logistico Multi-Sede API",
    description="Backend del pipeline de despacho: extraccion por IA, "
    "bloqueo de duplicados entre sedes y analitica de turnos.",
    version="0.1.0",
    lifespan=lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.dashboard_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Comprime respuestas grandes (ej. /entregas?limit=150 pesa ~230 KB en JSON
# repetitivo); el dashboard lo repite cada 5 s, asi que el ahorro se nota.
app.add_middleware(GZipMiddleware, minimum_size=1000)

app.include_router(entregas.router)
app.include_router(sedes.router)
app.include_router(logs.router)
app.include_router(shifts.router)
app.include_router(empleados.router)
app.include_router(auth.router)
app.include_router(productos.router)
app.include_router(ranking.router)
app.include_router(traslados_puntos.router)
app.include_router(tipos_documento.router)
app.include_router(facturas_faltantes.router)
app.include_router(dashboard_auth.router)


@app.exception_handler(Exception)
async def excepcion_no_manejada(request: Request, exc: Exception) -> JSONResponse:
    # Red de seguridad: sin esto, cualquier excepcion que se nos escape (bug
    # nuevo, error de un proveedor externo no contemplado, etc.) la devuelve
    # Starlette como texto plano en vez de JSON -- y el cliente movil, que
    # siempre espera poder hacer res.json(), se queda con una pantalla en
    # blanco en vez de un mensaje de error legible.
    logger.exception("Error no manejado en %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Error interno del servidor, proba de nuevo."})


# Marcador manual de build -- no se calcula del commit de git en runtime
# porque el Dockerfile solo copia app/ y scripts/ (build path "apps/backend"
# en Dokploy, ver README): el directorio .git vive en la raiz del repo y
# no esta disponible dentro del contexto de build ni de la imagen. Bumpear
# a mano este string en cada cambio que valga la pena poder confirmar desde
# afuera (ver GET /health) -- unica forma de verificar que un deploy en
# Dokploy realmente tomo el commit esperado sin entrar al panel.
_BUILD_MARCADOR = "reporte-mensual-sin-entregas"


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "build": _BUILD_MARCADOR}
