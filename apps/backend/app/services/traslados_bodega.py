"""Traslado "desde bodega": el supervisor sube desde el dashboard el PDF
"TRASLADO ENTRE BODEGAS" del sistema contable, revisa el borrador y lo envia a
un punto, que lo recibe item por item en la app movil con el flujo de recepcion
y novedades de siempre (ver registrar_recepcion en traslados_puntos.py).

Vive en `traslados_puntos` con tipo 'desde_bodega' (sin origen, sin talonario).
La lectura del PDF esta en pdf_traslado_bodega.py; aca solo la logica con base
de datos y Storage.
"""

import uuid

import asyncpg

from app.db import get_pool
from app.models.log import EventoLog
from app.models.traslado_punto import TrasladoDesdeBodegaDatos, normalizar_numero_syscafe
from app.services import storage_evidencia
from app.services.logging_service import registrar_evento
from app.services.pdf_traslado_bodega import (
    PdfTrasladoInvalido,
    extraer_texto_pdf,
    parsear_traslado_bodega,
    sugerir_punto,
)
from app.services.productos import sincronizar_producto_con_codigo
from app.services.traslados_puntos import (
    MAX_BYTES_REPORTE_SYSCAFE,
    ArchivoReporteMuyGrande,
    ArchivoReporteNoPermitido,
    SyscafeDuplicado,
    TrasladoInvalido,
    TrasladoNoEncontrado,
    TrasladoYaRecibido,
)

__all__ = [
    "MAX_BYTES_PDF",
    "PdfTrasladoInvalido",
    "anular_desde_bodega",
    "crear_desde_bodega",
    "editar_desde_bodega",
    "generar_borrador",
]

MAX_BYTES_PDF = MAX_BYTES_REPORTE_SYSCAFE
_CONSTRAINT_NUMERO = "traslados_puntos_numero_syscafe_key"


def _validar_tamano(contenido: bytes) -> None:
    if len(contenido) > MAX_BYTES_PDF:
        raise ArchivoReporteMuyGrande("El archivo supera los 5 MB")


def _validar_pdf(contenido: bytes) -> None:
    _validar_tamano(contenido)
    if not contenido.startswith(b"%PDF-"):
        raise ArchivoReporteNoPermitido("El archivo no es un PDF válido")


def _mensaje_duplicado(numero: str) -> str:
    return f"El traslado {numero} ya fue cargado"


def _normalizar_numero(numero: str) -> str:
    try:
        normalizado = normalizar_numero_syscafe(numero)
    except ValueError as exc:
        raise TrasladoInvalido(str(exc)) from exc
    if normalizado is None:
        raise TrasladoInvalido("El número del traslado es obligatorio")
    return normalizado


async def _existe_numero(pool, numero: str) -> bool:
    return await pool.fetchrow("select id from traslados_puntos where numero_syscafe = $1", numero) is not None


async def _validar_destino(pool, punto_destino_id: str) -> None:
    try:
        uuid.UUID(punto_destino_id)
        destino = await pool.fetchrow(
            "select id from puntos where id = $1::uuid and activo = true", punto_destino_id
        )
    except ValueError:
        destino = None
    if destino is None:
        raise TrasladoInvalido("El punto de destino no existe o está inactivo")


async def _insertar_items(conn, traslado_id: str, datos: TrasladoDesdeBodegaDatos) -> list[dict]:
    items = []
    for item in datos.items:
        fila = await conn.fetchrow(
            """
            insert into traslado_punto_items (traslado_id, cantidad, producto, presentacion, referencia, precio)
            values ($1::uuid, $2, $3, $4, $5, $6)
            returning *
            """,
            traslado_id,
            item.cantidad,
            item.detalle,
            item.empaque,
            item.referencia,
            item.precio,
        )
        items.append(dict(fila))
        await sincronizar_producto_con_codigo(conn, item.referencia, item.detalle)
    return items


async def generar_borrador(contenido: bytes) -> dict:
    """Lee el PDF y devuelve el borrador para revisar (no guarda nada): los
    campos del documento, los items, el punto de destino sugerido por nombre
    (`punto_destino_id`, None si no hay uno claro), `ya_cargado` y las
    `advertencias` (suma que no cuadra, renglones ilegibles, numero repetido).
    Lanza PdfTrasladoInvalido si el PDF no sirve."""
    _validar_tamano(contenido)
    borrador = parsear_traslado_bodega(extraer_texto_pdf(contenido))

    pool = await get_pool()
    filas = await pool.fetch("select id, nombre, codigo from puntos where activo = true order by nombre")
    puntos = [{"id": str(f["id"]), "nombre": f["nombre"], "codigo": f["codigo"]} for f in filas]
    sugerido = sugerir_punto(borrador["destino_texto"], puntos)
    borrador["punto_destino_id"] = sugerido["id"] if sugerido else None
    if sugerido is None and borrador["destino_texto"]:
        borrador["advertencias"].append(
            f"No se pudo identificar el punto de destino ({borrador['destino_texto']}). Elígelo manualmente"
        )

    borrador["ya_cargado"] = await _existe_numero(pool, borrador["numero"])
    if borrador["ya_cargado"]:
        borrador["advertencias"].append(f"El traslado {borrador['numero']} ya fue cargado antes")
    return borrador


async def crear_desde_bodega(
    contenido: bytes, datos: TrasladoDesdeBodegaDatos, *, usuario_id: str | None, actor: str
) -> dict:
    """Guarda el traslado (en_transito) con sus items y el PDF original en
    Storage. `usuario_id` es el usuario del dashboard (None con el token
    legacy); `actor` el texto para logs. El PDF se sube antes del insert y se
    borra si el insert falla -- mismo criterio que subir_reporte_syscafe."""
    _validar_pdf(contenido)
    numero = _normalizar_numero(datos.numero)
    pool = await get_pool()
    await _validar_destino(pool, datos.punto_destino_id)
    if await _existe_numero(pool, numero):
        raise SyscafeDuplicado(_mensaje_duplicado(numero))

    traslado_id = str(uuid.uuid4())
    ruta = f"traslados-bodega/{traslado_id}.pdf"
    await storage_evidencia.subir(ruta, contenido, "application/pdf")
    pdf_url = storage_evidencia.url_publica(ruta)

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                fila = await conn.fetchrow(
                    """
                    insert into traslados_puntos (
                        id, tipo, punto_origen_id, punto_destino_id, fecha, estado,
                        creado_por_usuario, numero_syscafe, numero_documento,
                        concepto, origen_texto, elaboro, pdf_url
                    )
                    values (
                        $1::uuid, 'desde_bodega', null, $2::uuid, $3, 'en_transito',
                        $4::uuid, $5, $5, $6, $7, $8, $9
                    )
                    returning *
                    """,
                    traslado_id,
                    datos.punto_destino_id,
                    datos.fecha,
                    usuario_id,
                    numero,
                    datos.concepto,
                    datos.origen,
                    datos.elaboro,
                    pdf_url,
                )
                items = await _insertar_items(conn, traslado_id, datos)
    except asyncpg.UniqueViolationError as exc:
        await storage_evidencia.borrar(ruta)
        if exc.constraint_name == _CONSTRAINT_NUMERO:
            raise SyscafeDuplicado(_mensaje_duplicado(numero)) from exc
        raise
    except Exception:
        await storage_evidencia.borrar(ruta)
        raise

    await registrar_evento(
        EventoLog.TRASLADO_BODEGA_CREADO,
        entidad_tipo="traslado_punto",
        entidad_id=traslado_id,
        actor_id=usuario_id or actor,
        sede_id=datos.punto_destino_id,
        resultado="ok",
        detalle={"numero": numero, "cantidad_items": len(items), "origen": datos.origen},
    )
    resultado = dict(fila)
    resultado["items"] = items
    return resultado


async def _traslado_editable(pool, traslado_id: str) -> dict:
    """Traslado desde bodega aun en transito, o la excepcion que corresponda
    (404 no existe, 422 es de otro tipo, 409 ya recibido o anulado)."""
    fila = await pool.fetchrow(
        "select id, tipo, estado, punto_destino_id, numero_documento from traslados_puntos where id = $1::uuid",
        traslado_id,
    )
    if fila is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    if fila["tipo"] != "desde_bodega":
        raise TrasladoInvalido("Solo se pueden editar o anular los traslados desde bodega")
    if fila["estado"] != "en_transito":
        raise TrasladoYaRecibido(_mensaje_bloqueado(fila["estado"]))
    return dict(fila)


def _mensaje_bloqueado(estado: str) -> str:
    if estado == "anulado":
        return "Este traslado ya está anulado"
    return "Este traslado ya fue recibido y no se puede modificar"


async def editar_desde_bodega(
    traslado_id: str, datos: TrasladoDesdeBodegaDatos, *, usuario_id: str | None, actor: str
) -> dict:
    """Reemplaza cabecera e items de un traslado desde bodega mientras sigue
    en_transito. Como nadie ha recibido nada todavia, los items se borran y se
    vuelven a insertar. El update esta guardado por estado='en_transito': si el
    punto lo recibe justo en medio, cae al 409 sin tocar los items."""
    numero = _normalizar_numero(datos.numero)
    pool = await get_pool()
    await _traslado_editable(pool, traslado_id)
    await _validar_destino(pool, datos.punto_destino_id)

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                fila = await conn.fetchrow(
                    """
                    update traslados_puntos
                    set punto_destino_id = $2::uuid, fecha = $3, numero_syscafe = $4, numero_documento = $4,
                        concepto = $5, origen_texto = $6, elaboro = $7
                    where id = $1::uuid and estado = 'en_transito' and tipo = 'desde_bodega'
                    returning *
                    """,
                    traslado_id,
                    datos.punto_destino_id,
                    datos.fecha,
                    numero,
                    datos.concepto,
                    datos.origen,
                    datos.elaboro,
                )
                if fila is None:
                    raise TrasladoYaRecibido(_mensaje_bloqueado("recibido"))
                await conn.execute("delete from traslado_punto_items where traslado_id = $1::uuid", traslado_id)
                items = await _insertar_items(conn, traslado_id, datos)
    except asyncpg.UniqueViolationError as exc:
        if exc.constraint_name == _CONSTRAINT_NUMERO:
            raise SyscafeDuplicado(_mensaje_duplicado(numero)) from exc
        raise

    await registrar_evento(
        EventoLog.TRASLADO_BODEGA_EDITADO,
        entidad_tipo="traslado_punto",
        entidad_id=traslado_id,
        actor_id=usuario_id or actor,
        sede_id=datos.punto_destino_id,
        resultado="ok",
        detalle={"numero": numero, "cantidad_items": len(items)},
    )
    resultado = dict(fila)
    resultado["items"] = items
    return resultado


async def anular_desde_bodega(
    traslado_id: str, motivo: str, *, usuario_id: str | None, actor: str, nombre: str
) -> dict:
    """Anula un traslado desde bodega que sigue en transito. El motivo es
    obligatorio. Se libera numero_syscafe (el numero del documento queda en
    numero_documento) para poder cargar de nuevo el PDF corregido."""
    motivo = (motivo or "").strip()
    if not motivo:
        raise TrasladoInvalido("El motivo de la anulación es obligatorio")
    pool = await get_pool()
    previo = await _traslado_editable(pool, traslado_id)

    actualizado = await pool.fetchrow(
        """
        update traslados_puntos
        set estado = 'anulado', anulado_motivo = $2, anulado_at = now(), anulado_por = $3, numero_syscafe = null
        where id = $1::uuid and estado = 'en_transito' and tipo = 'desde_bodega'
        returning *
        """,
        traslado_id,
        motivo,
        nombre,
    )
    if actualizado is None:
        raise TrasladoYaRecibido(_mensaje_bloqueado("recibido"))

    await registrar_evento(
        EventoLog.TRASLADO_BODEGA_ANULADO,
        entidad_tipo="traslado_punto",
        entidad_id=traslado_id,
        actor_id=usuario_id or actor,
        sede_id=str(previo["punto_destino_id"]),
        resultado="ok",
        detalle={"numero": previo.get("numero_documento"), "motivo": motivo},
    )
    items = await pool.fetch(
        "select * from traslado_punto_items where traslado_id = $1::uuid order by id", traslado_id
    )
    resultado = dict(actualizado)
    resultado["items"] = [dict(i) for i in items]
    return resultado
