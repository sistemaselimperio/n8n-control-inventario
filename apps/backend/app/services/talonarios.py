"""Talonario por punto: cada punto trabaja con UN talonario activo por letra (50
hojas fijas, letra + rango de numeros; p. ej. "A" general y "V" veterinaria en
paralelo) y cada traslado consume la "siguiente
hoja" en orden -- ver el flujo de traslados en app/services/traslados_puntos.py.

Siguiente hoja = el menor numero del rango que no uso ningun traslado de ese
talonario y no esta anulado. Quedan = cuantas hojas del rango siguen asi.
Todas las escrituras van en transaccion y toman `select ... for update` sobre
la fila del talonario activo de la letra, asi crear un traslado, anular una hoja y cambiar
de talonario se serializan entre si.
"""

import re

import asyncpg

from app.db import get_pool
from app.models.log import EventoLog
from app.models.talonario import HOJAS_POR_TALONARIO, HojaAnular, TalonarioConfigurar
from app.services.logging_service import registrar_evento

# Con cuantas hojas restantes la app empieza a avisar "Pide un talonario".
UMBRAL_AVISO = 5


class TalonarioInvalido(Exception):
    """Dato o precondicion invalida al configurar/anular (usuario de otro
    punto, motivo faltante, sin talonario activo, etc.) -- se traduce a 422."""


class TalonarioNoDisponible(Exception):
    """El punto no tiene talonario activo o ya se agoto -- hay que
    configurar uno antes de seguir. Se traduce a 409."""


class TalonarioConflicto(Exception):
    """Choque de concurrencia o de hoja (otro usuario configuro/uso la hoja
    antes). Se traduce a 409."""


def formatear_hoja(letra: str, numero: int) -> str:
    return f"{letra} {numero}"


def parsear_referencia(texto: str | None) -> tuple[str, int] | None:
    """Normaliza una referencia de hoja leida o tipeada ("A6305", "a-6305",
    "A 6305") a (letra mayuscula, numero). None si no tiene ese formato."""
    coincidencia = re.fullmatch(r"\s*([A-Za-z]{1,3})[\s\-]*(\d{1,7})\s*", texto or "")
    if coincidencia is None:
        return None
    return coincidencia.group(1).upper(), int(coincidencia.group(2))


async def _estado(conn, talonario) -> dict:
    """Arma la vista de un talonario (fila de talonarios_punto) con la
    siguiente hoja, cuantas quedan y las usadas/anuladas."""
    letra = talonario["letra"]
    inicial = talonario["numero_inicial"]
    final = talonario["numero_final"]
    # Talonario que ya venia en uso al registrarlo: las hojas anteriores a
    # numero_desde se gastaron fuera del sistema y no se ofrecen.
    desde = talonario["numero_desde"] or inicial

    usadas: set[int] = set()
    filas = await conn.fetch(
        "select numero_talonario from traslados_puntos where talonario_id = $1::uuid", talonario["id"]
    )
    for fila in filas:
        referencia = parsear_referencia(fila["numero_talonario"])
        if referencia is not None and referencia[0] == letra:
            usadas.add(referencia[1])

    anuladas = {
        f["numero"]
        for f in await conn.fetch(
            "select numero from talonario_hojas_anuladas where talonario_id = $1::uuid", talonario["id"]
        )
    }

    pendientes = [n for n in range(desde, final + 1) if n not in usadas and n not in anuladas]
    siguiente = pendientes[0] if pendientes else None
    return {
        "id": str(talonario["id"]),
        "punto_id": str(talonario["punto_id"]),
        "letra": letra,
        "numero_inicial": inicial,
        "numero_final": final,
        "numero_desde": desde,
        "rango": f"{formatear_hoja(letra, inicial)} – {formatear_hoja(letra, final)}",
        "estado": talonario["estado"],
        "siguiente_numero": siguiente,
        "siguiente_hoja": formatear_hoja(letra, siguiente) if siguiente is not None else None,
        "quedan": len(pendientes),
        "agotado": siguiente is None,
        "usadas": len(usadas),
        "anuladas": len(anuladas),
        "umbral_aviso": UMBRAL_AVISO,
    }


async def obtener_talonarios_activos(punto_id: str) -> list[dict]:
    """Talonarios activos del punto (uno por letra) con su estado, ordenados
    por letra. Lista vacia si no hay ninguno."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        filas = await conn.fetch(
            "select * from talonarios_punto where punto_id = $1::uuid and estado = 'activo' order by letra",
            punto_id,
        )
        return [await _estado(conn, fila) for fila in filas]


async def resumen_talonarios_puntos() -> list[dict]:
    """Todos los puntos con sus talonarios activos (uno por letra), para ver
    desde el dashboard que puntos ya configuraron cada talonario. Un punto
    sin talonarios trae la lista vacia."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        puntos = await conn.fetch("select id, nombre from puntos order by nombre")
        filas = await conn.fetch("select * from talonarios_punto where estado = 'activo' order by letra")
        por_punto: dict[str, list[dict]] = {}
        for fila in filas:
            por_punto.setdefault(str(fila["punto_id"]), []).append(await _estado(conn, fila))
        return [
            {
                "punto_id": str(p["id"]),
                "punto_nombre": p["nombre"],
                "talonarios": por_punto.get(str(p["id"]), []),
            }
            for p in puntos
        ]


def elegir_por_letra(talonarios: list[dict], letra: str | None) -> dict | None:
    """Talonario de `talonarios` cuya letra coincide con `letra` (sin importar
    mayusculas), o None."""
    if not letra:
        return None
    for t in talonarios:
        if t["letra"] == letra.upper():
            return t
    return None


def unir_hojas_esperadas(talonarios: list[dict]) -> str:
    """Siguientes hojas de los talonarios unidas para mostrar: "A 6305 o V 120"."""
    return " o ".join(t["siguiente_hoja"] for t in talonarios if t["siguiente_hoja"])


async def hojas_esperadas(punto_id: str) -> list[dict]:
    """Talonarios activos del punto que aun tienen hojas, exigiendo que haya al
    menos uno. Lanza TalonarioNoDisponible con un mensaje listo para mostrar al
    usuario. Lectura sin lock (la usa extraer, que no escribe)."""
    estados = await obtener_talonarios_activos(punto_id)
    if not estados:
        raise TalonarioNoDisponible("Tu punto no tiene un talonario activo. Configura tu talonario antes de continuar.")
    disponibles = [e for e in estados if not e["agotado"]]
    if not disponibles:
        raise TalonarioNoDisponible("Talonario agotado. Pide un talonario y configúralo.")
    return disponibles


async def validar_y_tomar_hoja(conn, punto_id: str, numero_talonario: str) -> tuple[str, str]:
    """Dentro de la transaccion de crear_traslado: toma el lock del talonario
    activo del punto cuya letra es la de `numero_talonario`, recalcula la
    siguiente hoja y exige que sea esa. Devuelve (talonario_id, referencia
    canonica "A 6305")."""
    referencia = parsear_referencia(numero_talonario)
    filas = await conn.fetch(
        "select * from talonarios_punto where punto_id = $1::uuid and estado = 'activo' order by letra",
        punto_id,
    )
    if not filas:
        raise TalonarioNoDisponible("Tu punto no tiene un talonario activo. Configura tu talonario antes de continuar.")

    elegido = None
    if referencia is not None:
        elegido = next((f for f in filas if f["letra"] == referencia[0]), None)
    if elegido is None:
        estados = [await _estado(conn, f) for f in filas]
        esperadas = unir_hojas_esperadas(estados)
        if not esperadas:
            raise TalonarioNoDisponible("Talonario agotado. Pide un talonario y configúralo.")
        raise TalonarioConflicto(
            f"Esa hoja no corresponde a un talonario activo del punto. Toma la foto de la hoja {esperadas}."
        )

    # Lock solo sobre el talonario de esa letra: los de otras letras quedan libres.
    # Se revalida `estado = 'activo'` ya con el lock: otra persona pudo cerrarlo
    # (cambio de talonario) entre la lectura de arriba y este punto.
    talonario = await conn.fetchrow(
        "select * from talonarios_punto where id = $1::uuid and estado = 'activo' for update", elegido["id"]
    )
    if talonario is None:
        raise TalonarioConflicto("El talonario acaba de cambiar. Revisa el talonario activo y vuelve a intentar.")
    estado = await _estado(conn, talonario)
    if estado["agotado"]:
        raise TalonarioNoDisponible("Talonario agotado. Pide un talonario y configúralo.")

    esperada = estado["siguiente_hoja"]
    if referencia != (estado["letra"], estado["siguiente_numero"]):
        raise TalonarioConflicto(
            f"Esa hoja ya se usó o no es la siguiente del talonario. Toma la foto de la hoja {esperada}."
        )
    return estado["id"], esperada


async def configurar_talonario(payload: TalonarioConfigurar) -> dict:
    """Configura (o cambia) el talonario activo de esa letra en el punto; los
    de otras letras no se tocan. Si el activo de la letra no se ha agotado, el
    motivo es obligatorio; las hojas que quedaban sin usar
    simplemente se dejan de usar."""
    punto_id = str(payload.punto_id)
    usuario_id = str(payload.usuario_id)
    numero_final = payload.numero_inicial + HOJAS_POR_TALONARIO - 1
    # Talonario ya en uso: se empieza desde la hoja indicada (las anteriores
    # ya se gastaron). Sin indicarla, desde la primera hoja.
    numero_desde = payload.numero_siguiente or payload.numero_inicial
    if not payload.numero_inicial <= numero_desde <= numero_final:
        raise TalonarioInvalido(
            f"La siguiente hoja por usar debe estar entre {payload.numero_inicial} y {numero_final}."
        )
    pool = await get_pool()

    usuario = await pool.fetchrow(
        "select punto_id from usuarios_punto where id = $1::uuid and estado = 'activo'", usuario_id
    )
    if usuario is None or str(usuario["punto_id"]) != punto_id:
        raise TalonarioInvalido("Quien configura el talonario debe pertenecer a este punto")
    punto = await pool.fetchrow("select id from puntos where id = $1::uuid and activo = true", punto_id)
    if punto is None:
        raise TalonarioInvalido("El punto no existe o esta inactivo")

    anterior_estado: dict | None = None
    async with pool.acquire() as conn:
        async with conn.transaction():
            activo = await conn.fetchrow(
                "select * from talonarios_punto "
                "where punto_id = $1::uuid and letra = $2 and estado = 'activo' for update",
                punto_id,
                payload.letra,
            )
            # "Ya en uso" solo vale para el primer talonario de esa letra en el
            # punto (el que venia gastandose antes de la app); los siguientes
            # siempre arrancan en su primera hoja.
            if numero_desde != payload.numero_inicial:
                previos = await conn.fetchval(
                    "select count(*) from talonarios_punto where punto_id = $1::uuid and letra = $2",
                    punto_id,
                    payload.letra,
                )
                if previos:
                    raise TalonarioInvalido(
                        "Solo el primer talonario puede registrarse ya en uso; este debe empezar en su primera hoja."
                    )
            if activo is not None:
                anterior_estado = await _estado(conn, activo)
                if not anterior_estado["agotado"] and not payload.motivo:
                    raise TalonarioInvalido(
                        "Indica el motivo del cambio: el talonario actual todavía tiene hojas sin usar."
                    )
                await conn.execute(
                    """
                    update talonarios_punto
                    set estado = 'cerrado', cerrado_at = now(), motivo_cierre = $2
                    where id = $1::uuid
                    """,
                    activo["id"],
                    payload.motivo or "Talonario agotado",
                )
            try:
                nuevo = await conn.fetchrow(
                    """
                    insert into talonarios_punto
                        (punto_id, letra, numero_inicial, numero_final, numero_desde, creado_por)
                    values ($1::uuid, $2, $3, $4, $5, $6::uuid)
                    returning *
                    """,
                    punto_id,
                    payload.letra,
                    payload.numero_inicial,
                    numero_final,
                    numero_desde,
                    usuario_id,
                )
            except asyncpg.UniqueViolationError as exc:
                # Indice parcial talonarios_punto_activo_letra_key: otra persona
                # configuro el talonario de esa letra al mismo tiempo.
                raise TalonarioConflicto(
                    "Alguien más acaba de configurar un talonario con esa letra en este punto. "
                    "Revisa los talonarios activos."
                ) from exc
            nuevo_estado = await _estado(conn, nuevo)

    await registrar_evento(
        EventoLog.TALONARIO_CONFIGURADO,
        entidad_tipo="talonario_punto",
        entidad_id=nuevo_estado["id"],
        actor_id=usuario_id,
        sede_id=punto_id,
        resultado="ok",
        detalle={
            "desde": (
                {
                    "talonario_id": anterior_estado["id"],
                    "rango": anterior_estado["rango"],
                    "quedaban": anterior_estado["quedan"],
                }
                if anterior_estado is not None
                else None
            ),
            "hacia": {
                "talonario_id": nuevo_estado["id"],
                "rango": nuevo_estado["rango"],
                # Primera hoja que ofrece el sistema (> inicio si ya venia en uso).
                "desde_hoja": formatear_hoja(nuevo_estado["letra"], numero_desde),
            },
            "motivo": payload.motivo,
        },
    )
    return nuevo_estado


async def anular_siguiente_hoja(payload: HojaAnular) -> dict:
    """Anula exactamente la siguiente hoja pendiente de un talonario activo del
    punto. Sin `talonario_id` (app vieja) se usa el unico activo; si hay varios
    se exige indicar cual."""
    punto_id = str(payload.punto_id)
    usuario_id = str(payload.usuario_id)
    pool = await get_pool()

    usuario = await pool.fetchrow(
        "select punto_id from usuarios_punto where id = $1::uuid and estado = 'activo'", usuario_id
    )
    if usuario is None or str(usuario["punto_id"]) != punto_id:
        raise TalonarioInvalido("Quien anula la hoja debe pertenecer a este punto")

    async with pool.acquire() as conn:
        async with conn.transaction():
            if payload.talonario_id is not None:
                talonario = await conn.fetchrow(
                    "select * from talonarios_punto where id = $1::uuid and punto_id = $2::uuid "
                    "and estado = 'activo' for update",
                    str(payload.talonario_id),
                    punto_id,
                )
            else:
                activos = await conn.fetch(
                    "select * from talonarios_punto where punto_id = $1::uuid and estado = 'activo' for update",
                    punto_id,
                )
                if len(activos) > 1:
                    raise TalonarioInvalido("Indica de cuál talonario es la hoja que quieres anular")
                talonario = activos[0] if activos else None
            if talonario is None:
                raise TalonarioInvalido("Tu punto no tiene ese talonario activo")
            antes = await _estado(conn, talonario)
            if antes["agotado"]:
                raise TalonarioInvalido("El talonario está agotado, no hay hoja para anular")
            await conn.execute(
                """
                insert into talonario_hojas_anuladas (talonario_id, numero, motivo, anulado_por)
                values ($1::uuid, $2, $3, $4::uuid)
                """,
                talonario["id"],
                antes["siguiente_numero"],
                payload.motivo,
                usuario_id,
            )
            despues = await _estado(conn, talonario)

    await registrar_evento(
        EventoLog.TALONARIO_HOJA_ANULADA,
        entidad_tipo="talonario_punto",
        entidad_id=antes["id"],
        actor_id=usuario_id,
        sede_id=punto_id,
        resultado="ok",
        detalle={"hoja": antes["siguiente_hoja"], "motivo": payload.motivo, "quedan": despues["quedan"]},
    )
    return {"hoja_anulada": antes["siguiente_hoja"], "talonario": despues}
