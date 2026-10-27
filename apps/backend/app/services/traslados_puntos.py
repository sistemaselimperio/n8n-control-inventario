"""Logica de negocio del flujo de traslados entre puntos -- ver el plan
"traslados-entre-puntos". Flujo aparte del pipeline de despachos
(docs/architecture.md): tablas aditivas, no toca entregas/sedes/empleados.
"""

import re
import unicodedata
from datetime import date
from difflib import SequenceMatcher

import asyncpg

from app.config import get_settings
from app.db import get_pool
from app.models.log import EventoLog
from app.models.traslado_punto import (
    LlegadaDirectaCrear,
    RecepcionTraslado,
    SolucionNovedad,
    TrasladoPuntoCrear,
    normalizar_numero_syscafe,
)
from app.services.logging_service import registrar_evento
from app.services.talonarios import (
    TalonarioConflicto,
    TalonarioNoDisponible,
    elegir_por_letra,
    hojas_esperadas,
    parsear_referencia,
    unir_hojas_esperadas,
    validar_y_tomar_hoja,
)
from app.services.vision_talonario import extraer_datos_talonario


class TrasladoInvalido(Exception):
    """Validacion de negocio fallida al crear o recibir un traslado (puntos
    invalidos, firmas faltantes, items que no pertenecen al traslado,
    cantidad recibida por encima de lo enviado, etc.) -- se traduce a 422 en
    el router."""


class TrasladoNoEncontrado(Exception):
    pass


class TrasladoYaRecibido(Exception):
    """El traslado ya no esta 'en_transito' -- alguien mas ya lo recibio
    (ver el update atomico en registrar_recepcion). Se traduce a 409."""


class NovedadNoEncontrada(Exception):
    """No existe un traslado con ese id -- se traduce a 404."""


class NovedadInvalida(Exception):
    """El traslado no tiene novedad para resolver, o el supervisor no existe
    / esta inactivo -- se traduce a 422."""


class NovedadYaResuelta(Exception):
    """La novedad ya estaba en 'resuelta' -- alguien mas (u otra pestaña de
    Erika) ya la resolvio antes (ver el update atomico en resolver_novedad).
    Se traduce a 409, mismo criterio que TrasladoYaRecibido."""


class ConsecutivoDuplicado(Exception):
    """Ya existe una novedad resuelta archivada bajo ese mismo consecutivo
    (indice unico parcial traslados_puntos_consecutivo_solucion_key, ver
    app/db.py) -- se traduce a 409, con un detail distinto del de
    NovedadYaResuelta para que el movil pueda distinguir los dos casos (ver
    esErrorConsecutivoDuplicado en apps/mobile/errorMessages.ts)."""


class SyscafeDuplicado(Exception):
    """Ese numero Syscafe ya esta asignado a otro traslado (indice unico
    parcial traslados_puntos_numero_syscafe_key, ver app/db.py) -- se traduce a
    409; el mensaje nombra la hoja del talonario del otro traslado."""


def _normalizar(texto: str) -> str:
    """Minusculas, sin tildes y sin espacios sobrantes -- para comparar el
    destino leido por la IA contra los puntos registrados."""
    sin_tildes = unicodedata.normalize("NFD", texto or "")
    sin_tildes = "".join(c for c in sin_tildes if unicodedata.category(c) != "Mn")
    sin_tildes = sin_tildes.replace("—", "-").replace("–", "-")
    return re.sub(r"\s+", " ", sin_tildes).strip().lower()


def _nombre_sin_codigo(nombre: str, codigo: str | None) -> str:
    """Nombre del punto sin el prefijo "CODIGO — " (ej. "CFC — La Cumbre" ->
    "la cumbre"); si no tiene ese prefijo devuelve el nombre normalizado."""
    normalizado = _normalizar(nombre)
    for separador in ("—", "–", "-"):
        if separador in nombre:
            prefijo, _, resto = nombre.partition(separador)
            if not codigo or _normalizar(prefijo) == _normalizar(codigo):
                return _normalizar(resto)
    return normalizado


# Parecido minimo (0-1, SequenceMatcher) para aceptar un destino que no
# coincide exacto, y ventaja minima sobre el segundo mejor candidato -- si dos
# puntos se parecen casi igual al texto leido, no se elige ninguno.
_SIMILITUD_MINIMA = 0.8
_VENTAJA_MINIMA = 0.1


def _resolver_destino(texto: str, puntos: list[dict]) -> dict | None:
    """Busca entre `puntos` el que corresponde al destino leido: primero por
    codigo exacto, nombre completo o nombre sin el prefijo de codigo; si nada
    coincide exacto, por parecido (letra a mano, abreviaturas, un error de
    lectura) siempre que haya un unico candidato claro."""
    buscado = _normalizar(texto)
    if not buscado:
        return None
    for p in puntos:
        codigo = _normalizar(p["codigo"] or "")
        if codigo and buscado == codigo:
            return p
        if buscado in (_normalizar(p["nombre"]), _nombre_sin_codigo(p["nombre"], p["codigo"])):
            return p

    puntajes = []
    for p in puntos:
        variantes = {_normalizar(p["nombre"]), _nombre_sin_codigo(p["nombre"], p["codigo"])}
        puntaje = max(SequenceMatcher(None, buscado, v).ratio() for v in variantes if v)
        puntajes.append((puntaje, p))
    puntajes.sort(key=lambda par: par[0], reverse=True)
    if not puntajes or puntajes[0][0] < _SIMILITUD_MINIMA:
        return None
    if len(puntajes) > 1 and puntajes[0][0] - puntajes[1][0] < _VENTAJA_MINIMA:
        return None
    return puntajes[0][1]


def _fecha_iso_valida(texto: str) -> bool:
    try:
        date.fromisoformat(texto)
    except ValueError:
        return False
    return True


async def extraer_talonario(
    foto_url: str, punto_origen_id: str, letra: str | None = None, directo: bool | None = None
) -> dict:
    """Lee la foto del talonario con vision y resuelve el destino contra los
    puntos activos (excluyendo el origen). Devuelve los campos leidos, el
    `punto_destino` ({id, nombre, codigo} o None) y `faltantes`: nombres en
    espanol de lo que no se pudo leer con suficiente certeza -- si no esta
    vacia, la app movil obliga a repetir la foto. Lanza ExtraccionFallida
    (ver app.services.vision) si la IA no pudo procesar la foto.

    El numero de talonario se compara contra la siguiente hoja del talonario
    activo del punto origen cuya letra es la leida (ver app/services/talonarios.py):
    si coincide se devuelve la referencia esperada ("A 6305"); si no, "Número
    de talonario" entra en `faltantes` y `numero_esperado` dice que hoja debe
    fotografiarse (si no se reconocio la letra, las esperadas unidas: "A 6305
    o V 120"). Sin talonario activo (o agotados) lanza TalonarioNoDisponible
    ANTES de llamar a la IA, para no gastar una lectura que no se va a poder usar.

    Con `letra` (la empresa que el operador eligio antes de la foto) solo vale
    el talonario de esa letra: si no tiene hojas lanza TalonarioNoDisponible, y
    una hoja de otra letra cae en `faltantes` igual que un numero equivocado
    (`letra_leida` le dice a la app de que talonario era la foto).

    `llega_directo` dice si la IA leyo "Llega directo" en bodega origen (la app
    preselecciona ese modo). En una llegada directa -- `directo=true` porque el
    operador ya eligio ese modo, o porque la IA lo leyo -- no hay destino ni
    transportador que leer, asi que no entran en `faltantes`."""
    disponibles = await hojas_esperadas(punto_origen_id)
    # A la IA se le pasan todas las letras activas aunque se haya elegido una:
    # si solo viera la elegida podria "corregir" una hoja V a A.
    letras_activas = [t["letra"] for t in disponibles]
    if letra:
        elegido = elegir_por_letra(disponibles, letra.strip())
        if elegido is None:
            raise TalonarioNoDisponible(
                f"El talonario {letra.strip().upper()} no está activo o ya no tiene hojas. Elige otra empresa o configúralo en Inicio."
            )
        disponibles = [elegido]

    # Los puntos se consultan antes de la lectura para mostrarselos al modelo:
    # asi elige el destino entre los registrados en vez de transcribir la
    # letra a mano tal cual (que despues no coincidia con ningun punto).
    pool = await get_pool()
    filas = await pool.fetch(
        "select id, nombre, codigo from puntos where activo = true and id <> $1::uuid", punto_origen_id
    )
    puntos = [{"id": str(f["id"]), "nombre": f["nombre"], "codigo": f["codigo"]} for f in filas]

    extraido = await extraer_datos_talonario(
        foto_url, [p["nombre"] for p in puntos], letras_activas
    )
    umbral = get_settings().min_confidence
    confianza = extraido.get("confianza", {})

    numero = (extraido.get("numero_talonario") or "").strip()
    destino_texto = (extraido.get("destino") or "").strip()
    transportador = (extraido.get("transportador") or "").strip()
    fecha = (extraido.get("fecha") or "").strip()
    # Nombres de producto en mayusculas desde la lectura (igual que al guardar).
    items = [{**i, "producto": (i.get("producto") or "").strip().upper()} for i in (extraido.get("items") or [])]

    # En una sola linea: los saltos y espacios repetidos se colapsan a un espacio.
    texto_libre = " ".join((extraido.get("texto_libre") or "").split())

    llega_directo = bool(extraido.get("llega_directo"))
    es_directo = llega_directo if directo is None else directo
    punto_destino = None if es_directo else _resolver_destino(destino_texto, puntos)

    def _confiable(campo: str) -> bool:
        return confianza.get(campo, 0) >= umbral

    faltantes: list[str] = []
    referencia_leida = parsear_referencia(numero)
    # El talonario se elige por la letra leida; si no hay uno activo con esa
    # letra, el numero no coincide con nada.
    esperada = elegir_por_letra(disponibles, referencia_leida[0] if referencia_leida else None)
    numero_coincide = (
        _confiable("numero_talonario")
        and esperada is not None
        and referencia_leida == (esperada["letra"], esperada["siguiente_numero"])
    )
    if numero_coincide:
        numero = esperada["siguiente_hoja"]
    else:
        faltantes.append("Número de talonario")
    if not es_directo:
        if punto_destino is None or not _confiable("destino"):
            faltantes.append("Destino")
        if not transportador or not _confiable("transportador"):
            faltantes.append("Transportador")
    if not fecha or not _fecha_iso_valida(fecha) or not _confiable("fecha"):
        faltantes.append("Fecha")
    # En llegada directa la hoja puede traer solo texto libre en vez de
    # renglones: basta con uno de los dos. Entre puntos siguen siendo obligatorios.
    if not items and not (es_directo and texto_libre):
        faltantes.append("Productos")

    return {
        "numero_talonario": numero,
        "numero_esperado": esperada["siguiente_hoja"] if esperada is not None else unir_hojas_esperadas(disponibles),
        "hojas_esperadas": [t["siguiente_hoja"] for t in disponibles],
        "letra_leida": referencia_leida[0] if referencia_leida else None,
        "destino": destino_texto,
        "transportador": transportador,
        "fecha": fecha,
        "items": items,
        "texto_libre": texto_libre,
        "llega_directo": llega_directo,
        "confianza": confianza,
        "punto_destino": punto_destino,
        "faltantes": faltantes,
    }


async def crear_traslado(payload: TrasladoPuntoCrear) -> dict:
    if payload.punto_origen_id == payload.punto_destino_id:
        raise TrasladoInvalido("El punto de origen y el de destino no pueden ser el mismo")
    if not payload.firma_despacha_url or not payload.firma_transporta_url:
        raise TrasladoInvalido("Faltan las firmas de quien despacha y/o de quien transporta")

    pool = await get_pool()
    origen = await pool.fetchrow(
        "select id from puntos where id = $1::uuid and activo = true", payload.punto_origen_id
    )
    if origen is None:
        raise TrasladoInvalido("El punto de origen no existe o esta inactivo")
    destino = await pool.fetchrow(
        "select id from puntos where id = $1::uuid and activo = true", payload.punto_destino_id
    )
    if destino is None:
        raise TrasladoInvalido("El punto de destino no existe o esta inactivo")
    creador = await pool.fetchrow(
        "select punto_id from usuarios_punto where id = $1::uuid and estado = 'activo'",
        payload.creado_por,
    )
    if creador is None or str(creador["punto_id"]) != payload.punto_origen_id:
        raise TrasladoInvalido("Quien despacha debe pertenecer al punto de origen")

    async with pool.acquire() as conn:
        async with conn.transaction():
            # La hoja se valida y se toma con lock sobre el talonario activo:
            # si otra persona del mismo punto guardo primero, esta cae al 409
            # con la hoja que toca fotografiar ahora.
            talonario_id, numero_talonario = await validar_y_tomar_hoja(
                conn, payload.punto_origen_id, payload.numero_talonario
            )
            try:
                fila = await conn.fetchrow(
                    """
                    insert into traslados_puntos (
                        id, punto_origen_id, punto_destino_id, transportador_nombre,
                        fecha, observaciones, firma_despacha_url, firma_transporta_url, creado_por,
                        numero_talonario, foto_talonario_url, talonario_id
                    )
                    values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12::uuid)
                    returning *
                    """,
                    payload.id,
                    payload.punto_origen_id,
                    payload.punto_destino_id,
                    payload.transportador_nombre,
                    payload.fecha,
                    payload.observaciones,
                    payload.firma_despacha_url,
                    payload.firma_transporta_url,
                    payload.creado_por,
                    numero_talonario,
                    payload.foto_talonario_url,
                    talonario_id,
                )
            except asyncpg.UniqueViolationError as exc:
                if exc.constraint_name == "traslados_puntos_talonario_hoja_key":
                    raise TalonarioConflicto(
                        "Esa hoja ya se usó. Vuelve a cargar el talonario y toma la foto de la hoja que sigue."
                    ) from exc
                # id repetido (ya generado y enviado antes -- ej. reintento
                # tras un timeout de red) -- no deberia pasar en uso normal
                # (uuid del celular), pero falla con un mensaje claro en vez
                # de un 500 crudo.
                raise TrasladoInvalido("Ya existe un traslado con ese id") from exc

            items = []
            for item in payload.items:
                fila_item = await conn.fetchrow(
                    """
                    insert into traslado_punto_items (
                        traslado_id, cantidad, producto, marca, presentacion, fecha_vencimiento
                    )
                    values ($1::uuid, $2, $3, $4, $5, $6)
                    returning *
                    """,
                    payload.id,
                    item.cantidad,
                    item.producto,
                    item.marca,
                    item.presentacion,
                    item.fecha_vencimiento,
                )
                items.append(dict(fila_item))

    await registrar_evento(
        EventoLog.TRASLADO_PUNTO_CREADO,
        entidad_tipo="traslado_punto",
        entidad_id=payload.id,
        actor_id=payload.creado_por,
        sede_id=payload.punto_origen_id,
        resultado="ok",
        detalle={"punto_destino_id": payload.punto_destino_id, "cantidad_items": len(items)},
    )

    resultado = dict(fila)
    resultado["items"] = items
    return resultado


async def crear_llegada_directa(payload: LlegadaDirectaCrear) -> dict:
    """Registra mercancia que llega directo del proveedor al punto: la crea el
    propio punto que recibe, consume una hoja de SU talonario (mismo control
    antiduplicado que crear_traslado) y nace ya recibida -- sin en_transito ni
    bandeja. Una novedad opcional la deja en 'recibido_con_novedad' con
    novedad_estado='pendiente', para que entre al flujo de Supervision. No se
    guardan datos del proveedor: el unico numero es el de la hoja."""
    if not payload.declaracion_aceptada:
        raise TrasladoInvalido("Quien recibe debe aceptar la declaración antes de firmar")
    if not payload.firma_recibe_url:
        raise TrasladoInvalido("Falta la firma de quien recibe")

    pool = await get_pool()
    punto = await pool.fetchrow("select id from puntos where id = $1::uuid and activo = true", payload.punto_id)
    if punto is None:
        raise TrasladoInvalido("El punto no existe o esta inactivo")
    creador = await pool.fetchrow(
        "select punto_id from usuarios_punto where id = $1::uuid and estado = 'activo'",
        payload.creado_por,
    )
    if creador is None or str(creador["punto_id"]) != payload.punto_id:
        raise TrasladoInvalido("Quien recibe debe pertenecer al punto")

    contenido_texto = " ".join((payload.contenido_texto or "").split()) or None
    if not payload.items and contenido_texto is None:
        raise TrasladoInvalido("La hoja debe traer al menos un producto o el contenido en texto")

    novedad = (payload.novedad or "").strip() or None
    estado = "recibido_con_novedad" if novedad else "recibido"
    novedad_estado = "pendiente" if novedad else None

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Misma toma de hoja con lock que crear_traslado, pero sobre el
            # talonario del punto que recibe.
            talonario_id, numero_talonario = await validar_y_tomar_hoja(
                conn, payload.punto_id, payload.numero_talonario
            )
            try:
                fila = await conn.fetchrow(
                    """
                    insert into traslados_puntos (
                        id, tipo, punto_origen_id, punto_destino_id, fecha, firma_recibe_url,
                        creado_por, recibido_por, recibido_at, declaracion_aceptada_at,
                        estado, novedad, novedad_estado,
                        numero_talonario, foto_talonario_url, talonario_id, contenido_texto
                    )
                    values (
                        $1::uuid, 'directo', null, $2::uuid, coalesce($3::date, current_date), $4,
                        $5::uuid, $5::uuid, now(), now(),
                        $6, $7, $8,
                        $9, $10, $11::uuid, $12
                    )
                    returning *
                    """,
                    payload.id,
                    payload.punto_id,
                    payload.fecha,
                    payload.firma_recibe_url,
                    payload.creado_por,
                    estado,
                    novedad,
                    novedad_estado,
                    numero_talonario,
                    payload.foto_talonario_url,
                    talonario_id,
                    contenido_texto,
                )
            except asyncpg.UniqueViolationError as exc:
                if exc.constraint_name == "traslados_puntos_talonario_hoja_key":
                    raise TalonarioConflicto(
                        "Esa hoja ya se usó. Vuelve a cargar el talonario y toma la foto de la hoja que sigue."
                    ) from exc
                raise TrasladoInvalido("Ya existe un traslado con ese id") from exc

            items = []
            for item in payload.items:
                # Llega directo: lo recibido es lo que dice la hoja.
                fila_item = await conn.fetchrow(
                    """
                    insert into traslado_punto_items (
                        traslado_id, cantidad, producto, marca, presentacion, fecha_vencimiento,
                        cantidad_recibida
                    )
                    values ($1::uuid, $2, $3, $4, $5, $6, $2)
                    returning *
                    """,
                    payload.id,
                    item.cantidad,
                    item.producto,
                    item.marca,
                    item.presentacion,
                    item.fecha_vencimiento,
                )
                items.append(dict(fila_item))

    await registrar_evento(
        EventoLog.LLEGADA_DIRECTA_REGISTRADA,
        entidad_tipo="traslado_punto",
        entidad_id=payload.id,
        actor_id=payload.creado_por,
        sede_id=payload.punto_id,
        resultado=estado,
        detalle={"cantidad_items": len(items), "novedad": novedad},
    )

    resultado = dict(fila)
    resultado["items"] = items
    return resultado


async def registrar_recepcion(traslado_id: str, payload: RecepcionTraslado) -> dict:
    pool = await get_pool()

    traslado = await pool.fetchrow("select * from traslados_puntos where id = $1::uuid", traslado_id)
    if traslado is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")

    items_actuales = await pool.fetch(
        "select * from traslado_punto_items where traslado_id = $1::uuid", traslado_id
    )
    items_por_id = {str(i["id"]): i for i in items_actuales}

    for item_recibido in payload.items:
        actual = items_por_id.get(item_recibido.id)
        if actual is None:
            raise TrasladoInvalido(f"El item {item_recibido.id} no pertenece a este traslado")
        if item_recibido.cantidad_recibida > actual["cantidad"]:
            raise TrasladoInvalido(
                f"No se puede recibir mas de lo enviado ({actual['cantidad']}) de '{actual['producto']}'"
            )

    # Con novedad si falto cantidad en alguna linea, o si se cargo una
    # novedad (general o por item) -- ver EstadoTrasladoPunto.
    tiene_novedad = bool((payload.novedad or "").strip()) or any(
        item.cantidad_recibida < items_por_id[item.id]["cantidad"] or bool((item.novedad or "").strip())
        for item in payload.items
    )
    nuevo_estado = "recibido_con_novedad" if tiene_novedad else "recibido"

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Update atomico guardado por estado='en_transito': si dos
            # personas confirman la recepcion casi al mismo tiempo (o el
            # mismo dispositivo reintenta tras un timeout), solo la primera
            # actualiza algo -- la segunda no encuentra fila y cae al 409 de
            # abajo, sin tocar los items.
            actualizado = await conn.fetchrow(
                """
                update traslados_puntos
                set estado = $2, recibido_por = $3::uuid, recibido_at = now(),
                    novedad = $4, firma_recibe_url = $5,
                    declaracion_aceptada_at = case when $6 then now() else declaracion_aceptada_at end,
                    novedad_estado = case when $2 = 'recibido_con_novedad' then 'pendiente' else novedad_estado end
                where id = $1::uuid and estado = 'en_transito'
                returning *
                """,
                traslado_id,
                nuevo_estado,
                payload.recibido_por,
                payload.novedad,
                payload.firma_recibe_url,
                payload.declaracion_aceptada,
            )
            if actualizado is None:
                raise TrasladoYaRecibido("Este traslado ya fue recibido")

            items_actualizados = []
            for item_recibido in payload.items:
                fila_item = await conn.fetchrow(
                    """
                    update traslado_punto_items
                    set cantidad_recibida = $2, novedad = $3
                    where id = $1::uuid
                    returning *
                    """,
                    item_recibido.id,
                    item_recibido.cantidad_recibida,
                    item_recibido.novedad,
                )
                items_actualizados.append(dict(fila_item))

    await registrar_evento(
        EventoLog.TRASLADO_PUNTO_RECIBIDO,
        entidad_tipo="traslado_punto",
        entidad_id=traslado_id,
        actor_id=payload.recibido_por,
        sede_id=str(traslado["punto_destino_id"]),
        resultado=nuevo_estado,
        detalle={"declaracion_aceptada": payload.declaracion_aceptada},
    )
    if nuevo_estado == "recibido_con_novedad":
        await registrar_evento(
            EventoLog.TRASLADO_PUNTO_NOVEDAD,
            entidad_tipo="traslado_punto",
            entidad_id=traslado_id,
            actor_id=payload.recibido_por,
            sede_id=str(traslado["punto_destino_id"]),
            resultado="ok",
            detalle={"novedad": payload.novedad},
        )

    resultado = dict(actualizado)
    resultado["items"] = items_actualizados
    return resultado


async def resolver_novedad(traslado_id: str, payload: SolucionNovedad) -> dict:
    """Supervision (Erika) carga la solucion de una novedad ya registrada por
    registrar_recepcion. No valida contra los items -- la novedad puede ser
    tanto una diferencia de cantidad como algo cualitativo (ver
    registrar_recepcion), la solucion es texto libre en cualquier caso."""
    pool = await get_pool()

    traslado = await pool.fetchrow("select * from traslados_puntos where id = $1::uuid", traslado_id)
    if traslado is None:
        raise NovedadNoEncontrada("Traslado no encontrado")
    if traslado["novedad_estado"] is None:
        raise NovedadInvalida("Este traslado no tiene una novedad para resolver")

    supervisor = await pool.fetchrow(
        "select id from supervisores where id = $1::uuid and estado = 'activo'", payload.supervisor_id
    )
    if supervisor is None:
        raise NovedadInvalida("Supervisor invalido o inactivo")

    # El codigo ya viene normalizado a mayusculas (ver _consecutivo_codigo_valido
    # en SolucionNovedad) -- aca se valida que exista de verdad y este activo,
    # cosa que el validador de pydantic no puede hacer (no tiene el pool async).
    punto_consecutivo = await pool.fetchrow(
        "select id from puntos where codigo = $1 and activo = true", payload.consecutivo_codigo
    )
    if punto_consecutivo is None:
        raise NovedadInvalida("El código de punto del consecutivo no es válido")

    consecutivo_solucion = f"{payload.consecutivo_codigo}-{payload.consecutivo_numero}"

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Update atomico guardado por novedad_estado='pendiente' --
            # mismo criterio que el guard estado='en_transito' de
            # registrar_recepcion: si dos supervisores (o dos pestañas de la
            # misma) resuelven casi al mismo tiempo, solo la primera
            # actualiza algo, la segunda cae al 409 de abajo. El
            # UniqueViolationError del indice parcial sobre
            # consecutivo_solucion es un conflicto aparte (mismo consecutivo
            # ya usado por OTRA novedad) -- se traduce a un 409 distinto.
            try:
                actualizado = await conn.fetchrow(
                    """
                    update traslados_puntos
                    set novedad_estado = 'resuelta', solucion = $2, solucionado_por = $3::uuid,
                        solucionado_at = now(), consecutivo_solucion = $4
                    where id = $1::uuid and novedad_estado = 'pendiente'
                    returning *
                    """,
                    traslado_id,
                    payload.solucion,
                    payload.supervisor_id,
                    consecutivo_solucion,
                )
            except asyncpg.UniqueViolationError as exc:
                raise ConsecutivoDuplicado("Ese consecutivo ya está registrado") from exc
            if actualizado is None:
                raise NovedadYaResuelta("Esta novedad ya fue resuelta")

            items = await conn.fetch(
                "select * from traslado_punto_items where traslado_id = $1::uuid order by id", traslado_id
            )

    await registrar_evento(
        EventoLog.TRASLADO_PUNTO_NOVEDAD_RESUELTA,
        entidad_tipo="traslado_punto",
        entidad_id=traslado_id,
        actor_id=payload.supervisor_id,
        sede_id=str(traslado["punto_destino_id"]),
        resultado="ok",
    )

    resultado = dict(actualizado)
    resultado["items"] = [dict(i) for i in items]
    return resultado


async def asignar_numero_syscafe(traslado_id: str, valor: str | None, por: str | None = None) -> dict:
    """Guarda (o borra, si `valor` es None o vacio) el numero Syscafe de un
    traslado, en cualquier estado. Se normaliza aca tambien (ver
    normalizar_numero_syscafe). Sin auditoria en logs, a proposito; si queda
    registro de quien y cuando (`por` es el nombre para mostrar) para el feed
    de actividad -- tambien al borrar el valor."""
    valor = normalizar_numero_syscafe(valor)
    pool = await get_pool()
    try:
        actualizado = await pool.fetchrow(
            "update traslados_puntos set numero_syscafe = $2, numero_syscafe_at = now(),"
            " numero_syscafe_por = $3 where id = $1::uuid returning *",
            traslado_id,
            valor,
            por,
        )
    except asyncpg.UniqueViolationError as exc:
        otro = await pool.fetchrow(
            "select numero_talonario, talonario_id, consecutivo from traslados_puntos"
            " where numero_syscafe = $1 and id <> $2::uuid",
            valor,
            traslado_id,
        )
        if otro is not None and otro["talonario_id"] and otro["numero_talonario"]:
            referencia = otro["numero_talonario"]
        elif otro is not None:
            referencia = f"TP-{otro['consecutivo']:06d}"
        else:
            referencia = "otro traslado"
        raise SyscafeDuplicado(f"El número Syscafe {valor} ya está asignado al traslado {referencia}") from exc
    if actualizado is None:
        raise TrasladoNoEncontrado("Traslado no encontrado")
    items = await pool.fetch(
        "select * from traslado_punto_items where traslado_id = $1::uuid order by id", traslado_id
    )
    resultado = dict(actualizado)
    resultado["items"] = [dict(i) for i in items]
    return resultado


async def validar_supervisor_activo(supervisor_id: str) -> str:
    """Misma validacion de confianza que resolver_novedad: el supervisor tiene
    que existir y estar activo. Lanza TrasladoInvalido si no; devuelve su nombre."""
    pool = await get_pool()
    try:
        fila = await pool.fetchrow(
            "select id, nombre from supervisores where id = $1::uuid and estado = 'activo'", supervisor_id
        )
    except asyncpg.DataError:
        fila = None
    if fila is None:
        raise TrasladoInvalido("Supervisor invalido o inactivo")
    return fila["nombre"]


async def listar_traslados_syscafe(
    punto_id: str | None, pendientes: bool, desde: date | None = None, hasta: date | None = None
) -> list[dict]:
    """Lista de Supervision: traslados (con su numero Syscafe) mas las hojas
    anuladas de los talonarios, tipo "traslado" | "anulada". Pendientes
    (traslados sin numero Syscafe) primero, luego lo mas reciente. Las anuladas
    no tienen campo Syscafe, asi que `pendientes=true` las excluye. `desde`/`hasta`
    (inclusivos) filtran por t.fecha en los traslados y por la fecha de
    creacion en las anuladas."""
    pool = await get_pool()
    # En una llegada directa no hay origen: la hoja es del punto que recibe.
    filtro_t = (
        "where ($1::uuid is null or coalesce(t.punto_origen_id, t.punto_destino_id) = $1::uuid)"
        " and ($2::date is null or t.fecha >= $2::date) and ($3::date is null or t.fecha <= $3::date)"
    )
    filtro_a = (
        "where ($1::uuid is null or tp.punto_id = $1::uuid)"
        " and ($2::date is null or a.created_at::date >= $2::date)"
        " and ($3::date is null or a.created_at::date <= $3::date)"
    )
    if pendientes:
        filtro_t += " and t.numero_syscafe is null"
        anuladas = ""
    else:
        anuladas = f"""
            union all
            select 'anulada' as tipo, a.id, null::bigint as consecutivo,
                tp.letra || ' ' || a.numero as numero_talonario, tp.id as talonario_id,
                null::text as numero_syscafe, tp.punto_id as punto_origen_id,
                po.nombre as punto_origen_nombre, null::uuid as punto_destino_id,
                null::text as punto_destino_nombre, 'anulada' as estado,
                a.created_at::date as fecha, a.created_at, a.motivo, ua.nombre as anulado_por_nombre,
                null::text as tipo_traslado
            from talonario_hojas_anuladas a
            join talonarios_punto tp on tp.id = a.talonario_id
            left join puntos po on po.id = tp.punto_id
            left join usuarios_punto ua on ua.id = a.anulado_por
            {filtro_a}
        """
    filas = await pool.fetch(
        f"""
        select * from (
            select 'traslado' as tipo, t.id, t.consecutivo, t.numero_talonario, t.talonario_id,
                t.numero_syscafe, t.punto_origen_id, po.nombre as punto_origen_nombre,
                t.punto_destino_id, pd.nombre as punto_destino_nombre, t.estado, t.fecha,
                t.created_at, null::text as motivo, null::text as anulado_por_nombre,
                t.tipo as tipo_traslado
            from traslados_puntos t
            left join puntos po on po.id = t.punto_origen_id
            left join puntos pd on pd.id = t.punto_destino_id
            {filtro_t}
            {anuladas}
        ) x
        order by (x.tipo = 'traslado' and x.numero_syscafe is null) desc, x.created_at desc
        limit 500
        """,
        punto_id,
        desde,
        hasta,
    )
    resultado = []
    for fila in filas:
        item = dict(fila)
        for campo in ("id", "talonario_id", "punto_origen_id", "punto_destino_id"):
            if item.get(campo) is not None:
                item[campo] = str(item[campo])
        resultado.append(item)
    return resultado


async def listar_historial(traslado_id: str) -> list[dict]:
    """Historial de un traslado para el expediente del dashboard: solo los
    eventos que hizo el punto (creacion, recepcion y novedad), del mas antiguo
    al mas reciente, con el nombre de quien los hizo y del punto. Sale de `logs`
    (append-only), no de columnas del traslado."""
    pool = await get_pool()
    filas = await pool.fetch(
        """
        select l.evento, l."timestamp" as momento, l.resultado, l.detalle,
            u.nombre as actor_nombre, p.nombre as punto_nombre
        from logs l
        left join usuarios_punto u on u.id::text = l.actor_id
        left join puntos p on p.id::text = l.sede_id
        where l.entidad_tipo = 'traslado_punto' and l.entidad_id = $1
            and l.evento in ($2, $3, $4, $5)
        order by l."timestamp" asc
        """,
        traslado_id,
        EventoLog.TRASLADO_PUNTO_CREADO.value,
        EventoLog.TRASLADO_PUNTO_RECIBIDO.value,
        EventoLog.TRASLADO_PUNTO_NOVEDAD.value,
        EventoLog.LLEGADA_DIRECTA_REGISTRADA.value,
    )
    return [dict(fila) for fila in filas]


async def listar_actividad(limite: int = 50) -> list[dict]:
    """Feed de actividad del panel de traslados, lo mas reciente primero, en
    lenguaje simple. Se deriva de timestamps que ya existen (envio, recepcion,
    solucion de novedad, hojas anuladas y asignacion de Syscafe), sin tabla
    propia. Cada rama trae a lo sumo `limite` filas; el recorte final es global."""
    pool = await get_pool()
    ref = (
        "case when t.talonario_id is not null and t.numero_talonario is not null"
        " then t.numero_talonario else 'TP-' || lpad(t.consecutivo::text, 6, '0') end"
    )
    filas = await pool.fetch(
        f"""
        select * from (
            (select 'envio' as tipo, t.created_at as momento, t.id as traslado_id, {ref} as referencia,
                po.nombre as origen, pd.nombre as destino, null::text as actor, null::text as detalle,
                t.estado, t.tipo as tipo_traslado
            from traslados_puntos t
            left join puntos po on po.id = t.punto_origen_id
            left join puntos pd on pd.id = t.punto_destino_id
            order by t.created_at desc limit $1)
            union all
            (select 'recepcion', t.recibido_at, t.id, {ref}, po.nombre, pd.nombre, ur.nombre, null, t.estado,
                t.tipo
            from traslados_puntos t
            left join puntos po on po.id = t.punto_origen_id
            left join puntos pd on pd.id = t.punto_destino_id
            left join usuarios_punto ur on ur.id = t.recibido_por
            -- La llegada directa ya cuenta como 'envio' (nace recibida): sin fila doble.
            where t.recibido_at is not null and t.tipo <> 'directo'
            order by t.recibido_at desc limit $1)
            union all
            (select 'solucion', t.solucionado_at, t.id, {ref}, po.nombre, pd.nombre, s.nombre,
                t.consecutivo_solucion, t.estado, t.tipo
            from traslados_puntos t
            left join puntos po on po.id = t.punto_origen_id
            left join puntos pd on pd.id = t.punto_destino_id
            left join supervisores s on s.id = t.solucionado_por
            where t.solucionado_at is not null
            order by t.solucionado_at desc limit $1)
            union all
            (select 'syscafe', t.numero_syscafe_at, t.id, {ref}, po.nombre, pd.nombre, t.numero_syscafe_por,
                t.numero_syscafe, t.estado, t.tipo
            from traslados_puntos t
            left join puntos po on po.id = t.punto_origen_id
            left join puntos pd on pd.id = t.punto_destino_id
            where t.numero_syscafe_at is not null
            order by t.numero_syscafe_at desc limit $1)
            union all
            (select 'anulada', a.created_at, null::uuid, tp.letra || ' ' || a.numero, po.nombre, null,
                ua.nombre, a.motivo, 'anulada', null
            from talonario_hojas_anuladas a
            join talonarios_punto tp on tp.id = a.talonario_id
            left join puntos po on po.id = tp.punto_id
            left join usuarios_punto ua on ua.id = a.anulado_por
            order by a.created_at desc limit $1)
        ) x
        order by x.momento desc
        limit $1
        """,
        limite,
    )
    resultado = []
    for f in filas:
        origen = f["origen"] or "—"
        destino = f["destino"] or "—"
        ref_txt = f["referencia"]
        if f["tipo"] == "envio" and f["tipo_traslado"] == "directo":
            con_novedad = f["estado"] == "recibido_con_novedad"
            texto = f"{destino} registró la llegada directa {ref_txt}" + (" con novedad" if con_novedad else "")
        elif f["tipo"] == "envio":
            texto = f"{origen} envió {ref_txt} a {destino}"
        elif f["tipo"] == "recepcion":
            con_novedad = f["estado"] == "recibido_con_novedad"
            texto = f"{destino} recibió {ref_txt}" + (" con novedad" if con_novedad else "")
        elif f["tipo"] == "solucion":
            consecutivo = f" ({f['detalle']})" if f["detalle"] else ""
            texto = f"Supervisión resolvió la novedad de {ref_txt}{consecutivo}"
        elif f["tipo"] == "syscafe":
            quien = f["actor"] or "Supervisión"
            if f["detalle"]:
                texto = f"{quien} asignó Syscafe {f['detalle']} a {ref_txt}"
            else:
                texto = f"{quien} quitó el Syscafe de {ref_txt}"
        else:
            motivo = f": {f['detalle']}" if f["detalle"] else ""
            texto = f"Se anuló la hoja {ref_txt} de {origen}{motivo}"
        resultado.append(
            {
                "tipo": f["tipo"],
                "momento": f["momento"].isoformat(),
                "texto": texto,
                "traslado_id": str(f["traslado_id"]) if f["traslado_id"] else None,
            }
        )
    return resultado
