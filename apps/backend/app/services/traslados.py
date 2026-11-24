"""Modulo Traslados: comprobantes de SALIDA e INGRESO entre puntos.

Una encargada sube PDFs "TRASLADO ENTRE BODEGAS" del sistema contable. Cada PDF
es un `traslado`; el parser existente (pdf_traslado_bodega.py, sin IA) lee el
numero, la bodega de origen ("Bodega:") y la de destino ("Destino:"), y cada
una se busca entre los `puntos`. Un punto "interno" (puntos.es_interna) no
firma, asi que ese lado no genera comprobante. Si algo no se puede determinar
el traslado queda en `borrador` con `advertencias`: nunca se adivina.

Cada comprobante lo resuelve su punto: confirma con firma (imagen) o devuelve
con motivo. La encargada puede devolver uno ya confirmado, corregir uno
devuelto (numero, punto, PDF) y reenviarlo. La barrera contra duplicados es el
unico (numero, punto_id, tipo) de la base. Cada accion deja un evento
inmutable en `logs`; el historial de un comprobante se lee de ahi.

Las reglas puras (permisos por estado, plan de comprobantes, puntos) estan en
traslados_reglas.py; aca va todo lo que toca la base y Storage.
"""

import logging
import re
import uuid
from datetime import UTC, date, datetime
from typing import Any

import asyncpg

from app.db import get_pool
from app.models.log import EventoLog
from app.models.traslado import MAX_MOTIVO, MAX_OBSERVACION
from app.services import storage_evidencia
from app.services.logging_service import registrar_evento
from app.services.pdf_traslado_bodega import PdfTrasladoInvalido, extraer_texto_pdf, parsear_traslado_bodega
from app.services.permisos_traslados import PerfilTraslados
from app.services.storage_evidencia import StorageNoDisponible
from app.services.traslados_reglas import (
    MAX_BYTES_FIRMA,
    MAX_BYTES_PDF,
    ComprobanteDuplicado,
    DatoInvalido,
    EstadoNoPermitido,
    NoSePuedeEnviar,
    SinPermiso,
    TrasladoNoEncontrado,
    autorizar_accion,
    detectar_imagen,
    evaluar_traslado,
    fusionar_advertencias,
    normalizar_numero,
    resolver_punto,
)

logger = logging.getLogger("app.traslados")

__all__ = [
    "ComprobanteDuplicado",
    "DatoInvalido",
    "EstadoNoPermitido",
    "NoSePuedeEnviar",
    "PdfTrasladoInvalido",
    "SinPermiso",
    "TrasladoNoEncontrado",
    "confirmar",
    "detalle_comprobante",
    "detalle_traslado",
    "devolver",
    "editar_borrador",
    "eliminar",
    "enviar",
    "listar_comprobantes",
    "listar_traslados",
    "procesar_pdf",
    "puntos_para_traslados",
    "reenviar",
    "subir_pdfs",
]

# Nombre del indice unico (numero, punto_id, tipo): asyncpg lo reporta como
# constraint_name al violarse.
_UNICO_COMPROBANTE = "traslado_comprobantes_numero_punto_tipo_key"

# El parser aborta si no encuentra numero; para poder dejar un borrador con el
# resto de los datos se le inyecta este numero de relleno y luego se descarta.
_RELLENO_NUMERO = "ZZZ-0\n"
_MENSAJE_SIN_NUMERO_PARSER = "número del traslado"

_SQL_TRASLADO = """
select t.*,
       po.nombre as origen_nombre, po.codigo as origen_codigo, po.es_interna as origen_es_interna,
       pd.nombre as destino_nombre, pd.codigo as destino_codigo, pd.es_interna as destino_es_interna
from traslados t
left join puntos po on po.id = t.origen_punto_id
left join puntos pd on pd.id = t.destino_punto_id
"""

_SQL_COMPROBANTE = """
select c.*, p.nombre as punto_nombre, p.codigo as punto_codigo
from traslado_comprobantes c
join puntos p on p.id = c.punto_id
"""

_SQL_EXISTENTE = """
select c.id, c.traslado_id, c.numero, c.tipo, c.punto_id, c.estado, p.nombre as punto_nombre
from traslado_comprobantes c
join puntos p on p.id = c.punto_id
where c.numero = $1 and (c.punto_id::text || ':' || c.tipo) = any($2::text[])
order by c.tipo desc
limit 1
"""

_SQL_INSERTAR_TRASLADO = """
insert into traslados (
    id, numero, archivo_nombre, pdf_ruta, estado, advertencias, fecha, concepto, elaboro,
    origen_texto, destino_texto, items, origen_punto_id, destino_punto_id, archivos, creado_por, enviado_at
)
values ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13::uuid, $14::uuid, $15::jsonb, $16, $17)
returning *
"""

_SQL_INSERTAR_COMPROBANTE = """
insert into traslado_comprobantes (traslado_id, numero, tipo, punto_id)
values ($1::uuid, $2, $3, $4::uuid)
returning *
"""


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------


def _s(valor: Any) -> str | None:
    return None if valor is None else str(valor)


def _ruta_publica(ruta: str | None) -> str | None:
    return storage_evidencia.url_publica(ruta) if ruta else None


def _ahora() -> datetime:
    return datetime.now(UTC)


def _nombre_archivo(nombre: str | None) -> str:
    """Solo el nombre (sin carpetas de Windows ni de Unix), acotado."""
    limpio = re.split(r"[\\/]", nombre or "")[-1].strip()
    return (limpio or "traslado.pdf")[:200]


def _limpiar_texto(valor: str | None, maximo: int, campo: str) -> str | None:
    if valor is None:
        return None
    valor = valor.strip()
    if not valor:
        return None
    if len(valor) > maximo:
        raise DatoInvalido(f"{campo} no puede superar los {maximo} caracteres")
    return valor


def _validar_pdf(contenido: bytes) -> None:
    if not contenido:
        raise DatoInvalido("El archivo está vacío")
    if len(contenido) > MAX_BYTES_PDF:
        raise DatoInvalido(f"El archivo supera los {MAX_BYTES_PDF // (1024 * 1024)} MB")
    if not contenido.startswith(b"%PDF-"):
        raise DatoInvalido("El archivo no es un PDF válido")


def _exigir_gestion(perfil: PerfilTraslados) -> None:
    if not perfil.gestiona:
        raise SinPermiso("Solo la encargada o un administrador pueden hacer esto")


def _escapar_like(texto: str) -> str:
    return texto.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def _puntos_activos(pool) -> list[dict]:
    filas = await pool.fetch(
        "select id, nombre, codigo, es_interna, alias from puntos where activo = true order by nombre"
    )
    return [
        {
            "id": str(f["id"]),
            "nombre": f["nombre"],
            "codigo": f["codigo"],
            "es_interna": bool(f["es_interna"]),
            "alias": list(f.get("alias") or []),
        }
        for f in filas
    ]


async def _punto_activo(pool, punto_id: str | None, *, campo: str = "punto") -> dict | None:
    """Punto activo con ese id o DatoInvalido; None si no se indico ninguno."""
    if punto_id is None:
        return None
    try:
        uuid.UUID(str(punto_id))
        fila = await pool.fetchrow(
            "select id, nombre, codigo, es_interna, activo from puntos where id = $1::uuid", str(punto_id)
        )
    except ValueError:
        fila = None
    if fila is None or not fila["activo"]:
        raise DatoInvalido(f"El {campo} no existe o está inactivo")
    return {"id": str(fila["id"]), "nombre": fila["nombre"], "codigo": fila["codigo"], "es_interna": bool(fila["es_interna"])}


async def _punto_por_id(conn, punto_id) -> dict | None:
    """Punto (activo o no) tal como esta guardado; None si no hay id."""
    if punto_id is None:
        return None
    fila = await conn.fetchrow(
        "select id, nombre, codigo, es_interna, activo from puntos where id = $1::uuid", str(punto_id)
    )
    if fila is None:
        return None
    return {"id": str(fila["id"]), "nombre": fila["nombre"], "codigo": fila["codigo"], "es_interna": bool(fila["es_interna"])}


# ---------------------------------------------------------------------------
# Serializacion
# ---------------------------------------------------------------------------


def _punto_resumen(fila: Any, prefijo: str) -> dict | None:
    punto_id = fila.get(f"{prefijo}_punto_id")
    if punto_id is None:
        return None
    return {
        "id": str(punto_id),
        "nombre": fila.get(f"{prefijo}_nombre"),
        "codigo": fila.get(f"{prefijo}_codigo"),
        "es_interna": bool(fila.get(f"{prefijo}_es_interna")),
    }


def _serializar_comprobante(fila: Any, historial: list[dict] | None = None) -> dict:
    resultado = {
        "id": str(fila["id"]),
        "traslado_id": str(fila["traslado_id"]),
        "numero": fila["numero"],
        "tipo": fila["tipo"],
        "punto_id": str(fila["punto_id"]),
        "punto_nombre": fila.get("punto_nombre"),
        "punto_codigo": fila.get("punto_codigo"),
        "estado": fila["estado"],
        "responsable_usuario_id": _s(fila["responsable_usuario_id"]),
        "responsable_nombre": fila["responsable_nombre"],
        "responsable_cedula": fila["responsable_cedula"],
        "firma_url": _ruta_publica(fila["firma_ruta"]),
        "observacion": fila["observacion"],
        "motivo_devolucion": fila["motivo_devolucion"],
        "resuelto_at": fila["resuelto_at"],
        "creado_at": fila["creado_at"],
        "actualizado_at": fila["actualizado_at"],
    }
    # Solo las consultas de listado traen datos del traslado padre.
    if fila.get("archivo_nombre") is not None:
        resultado["archivo_nombre"] = fila["archivo_nombre"]
        resultado["pdf_url"] = _ruta_publica(fila.get("traslado_pdf_ruta"))
        resultado["fecha"] = fila.get("traslado_fecha")
        resultado["concepto"] = fila.get("traslado_concepto")
    if historial is not None:
        resultado["historial"] = historial
    return resultado


def _serializar_traslado(
    fila: Any, comprobantes: list[dict], *, con_items: bool = False, historial: list[dict] | None = None
) -> dict:
    resultado = {
        "id": str(fila["id"]),
        "numero": fila["numero"],
        "archivo_nombre": fila["archivo_nombre"],
        "pdf_url": _ruta_publica(fila["pdf_ruta"]),
        "estado": fila["estado"],
        "advertencias": list(fila["advertencias"] or []),
        "fecha": fila["fecha"],
        "concepto": fila["concepto"],
        "elaboro": fila["elaboro"],
        "origen_texto": fila["origen_texto"],
        "destino_texto": fila["destino_texto"],
        "origen_punto_id": _s(fila["origen_punto_id"]),
        "origen_punto": _punto_resumen(fila, "origen"),
        "destino_punto_id": _s(fila["destino_punto_id"]),
        "destino_punto": _punto_resumen(fila, "destino"),
        "creado_por": fila["creado_por"],
        "creado_at": fila["creado_at"],
        "actualizado_at": fila["actualizado_at"],
        "enviado_at": fila["enviado_at"],
        "comprobantes": comprobantes,
    }
    if con_items:
        resultado["items"] = list(fila["items"] or [])
    if historial is not None:
        resultado["historial"] = historial
    return resultado


def _con_nombres_de_punto(fila: dict, origen: dict | None, destino: dict | None) -> dict:
    """Agrega a la fila de un traslado recien escrito las columnas que el
    select con joins (_SQL_TRASLADO) trae de los puntos."""
    return {
        **fila,
        "origen_nombre": origen and origen["nombre"],
        "origen_codigo": origen and origen["codigo"],
        "origen_es_interna": origen and origen["es_interna"],
        "destino_nombre": destino and destino["nombre"],
        "destino_codigo": destino and destino["codigo"],
        "destino_es_interna": destino and destino["es_interna"],
    }


def _serializar_historial(filas: list[Any]) -> list[dict]:
    return [
        {
            "evento": f["evento"],
            "actor": f["actor_id"],
            "resultado": f["resultado"],
            "detalle": f["detalle"],
            "timestamp": f["timestamp"],
        }
        for f in filas
    ]


async def _historial(pool, traslado_id: str, comprobante_ids: list[str]) -> tuple[list[dict], dict[str, list[dict]]]:
    """(eventos del traslado, eventos por comprobante), en orden cronologico."""
    filas = await pool.fetch(
        """
        select evento, entidad_tipo, entidad_id, actor_id, resultado, detalle, "timestamp"
        from logs
        where (entidad_tipo = 'traslado' and entidad_id = $1)
           or (entidad_tipo = 'traslado_comprobante' and entidad_id = any($2::text[]))
        order by "timestamp", id
        """,
        traslado_id,
        comprobante_ids,
    )
    del_traslado = [f for f in filas if f["entidad_tipo"] == "traslado"]
    por_comprobante: dict[str, list[dict]] = {cid: [] for cid in comprobante_ids}
    for f in filas:
        if f["entidad_tipo"] == "traslado_comprobante" and f["entidad_id"] in por_comprobante:
            por_comprobante[f["entidad_id"]].extend(_serializar_historial([f]))
    return _serializar_historial(del_traslado), por_comprobante


async def _evento(
    evento: EventoLog, entidad_tipo: str, entidad_id: str, perfil: PerfilTraslados, resultado: str,
    detalle: dict, sede_id: str = "-",
) -> None:
    await registrar_evento(
        evento,
        entidad_tipo=entidad_tipo,
        entidad_id=entidad_id,
        actor_id=perfil.actor,
        sede_id=sede_id,
        resultado=resultado,
        detalle=detalle,
    )


# ---------------------------------------------------------------------------
# Subida de PDFs
# ---------------------------------------------------------------------------


def _leer_traslado(texto: str) -> dict:
    """Parser del PDF; si solo falta el numero, se rescata el resto con un
    numero de relleno que despues se descarta (el traslado queda en borrador)."""
    try:
        return parsear_traslado_bodega(texto)
    except PdfTrasladoInvalido as exc:
        if _MENSAJE_SIN_NUMERO_PARSER not in str(exc):
            raise
    datos = parsear_traslado_bodega(_RELLENO_NUMERO + texto)
    datos["numero"] = None
    return datos


async def _buscar_existente(pool, numero: str, plan) -> dict | None:
    fila = await pool.fetchrow(_SQL_EXISTENTE, numero, [f"{c.punto_id}:{c.tipo}" for c in plan])
    if fila is None:
        return None
    return {
        "id": str(fila["id"]),
        "traslado_id": str(fila["traslado_id"]),
        "numero": fila["numero"],
        "tipo": fila["tipo"],
        "punto_id": str(fila["punto_id"]),
        "punto_nombre": fila["punto_nombre"],
        "estado": fila["estado"],
    }


async def _resultado_duplicado(archivo: str, existente: dict, perfil: PerfilTraslados) -> dict:
    await _evento(
        EventoLog.TRASLADO_DUPLICADO_BLOQUEADO,
        "traslado_comprobante",
        existente["id"],
        perfil,
        "bloqueado",
        {"numero": existente["numero"], "tipo": existente["tipo"], "archivo": archivo},
        sede_id=existente["punto_id"],
    )
    return {
        "archivo": archivo,
        "resultado": "duplicado",
        "detalle": (
            f"El comprobante de {existente['tipo']} {existente['numero']} de {existente['punto_nombre']} "
            f"ya existe ({existente['estado']})"
        ),
        "traslado": None,
        "comprobante_existente": existente,
    }


def _resultado_error(archivo: str, detalle: str) -> dict:
    return {"archivo": archivo, "resultado": "error", "detalle": detalle, "traslado": None}


async def procesar_pdf(nombre: str, contenido: bytes, perfil: PerfilTraslados) -> dict:
    """Procesa UN PDF y devuelve su resultado:
    {archivo, resultado: creado|borrador|duplicado|error, detalle, traslado,
    comprobante_existente?}. Nunca lanza por un problema del archivo (solo
    SinPermiso): un error se reporta en su resultado."""
    _exigir_gestion(perfil)
    archivo = _nombre_archivo(nombre)
    try:
        return await _procesar_pdf(archivo, contenido, perfil)
    except (DatoInvalido, PdfTrasladoInvalido) as exc:
        return _resultado_error(archivo, str(exc))
    except StorageNoDisponible:
        return _resultado_error(archivo, "No se pudo guardar el PDF. Intenta de nuevo")
    except Exception:  # noqa: BLE001 - un archivo malo no debe tumbar al resto del lote
        logger.exception("Error procesando el PDF %s", archivo)
        return _resultado_error(archivo, "Error inesperado al procesar el archivo")


async def _procesar_pdf(archivo: str, contenido: bytes, perfil: PerfilTraslados) -> dict:
    _validar_pdf(contenido)
    datos = _leer_traslado(extraer_texto_pdf(contenido))

    pool = await get_pool()
    puntos = await _puntos_activos(pool)
    origen = resolver_punto(datos["origen"], puntos)
    destino = resolver_punto(datos["destino_texto"], puntos)
    numero = datos["numero"]
    evaluacion = evaluar_traslado(numero, origen, destino)
    estado = "borrador" if evaluacion.bloqueantes else "enviado"
    advertencias = fusionar_advertencias(datos["advertencias"], evaluacion.bloqueantes)

    if evaluacion.comprobantes:
        existente = await _buscar_existente(pool, numero, evaluacion.comprobantes)
        if existente is not None:
            return await _resultado_duplicado(archivo, existente, perfil)

    traslado_id = str(uuid.uuid4())
    ruta = f"traslados/{traslado_id}/{uuid.uuid4().hex}.pdf"
    await storage_evidencia.subir(ruta, contenido, "application/pdf")
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                fila = await conn.fetchrow(
                    _SQL_INSERTAR_TRASLADO,
                    traslado_id,
                    numero,
                    archivo,
                    ruta,
                    estado,
                    advertencias,
                    date.fromisoformat(datos["fecha"]) if datos["fecha"] else None,
                    datos["concepto"],
                    datos["elaboro"],
                    datos["origen"],
                    datos["destino_texto"],
                    datos["items"],
                    origen and origen["id"],
                    destino and destino["id"],
                    [ruta],
                    perfil.actor,
                    _ahora() if estado == "enviado" else None,
                )
                filas_comprobantes = [
                    await conn.fetchrow(_SQL_INSERTAR_COMPROBANTE, traslado_id, numero, c.tipo, c.punto_id)
                    for c in evaluacion.comprobantes
                ]
    except asyncpg.UniqueViolationError as exc:
        await storage_evidencia.borrar(ruta)
        if exc.constraint_name != _UNICO_COMPROBANTE:
            raise
        # Otra carga se adelanto entre el chequeo y el insert.
        existente = await _buscar_existente(pool, numero, evaluacion.comprobantes)
        if existente is None:
            raise
        return await _resultado_duplicado(archivo, existente, perfil)
    except Exception:
        await storage_evidencia.borrar(ruta)
        raise

    por_id = {p["id"]: p for p in (origen, destino) if p is not None}
    comprobantes = []
    for c in filas_comprobantes:
        punto = por_id[str(c["punto_id"])]
        comprobantes.append({**c, "punto_nombre": punto["nombre"], "punto_codigo": punto["codigo"]})

    await _evento(
        EventoLog.TRASLADO_CREADO,
        "traslado",
        traslado_id,
        perfil,
        estado,
        {"numero": numero, "archivo": archivo, "advertencias": advertencias},
    )
    for c in comprobantes:
        await _evento(
            EventoLog.TRASLADO_COMPROBANTE_CREADO,
            "traslado_comprobante",
            str(c["id"]),
            perfil,
            "ok",
            {"numero": numero, "tipo": c["tipo"]},
            sede_id=str(c["punto_id"]),
        )
    traslado = _serializar_traslado(
        _con_nombres_de_punto(fila, origen, destino), [_serializar_comprobante(c) for c in comprobantes]
    )
    return {
        "archivo": archivo,
        "resultado": "creado" if estado == "enviado" else "borrador",
        "detalle": None if estado == "enviado" else "; ".join(evaluacion.bloqueantes),
        "traslado": traslado,
    }


async def subir_pdfs(archivos: list[tuple[str, bytes]], perfil: PerfilTraslados) -> list[dict]:
    """Procesa varios PDFs en orden y devuelve un resultado por archivo."""
    _exigir_gestion(perfil)
    resultados = []
    for nombre, contenido in archivos:
        try:
            resultados.append(await procesar_pdf(nombre, contenido, perfil))
        except SinPermiso:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Error procesando %s", nombre)
            resultados.append(_resultado_error(_nombre_archivo(nombre), "Error inesperado al procesar el archivo"))
    return resultados


# ---------------------------------------------------------------------------
# Lecturas
# ---------------------------------------------------------------------------


async def puntos_para_traslados(perfil: PerfilTraslados) -> list[dict]:
    """Puntos activos para los selectores del dashboard (un usuario de punto
    solo ve el suyo)."""
    pool = await get_pool()
    # El alias solo sirve para resolver el texto del PDF; no viaja a los selectores.
    return [
        {k: v for k, v in p.items() if k != "alias"} for p in await _puntos_activos(pool) if perfil.ve(p["id"])
    ]


async def _comprobantes_de(pool, traslado_ids: list[str], perfil: PerfilTraslados) -> list[Any]:
    """Comprobantes de esos traslados que el perfil puede ver (salida antes que ingreso)."""
    sql = _SQL_COMPROBANTE + " where c.traslado_id = any($1::uuid[])"
    args: list[Any] = [traslado_ids]
    if perfil.punto_id is not None:
        sql += " and c.punto_id = $2::uuid"
        args.append(perfil.punto_id)
    sql += " order by c.traslado_id, case c.tipo when 'salida' then 0 else 1 end"
    return await pool.fetch(sql, *args)


async def detalle_traslado(perfil: PerfilTraslados, traslado_id: str) -> dict:
    """Traslado con sus comprobantes (solo los que el perfil ve) e historial.
    Un perfil limitado a un punto no ve el historial del traslado en si ni
    traslados sin comprobantes de su punto (404)."""
    pool = await get_pool()
    fila = await pool.fetchrow(_SQL_TRASLADO + " where t.id = $1::uuid", traslado_id)
    if fila is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    comprobantes = await _comprobantes_de(pool, [traslado_id], perfil)
    if perfil.punto_id is not None and not comprobantes:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    del_traslado, por_comprobante = await _historial(pool, traslado_id, [str(c["id"]) for c in comprobantes])
    serializados = [_serializar_comprobante(c, por_comprobante[str(c["id"])]) for c in comprobantes]
    return _serializar_traslado(
        fila,
        serializados,
        con_items=True,
        historial=del_traslado if perfil.punto_id is None else None,
    )


async def _comprobante_visible(pool, comprobante_id: str, perfil: PerfilTraslados) -> Any:
    fila = await pool.fetchrow(_SQL_COMPROBANTE + " where c.id = $1::uuid", comprobante_id)
    if fila is None or not perfil.ve(fila["punto_id"]):
        raise TrasladoNoEncontrado("Comprobante no encontrado")
    return fila


async def detalle_comprobante(perfil: PerfilTraslados, comprobante_id: str) -> dict:
    """Comprobante con su historial y un resumen del traslado al que pertenece."""
    pool = await get_pool()
    fila = await _comprobante_visible(pool, comprobante_id, perfil)
    traslado = await pool.fetchrow(_SQL_TRASLADO + " where t.id = $1::uuid", str(fila["traslado_id"]))
    _, por_comprobante = await _historial(pool, str(fila["traslado_id"]), [str(fila["id"])])
    resultado = _serializar_comprobante(fila, por_comprobante[str(fila["id"])])
    if traslado is not None:
        resumen = _serializar_traslado(traslado, [])
        resumen.pop("comprobantes")
        resultado["traslado"] = resumen
    return resultado


def _filtros(condiciones: list[str], args: list[Any], condicion: str, valor: Any) -> None:
    args.append(valor)
    condiciones.append(condicion.replace("{n}", f"${len(args)}"))


async def listar_comprobantes(
    perfil: PerfilTraslados,
    *,
    punto_id: str | None,
    estado: str | None,
    tipo: str | None,
    q: str | None,
    limit: int,
    offset: int,
) -> dict:
    """Comprobantes (uno por fila) con filtros; un perfil limitado a un punto
    siempre queda acotado a ese punto. `q` busca por numero o nombre de archivo."""
    pool = await get_pool()
    condiciones: list[str] = []
    args: list[Any] = []
    if perfil.punto_id is not None:
        _filtros(condiciones, args, "c.punto_id = {n}::uuid", perfil.punto_id)
    if punto_id is not None:
        _filtros(condiciones, args, "c.punto_id = {n}::uuid", punto_id)
    if estado is not None:
        _filtros(condiciones, args, "c.estado = {n}", estado)
    if tipo is not None:
        _filtros(condiciones, args, "c.tipo = {n}", tipo)
    if q and q.strip():
        _filtros(
            condiciones, args, "(c.numero ilike {n} escape '\\' or t.archivo_nombre ilike {n} escape '\\')",
            f"%{_escapar_like(q.strip())}%",
        )
    donde = (" where " + " and ".join(condiciones)) if condiciones else ""
    desde = "from traslado_comprobantes c join traslados t on t.id = c.traslado_id join puntos p on p.id = c.punto_id"
    filas = await pool.fetch(
        f"""
        select c.*, p.nombre as punto_nombre, p.codigo as punto_codigo, t.archivo_nombre,
               t.pdf_ruta as traslado_pdf_ruta, t.fecha as traslado_fecha, t.concepto as traslado_concepto
        {desde}{donde}
        order by c.creado_at desc, c.id
        limit ${len(args) + 1} offset ${len(args) + 2}
        """,
        *args,
        limit,
        offset,
    )
    total = await pool.fetchval(f"select count(*) {desde}{donde}", *args)
    return {"total": total or 0, "items": [_serializar_comprobante(f) for f in filas]}


async def listar_traslados(
    perfil: PerfilTraslados,
    *,
    estado: str | None,
    punto_id: str | None,
    q: str | None,
    limit: int,
    offset: int,
) -> dict:
    """Traslados (padres) con sus comprobantes incrustados, sin los renglones
    del PDF. `punto_id` filtra por origen, destino o cualquiera de sus
    comprobantes; un perfil de punto solo ve los traslados con comprobantes suyos."""
    pool = await get_pool()
    condiciones: list[str] = []
    args: list[Any] = []
    if perfil.punto_id is not None:
        _filtros(
            condiciones, args,
            "exists (select 1 from traslado_comprobantes cc where cc.traslado_id = t.id and cc.punto_id = {n}::uuid)",
            perfil.punto_id,
        )
    if punto_id is not None:
        _filtros(
            condiciones, args,
            "(t.origen_punto_id = {n}::uuid or t.destino_punto_id = {n}::uuid or exists "
            "(select 1 from traslado_comprobantes cp where cp.traslado_id = t.id and cp.punto_id = {n}::uuid))",
            punto_id,
        )
    if estado is not None:
        _filtros(condiciones, args, "t.estado = {n}", estado)
    if q and q.strip():
        _filtros(
            condiciones, args, "(t.numero ilike {n} escape '\\' or t.archivo_nombre ilike {n} escape '\\')",
            f"%{_escapar_like(q.strip())}%",
        )
    donde = (" where " + " and ".join(condiciones)) if condiciones else ""
    filas = await pool.fetch(
        f"{_SQL_TRASLADO}{donde} order by t.creado_at desc, t.id limit ${len(args) + 1} offset ${len(args) + 2}",
        *args,
        limit,
        offset,
    )
    total = await pool.fetchval(f"select count(*) from traslados t{donde}", *args)
    comprobantes = await _comprobantes_de(pool, [str(f["id"]) for f in filas], perfil) if filas else []
    por_traslado: dict[str, list[dict]] = {}
    for c in comprobantes:
        por_traslado.setdefault(str(c["traslado_id"]), []).append(_serializar_comprobante(c))
    return {
        "total": total or 0,
        "items": [_serializar_traslado(f, por_traslado.get(str(f["id"]), [])) for f in filas],
    }


# ---------------------------------------------------------------------------
# Borrador: editar y enviar
# ---------------------------------------------------------------------------


async def _traslado_para_modificar(conn, traslado_id: str) -> Any:
    fila = await conn.fetchrow("select * from traslados where id = $1::uuid for update", traslado_id)
    if fila is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    return fila


async def _recargar_traslado(perfil: PerfilTraslados, traslado_id: str) -> dict:
    return await detalle_traslado(perfil, traslado_id)


async def editar_borrador(perfil: PerfilTraslados, traslado_id: str, cambios: dict) -> dict:
    """Completa o corrige un traslado en borrador. `cambios` solo trae las
    claves a modificar (numero, origen_punto_id, destino_punto_id, fecha,
    concepto); un valor None borra el dato. Recalcula las advertencias
    bloqueantes con lo que quede."""
    _exigir_gestion(perfil)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            fila = await _traslado_para_modificar(conn, traslado_id)
            if fila["estado"] != "borrador":
                raise EstadoNoPermitido("Solo se puede editar un traslado en borrador")
            asignaciones: dict[str, Any] = {}
            if "numero" in cambios:
                asignaciones["numero"] = normalizar_numero(cambios["numero"])
            for clave in ("origen_punto_id", "destino_punto_id"):
                if clave in cambios:
                    await _punto_activo(conn, cambios[clave], campo="punto de " + clave.split("_")[0])
                    asignaciones[clave] = cambios[clave]
            if "fecha" in cambios:
                asignaciones["fecha"] = cambios["fecha"]
            if "concepto" in cambios:
                asignaciones["concepto"] = _limpiar_texto(cambios["concepto"], 300, "El concepto")

            numero = asignaciones["numero"] if "numero" in asignaciones else fila["numero"]
            origen_id = asignaciones.get("origen_punto_id", _s(fila["origen_punto_id"]))
            destino_id = asignaciones.get("destino_punto_id", _s(fila["destino_punto_id"]))
            evaluacion = evaluar_traslado(
                numero, await _punto_por_id(conn, origen_id), await _punto_por_id(conn, destino_id)
            )
            asignaciones["advertencias"] = fusionar_advertencias(list(fila["advertencias"] or []), evaluacion.bloqueantes)
            columnas = ", ".join(
                f"{col} = ${i}" + ("::uuid" if col.endswith("_punto_id") else "")
                + ("::jsonb" if col == "advertencias" else "")
                for i, col in enumerate(asignaciones, start=2)
            )
            await conn.fetchrow(
                f"update traslados set {columnas}, actualizado_at = now() where id = $1::uuid returning *",
                traslado_id,
                *asignaciones.values(),
            )
    await _evento(
        EventoLog.TRASLADO_EDITADO,
        "traslado",
        traslado_id,
        perfil,
        "ok",
        {k: (str(v) if not isinstance(v, (list, type(None))) else v) for k, v in asignaciones.items() if k != "advertencias"},
    )
    return await _recargar_traslado(perfil, traslado_id)


async def enviar(perfil: PerfilTraslados, traslado_id: str) -> dict:
    """Envia un borrador completo: crea sus comprobantes y lo pasa a 'enviado'.
    NoSePuedeEnviar (con las advertencias) si falta algo; ComprobanteDuplicado
    si ese numero ya existe para algun lado."""
    _exigir_gestion(perfil)
    pool = await get_pool()
    comprobantes: list[Any] = []
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                fila = await _traslado_para_modificar(conn, traslado_id)
                if fila["estado"] != "borrador":
                    raise EstadoNoPermitido("Este traslado ya fue enviado")
                origen = await _punto_por_id(conn, fila["origen_punto_id"])
                destino = await _punto_por_id(conn, fila["destino_punto_id"])
                evaluacion = evaluar_traslado(fila["numero"], origen, destino)
                if evaluacion.bloqueantes:
                    raise NoSePuedeEnviar(evaluacion.bloqueantes)
                existente = await _buscar_existente(conn, fila["numero"], evaluacion.comprobantes)
                if existente is not None:
                    raise ComprobanteDuplicado(
                        f"El comprobante de {existente['tipo']} {existente['numero']} de "
                        f"{existente['punto_nombre']} ya existe",
                        existente["id"],
                    )
                for c in evaluacion.comprobantes:
                    comprobantes.append(
                        await conn.fetchrow(_SQL_INSERTAR_COMPROBANTE, traslado_id, fila["numero"], c.tipo, c.punto_id)
                    )
                await conn.fetchrow(
                    """
                    update traslados set
                    estado = 'enviado', enviado_at = now(), actualizado_at = now(), advertencias = $2::jsonb
                    where id = $1::uuid returning *
                    """,
                    traslado_id,
                    fusionar_advertencias(list(fila["advertencias"] or []), []),
                )
    except asyncpg.UniqueViolationError as exc:
        if exc.constraint_name != _UNICO_COMPROBANTE:
            raise
        raise ComprobanteDuplicado("Ese número ya tiene comprobantes cargados para el mismo punto") from exc
    await _evento(
        EventoLog.TRASLADO_ENVIADO, "traslado", traslado_id, perfil, "ok",
        {"numero": fila["numero"], "comprobantes": [str(c["id"]) for c in comprobantes]},
    )
    for c in comprobantes:
        await _evento(
            EventoLog.TRASLADO_COMPROBANTE_CREADO, "traslado_comprobante", str(c["id"]), perfil, "ok",
            {"numero": c["numero"], "tipo": c["tipo"]}, sede_id=str(c["punto_id"]),
        )
    return await _recargar_traslado(perfil, traslado_id)


# ---------------------------------------------------------------------------
# Resolucion de un comprobante
# ---------------------------------------------------------------------------


async def _anotar_archivo(pool, traslado_id: Any, ruta: str) -> None:
    """Registra la ruta subida en traslados.archivos (para el borrado definitivo)."""
    await pool.execute(
        "update traslados set archivos = archivos || $2::jsonb, actualizado_at = now() where id = $1::uuid",
        str(traslado_id),
        [ruta],
    )


async def confirmar(perfil: PerfilTraslados, comprobante_id: str, firma: bytes, observacion: str | None) -> dict:
    """El punto del comprobante lo confirma con la firma (imagen obligatoria) y
    una observacion opcional. Responsable = el usuario de la sesion."""
    pool = await get_pool()
    fila = await _comprobante_visible(pool, comprobante_id, perfil)
    autorizar_accion(perfil, "confirmar", fila)
    imagen = detectar_imagen(firma) if firma else None
    if imagen is None:
        raise DatoInvalido("La firma es obligatoria y debe ser una imagen PNG, JPG o WebP")
    if len(firma) > MAX_BYTES_FIRMA:
        raise DatoInvalido(f"La firma supera los {MAX_BYTES_FIRMA // (1024 * 1024)} MB")
    observacion = _limpiar_texto(observacion, MAX_OBSERVACION, "La observación")

    extension, content_type = imagen
    ruta = f"traslados-firmas/{comprobante_id}/{uuid.uuid4().hex}.{extension}"
    await storage_evidencia.subir(ruta, firma, content_type)
    try:
        # Se anota ANTES de cambiar el estado: si algo falla despues, a lo sumo
        # queda una ruta ya borrada en la lista (el borrado definitivo la tolera).
        await _anotar_archivo(pool, fila["traslado_id"], ruta)
        actualizado = await pool.fetchrow(
            """
            update traslado_comprobantes set
                estado = 'confirmado', responsable_usuario_id = $2::uuid, responsable_nombre = $3,
                responsable_cedula = $4, firma_ruta = $5, observacion = $6, motivo_devolucion = null,
                resuelto_at = now(), actualizado_at = now()
            where id = $1::uuid and estado = 'pendiente'
            returning id
            """,
            comprobante_id,
            perfil.usuario["id"],
            perfil.usuario["nombre"],
            perfil.usuario.get("cedula"),
            ruta,
            observacion,
        )
    except Exception:
        await storage_evidencia.borrar(ruta)
        raise
    if actualizado is None:
        await storage_evidencia.borrar(ruta)
        raise EstadoNoPermitido("Otra persona resolvió este comprobante mientras tanto. Recarga la pantalla")
    await _evento(
        EventoLog.TRASLADO_COMPROBANTE_CONFIRMADO, "traslado_comprobante", comprobante_id, perfil, "ok",
        {"numero": fila["numero"], "tipo": fila["tipo"], "firma_ruta": ruta, "observacion": observacion,
         "responsable_cedula": perfil.usuario.get("cedula")},
        sede_id=str(fila["punto_id"]),
    )
    return await detalle_comprobante(perfil, comprobante_id)


async def devolver(perfil: PerfilTraslados, comprobante_id: str, motivo: str | None) -> dict:
    """Devuelve un comprobante con motivo obligatorio: el punto uno pendiente,
    la encargada uno ya confirmado. La firma anterior queda en el log (y en
    Storage), no se borra."""
    pool = await get_pool()
    fila = await _comprobante_visible(pool, comprobante_id, perfil)
    autorizar_accion(perfil, "devolver", fila)
    motivo = _limpiar_texto(motivo, MAX_MOTIVO, "El motivo")
    if motivo is None:
        raise DatoInvalido("El motivo de la devolución es obligatorio")
    actualizado = await pool.fetchrow(
        """
        update traslado_comprobantes set
            estado = 'devuelto', responsable_usuario_id = $2::uuid, responsable_nombre = $3,
            responsable_cedula = $4, firma_ruta = null, observacion = null, motivo_devolucion = $5,
            resuelto_at = now(), actualizado_at = now()
        where id = $1::uuid and estado = $6
        returning id
        """,
        comprobante_id,
        perfil.usuario["id"],
        perfil.usuario["nombre"],
        perfil.usuario.get("cedula"),
        motivo,
        fila["estado"],
    )
    if actualizado is None:
        raise EstadoNoPermitido("Otra persona resolvió este comprobante mientras tanto. Recarga la pantalla")
    await _evento(
        EventoLog.TRASLADO_COMPROBANTE_DEVUELTO, "traslado_comprobante", comprobante_id, perfil, "ok",
        {"numero": fila["numero"], "tipo": fila["tipo"], "motivo": motivo, "estado_anterior": fila["estado"],
         "firma_ruta_anterior": fila["firma_ruta"], "observacion_anterior": fila["observacion"]},
        sede_id=str(fila["punto_id"]),
    )
    return await detalle_comprobante(perfil, comprobante_id)


async def reenviar(
    perfil: PerfilTraslados,
    comprobante_id: str,
    *,
    numero: str | None = None,
    punto_id: str | None = None,
    pdf: bytes | None = None,
    pdf_nombre: str | None = None,
) -> dict:
    """La encargada corrige un comprobante devuelto (numero, punto y/o PDF) y
    lo regresa a 'pendiente'. El PDF reemplaza al del traslado (los dos
    comprobantes comparten documento); el anterior se conserva en Storage hasta
    el borrado definitivo. Cambiar el punto tambien actualiza el origen o
    destino del traslado."""
    pool = await get_pool()
    fila = await _comprobante_visible(pool, comprobante_id, perfil)
    autorizar_accion(perfil, "reenviar", fila)

    nuevo_numero = normalizar_numero(numero) if numero and numero.strip() else fila["numero"]
    nuevo_punto = str(fila["punto_id"])
    if punto_id:
        punto = await _punto_activo(pool, punto_id)
        if punto["es_interna"]:
            raise DatoInvalido("Un punto interno no firma comprobantes")
        nuevo_punto = punto["id"]
    if pdf is not None:
        _validar_pdf(pdf)

    traslado = await pool.fetchrow("select * from traslados where id = $1::uuid", str(fila["traslado_id"]))
    if traslado is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    campo_punto = "origen_punto_id" if fila["tipo"] == "salida" else "destino_punto_id"
    otro_lado = _s(traslado["destino_punto_id" if fila["tipo"] == "salida" else "origen_punto_id"])
    if nuevo_punto != str(fila["punto_id"]) and nuevo_punto == otro_lado:
        raise DatoInvalido("El origen y el destino no pueden ser el mismo punto")

    ruta_pdf = None
    if pdf is not None:
        ruta_pdf = f"traslados/{fila['traslado_id']}/{uuid.uuid4().hex}.pdf"
        await storage_evidencia.subir(ruta_pdf, pdf, "application/pdf")
    try:
        # Una sola transaccion: o se corrige todo (comprobante, punto y PDF del
        # traslado) o nada.
        async with pool.acquire() as conn:
            async with conn.transaction():
                actualizado = await conn.fetchrow(
                    """
                    update traslado_comprobantes set
                        numero = $2, punto_id = $3::uuid, estado = 'pendiente', responsable_usuario_id = null,
                        responsable_nombre = null, responsable_cedula = null, firma_ruta = null,
                        observacion = null, motivo_devolucion = null, resuelto_at = null, actualizado_at = now()
                    where id = $1::uuid and estado = 'devuelto'
                    returning id
                    """,
                    comprobante_id,
                    nuevo_numero,
                    nuevo_punto,
                )
                if actualizado is not None:
                    if nuevo_punto != str(fila["punto_id"]):
                        await conn.execute(
                            f"update traslados set {campo_punto} = $2::uuid, actualizado_at = now() where id = $1::uuid",
                            str(fila["traslado_id"]),
                            nuevo_punto,
                        )
                    if ruta_pdf is not None:
                        await conn.execute(
                            "update traslados set pdf_ruta = $2, archivo_nombre = $3, "
                            "archivos = archivos || $4::jsonb, actualizado_at = now() where id = $1::uuid",
                            str(fila["traslado_id"]),
                            ruta_pdf,
                            _nombre_archivo(pdf_nombre),
                            [ruta_pdf],
                        )
    except asyncpg.UniqueViolationError as exc:
        if ruta_pdf:
            await storage_evidencia.borrar(ruta_pdf)
        if exc.constraint_name != _UNICO_COMPROBANTE:
            raise
        raise ComprobanteDuplicado(f"Ya existe un comprobante de {fila['tipo']} {nuevo_numero} para ese punto") from exc
    except Exception:
        if ruta_pdf:
            await storage_evidencia.borrar(ruta_pdf)
        raise
    if actualizado is None:
        if ruta_pdf:
            await storage_evidencia.borrar(ruta_pdf)
        raise EstadoNoPermitido("Otra persona modificó este comprobante mientras tanto. Recarga la pantalla")
    await _evento(
        EventoLog.TRASLADO_COMPROBANTE_REENVIADO, "traslado_comprobante", comprobante_id, perfil, "ok",
        {"numero_anterior": fila["numero"], "numero": nuevo_numero, "punto_anterior": str(fila["punto_id"]),
         "punto": nuevo_punto, "pdf_reemplazado": ruta_pdf is not None, "motivo_devolucion": fila["motivo_devolucion"]},
        sede_id=nuevo_punto,
    )
    return await detalle_comprobante(perfil, comprobante_id)


# ---------------------------------------------------------------------------
# Borrado definitivo
# ---------------------------------------------------------------------------


async def eliminar(perfil: PerfilTraslados, traslado_id: str) -> dict:
    """Borra el traslado, sus comprobantes (cascada) y TODOS sus archivos de
    Storage (PDFs y firmas). Los eventos de `logs` se conservan: es append-only."""
    _exigir_gestion(perfil)
    pool = await get_pool()
    fila = await pool.fetchrow(
        "select id, numero, estado, pdf_ruta, archivos from traslados where id = $1::uuid", traslado_id
    )
    if fila is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    comprobantes = await pool.fetch(
        "select id, punto_id, firma_ruta from traslado_comprobantes where traslado_id = $1::uuid", traslado_id
    )
    rutas = {r for r in [fila["pdf_ruta"], *(fila["archivos"] or []), *(c["firma_ruta"] for c in comprobantes)] if r}
    await pool.execute("delete from traslados where id = $1::uuid", traslado_id)
    for ruta in sorted(rutas):
        await storage_evidencia.borrar(ruta)
    await _evento(
        EventoLog.TRASLADO_ELIMINADO, "traslado", traslado_id, perfil, "ok",
        {"numero": fila["numero"], "estado": fila["estado"], "comprobantes": [str(c["id"]) for c in comprobantes],
         "archivos_borrados": len(rutas)},
    )
    return {"ok": True, "archivos_borrados": len(rutas)}
