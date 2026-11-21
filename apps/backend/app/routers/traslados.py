"""Modulo Traslados del dashboard: comprobantes de salida e ingreso entre
puntos (ver app/services/traslados.py). Solo sesion Bearer (sin token legacy);
los perfiles y su alcance estan en app/services/permisos_traslados.py.

Las rutas estaticas (/traslados/puntos, /traslados/comprobantes...) se declaran
antes que /traslados/{traslado_id}.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from app.models.traslado import DevolverRequest, TrasladoEditar
from app.services import traslados as servicio
from app.services.permisos_traslados import (
    PerfilTraslados,
    perfil_traslados,
    requiere_escritura_traslados,
    requiere_gestion_traslados,
)
from app.services.storage_evidencia import StorageNoDisponible
from app.services.traslados_reglas import (
    MAX_ARCHIVOS_POR_PETICION,
    MAX_BYTES_FIRMA,
    MAX_BYTES_PDF,
    ComprobanteDuplicado,
    DatoInvalido,
    EstadoNoPermitido,
    NoSePuedeEnviar,
    SinPermiso,
    TrasladoNoEncontrado,
)

router = APIRouter(prefix="/traslados", tags=["traslados"])

EstadoComprobante = Literal["pendiente", "confirmado", "devuelto"]
TipoComprobante = Literal["salida", "ingreso"]
EstadoTraslado = Literal["borrador", "enviado"]

_ERRORES = (
    TrasladoNoEncontrado,
    SinPermiso,
    EstadoNoPermitido,
    ComprobanteDuplicado,
    DatoInvalido,
    servicio.PdfTrasladoInvalido,
    StorageNoDisponible,
)


def _http(exc: Exception) -> HTTPException:
    """Traduce una excepcion del servicio a su respuesta HTTP."""
    if isinstance(exc, TrasladoNoEncontrado):
        codigo = 404
    elif isinstance(exc, SinPermiso):
        codigo = 403
    elif isinstance(exc, (EstadoNoPermitido, ComprobanteDuplicado)):
        codigo = 409
    elif isinstance(exc, (DatoInvalido, servicio.PdfTrasladoInvalido)):
        codigo = 422
    else:  # StorageNoDisponible
        codigo = 502
    return HTTPException(status_code=codigo, detail=str(exc))


def _texto(valor: str | None) -> str | None:
    valor = (valor or "").strip()
    return valor or None


async def _leer(archivo: UploadFile, maximo: int) -> bytes:
    """Lee a lo sumo `maximo` + 1 bytes: ese byte de mas basta para que el
    servicio detecte el exceso sin cargar el archivo completo en memoria."""
    return await archivo.read(maximo + 1)


# ---------------------------------------------------------------------------
# Lecturas
# ---------------------------------------------------------------------------


@router.get("/puntos")
async def puntos(perfil: PerfilTraslados = Depends(perfil_traslados)) -> list[dict]:
    """Puntos activos para los selectores: [{id, nombre, codigo, es_interna}].
    Un usuario de punto solo recibe el suyo."""
    return await servicio.puntos_para_traslados(perfil)


@router.get("/comprobantes")
async def listar_comprobantes(
    punto_id: UUID | None = None,
    estado: EstadoComprobante | None = None,
    tipo: TipoComprobante | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    perfil: PerfilTraslados = Depends(perfil_traslados),
) -> dict:
    """Comprobantes (uno por fila), nuevos primero: {total, items}. `q` busca por
    numero o nombre de archivo. Un perfil limitado a un punto solo ve el suyo."""
    return await servicio.listar_comprobantes(
        perfil,
        punto_id=None if punto_id is None else str(punto_id),
        estado=estado,
        tipo=tipo,
        q=_texto(q),
        limit=limit,
        offset=offset,
    )


@router.get("/comprobantes/{comprobante_id}")
async def detalle_comprobante(comprobante_id: UUID, perfil: PerfilTraslados = Depends(perfil_traslados)) -> dict:
    """Comprobante con `historial` (eventos de logs) y el resumen de su `traslado`."""
    try:
        return await servicio.detalle_comprobante(perfil, str(comprobante_id))
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.get("")
async def listar_traslados(
    estado: EstadoTraslado | None = None,
    punto_id: UUID | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    perfil: PerfilTraslados = Depends(perfil_traslados),
) -> dict:
    """Traslados (uno por PDF) con sus comprobantes incrustados: {total, items}."""
    return await servicio.listar_traslados(
        perfil,
        estado=estado,
        punto_id=None if punto_id is None else str(punto_id),
        q=_texto(q),
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# Subida y gestion del borrador
# ---------------------------------------------------------------------------


@router.post("/subir")
async def subir(
    archivos: list[UploadFile] = File(...),
    perfil: PerfilTraslados = Depends(requiere_gestion_traslados),
) -> dict:
    """Sube uno o varios PDFs "TRASLADO ENTRE BODEGAS" (campo multipart
    `archivos`, repetido). Responde 200 con {resultados: [{archivo, resultado:
    creado|borrador|duplicado|error, detalle, traslado, comprobante_existente?}]}:
    un archivo malo no afecta a los demas."""
    if len(archivos) > MAX_ARCHIVOS_POR_PETICION:
        raise HTTPException(status_code=413, detail=f"Máximo {MAX_ARCHIVOS_POR_PETICION} archivos por envío")
    leidos = [(a.filename or "traslado.pdf", await _leer(a, MAX_BYTES_PDF)) for a in archivos]
    try:
        return {"resultados": await servicio.subir_pdfs(leidos, perfil)}
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.patch("/{traslado_id}")
async def editar(
    traslado_id: UUID, payload: TrasladoEditar, perfil: PerfilTraslados = Depends(requiere_gestion_traslados)
) -> dict:
    """Completa un borrador. Solo se aplican los campos enviados; un null borra el
    dato. Devuelve el traslado con sus advertencias recalculadas."""
    cambios = {campo: getattr(payload, campo) for campo in payload.model_fields_set}
    if not cambios:
        raise HTTPException(status_code=422, detail="No hay cambios que guardar")
    try:
        return await servicio.editar_borrador(perfil, str(traslado_id), cambios)
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.post("/{traslado_id}/enviar")
async def enviar(traslado_id: UUID, perfil: PerfilTraslados = Depends(requiere_gestion_traslados)) -> dict:
    """Genera los comprobantes de un borrador completo y lo marca 'enviado'."""
    try:
        return await servicio.enviar(perfil, str(traslado_id))
    except NoSePuedeEnviar as exc:
        # Ademas del texto, la lista para pintarla en el formulario del borrador.
        return JSONResponse(status_code=422, content={"detail": str(exc), "advertencias": exc.advertencias})
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.delete("/{traslado_id}")
async def eliminar(traslado_id: UUID, perfil: PerfilTraslados = Depends(requiere_gestion_traslados)) -> dict:
    """Borrado definitivo: filas y archivos de Storage (PDFs y firmas)."""
    try:
        return await servicio.eliminar(perfil, str(traslado_id))
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.get("/{traslado_id}")
async def detalle_traslado(traslado_id: UUID, perfil: PerfilTraslados = Depends(perfil_traslados)) -> dict:
    """Traslado con renglones del PDF, comprobantes e historial."""
    try:
        return await servicio.detalle_traslado(perfil, str(traslado_id))
    except _ERRORES as exc:
        raise _http(exc) from exc


# ---------------------------------------------------------------------------
# Resolucion de un comprobante
# ---------------------------------------------------------------------------


@router.post("/comprobantes/{comprobante_id}/confirmar")
async def confirmar(
    comprobante_id: UUID,
    firma: UploadFile = File(...),
    observacion: str | None = Form(default=None),
    perfil: PerfilTraslados = Depends(requiere_escritura_traslados),
) -> dict:
    """Confirma un comprobante pendiente: multipart con `firma` (imagen PNG/JPG/WebP,
    obligatoria) y `observacion` (opcional). El responsable es el usuario de la
    sesion (requiere cedula configurada)."""
    contenido = await _leer(firma, MAX_BYTES_FIRMA)
    try:
        return await servicio.confirmar(perfil, str(comprobante_id), contenido, _texto(observacion))
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.post("/comprobantes/{comprobante_id}/devolver")
async def devolver(
    comprobante_id: UUID, payload: DevolverRequest, perfil: PerfilTraslados = Depends(requiere_escritura_traslados)
) -> dict:
    """Devuelve un comprobante con `motivo` obligatorio (JSON). El punto devuelve
    pendientes; la encargada tambien los confirmados."""
    try:
        return await servicio.devolver(perfil, str(comprobante_id), payload.motivo)
    except _ERRORES as exc:
        raise _http(exc) from exc


@router.post("/comprobantes/{comprobante_id}/reenviar")
async def reenviar(
    comprobante_id: UUID,
    numero: str | None = Form(default=None),
    punto_id: str | None = Form(default=None),
    archivo: UploadFile | None = File(default=None),
    perfil: PerfilTraslados = Depends(requiere_gestion_traslados),
) -> dict:
    """La encargada corrige un comprobante devuelto y lo regresa a 'pendiente'.
    Multipart, todos los campos opcionales: `numero`, `punto_id`, `archivo` (PDF nuevo)."""
    punto = _texto(punto_id)
    if punto is not None:
        try:
            punto = str(UUID(punto))
        except ValueError:
            raise HTTPException(status_code=422, detail="El identificador del punto no es válido") from None
    pdf = await _leer(archivo, MAX_BYTES_PDF) if archivo is not None else b""
    try:
        return await servicio.reenviar(
            perfil,
            str(comprobante_id),
            numero=_texto(numero),
            punto_id=punto,
            pdf=pdf or None,
            pdf_nombre=(archivo.filename if archivo is not None and pdf else None),
        )
    except _ERRORES as exc:
        raise _http(exc) from exc
