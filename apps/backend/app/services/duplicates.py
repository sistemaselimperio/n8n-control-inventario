"""Chequeo de duplicados entre sedes + flujo de items por entrega (ver plan en
docs/architecture.md): la barrera real sigue siendo el `unique (tipo,
indicativo_numero)` de la tabla `entregas` (ver app.db._SCHEMA) -- ej. no
puede haber dos "FEI 10254". Un documento puede traer varios productos
(`entrega_items`), y si al fotografiarlo de nuevo todavia le queda algo
pendiente en cualquier item, se devuelve para actualizar en vez de bloquear.
"""

import re
from datetime import datetime

import asyncpg

from app.db import get_pool
from app.models.entrega import (
    EstadoEntrega,
    ItemActualizacion,
    ItemEntrega,
    RetiradoPor,
    TIPOS_REMISION,
    SituacionEntrega,
)
from app.models.log import EventoLog
from app.services.facturas_faltantes import resolver_por_entrega
from app.services.logging_service import registrar_evento
from app.services.productos import sincronizar_producto


def _identificador(tipo: str, indicativo_numero: str) -> str:
    """Ej: 'FEI 10254' -- como lo nombran en el documento fisico."""
    return f"{tipo or '?'} {indicativo_numero or 'sin numero'}"


class EntregaDuplicada(Exception):
    def __init__(self, identificador: str, mensaje: str | None = None):
        self.identificador = identificador
        super().__init__(mensaje or f"El documento {identificador} ya fue procesado por completo.")


class CantidadInvalida(Exception):
    """entregado_hoy pide mas de lo que queda pendiente, o el item no existe
    en esta entrega -- ver aplicar_actualizacion_items."""


class ExtraccionIlegible(Exception):
    """La confianza de tipo/indicativo_numero esta por debajo de
    min_confidence_rechazo -- la foto es practicamente ilegible, no solo
    "dudosa" (eso ya lo cubre pendiente_revision). Se dispara ANTES de
    intentar el insert: a diferencia de una entrega de baja confianza, aca no
    se crea ningun registro -- el operador repite la foto en el momento (ver
    procesar_extraccion)."""

    def __init__(self, identificador: str):
        self.identificador = identificador
        super().__init__(f"El documento {identificador} no se pudo leer -- foto poco clara.")


class FacturacionRequerida(Exception):
    """Rol 'punto_venta' con doble captura (ver docs/architecture.md): un
    'operador' (bodega) fotografio un documento que TODAVIA no existe -- eso
    haria que procesar_extraccion lo insertara como SituacionEntrega.NUEVA,
    pero solo punto_venta/supervisor/admin pueden facturar por primera vez.
    Se dispara ANTES de intentar el insert (mismo momento que
    ExtraccionIlegible) -- no se crea ningun registro, el operador espera a
    que punto_venta facture y despues re-fotografia (ese segundo escaneo si
    entra, porque el documento ya existe y el resultado natural es
    "actualizable")."""

    def __init__(self, identificador: str):
        self.identificador = identificador
        super().__init__(
            f"El documento {identificador} debe ser facturado primero por punto de venta."
        )


class RolNoAutorizado(Exception):
    """'faia_viewer' es de solo lectura (ve fotos marcadas FAIA via
    GET /entregas/faia, ver app/routers/entregas.py) -- no tiene que poder
    fotografiar/crear ni confirmar ninguna entrega, a diferencia de
    'operador' que solo tiene restringido crear una NUEVA (ver
    FacturacionRequerida). Se dispara antes de tocar la base, tanto en
    procesar_extraccion como en aplicar_actualizacion_items."""

    def __init__(self):
        super().__init__("Este usuario no tiene permiso para procesar ni confirmar entregas.")


class FacturaYaRegistrada(Exception):
    """Espejo de FacturacionRequerida: 'punto_venta' puede CREAR un documento
    nuevo, pero no re-tocar uno que ya existe (esa segunda foto es del
    bodeguero, que la ve como "actualizable" -- ver FacturacionRequerida). No
    importa si a la factura le queda algo pendiente o no: para punto_venta
    "ya existe" siempre es un rechazo, asi una factura solo se factura una
    vez. Se dispara ANTES de intentar el insert, mismo momento que
    FacturacionRequerida."""

    def __init__(self, identificador: str):
        self.identificador = identificador
        super().__init__(f"La factura {identificador} ya fue registrada.")


class RemisionEnDespachos(Exception):
    """Una remision (RM2/RM3/RSF) se fotografio desde la tab Despachos -- las
    remisiones tienen su propio flujo (flujo="remision", ver
    EntregaCreate.flujo). Se dispara antes de tocar la base."""

    def __init__(self, identificador: str):
        self.identificador = identificador
        super().__init__(f"El documento {identificador} es una remisión. Usá la pestaña Remisiones.")


class DespachoEnRemisiones(Exception):
    """Espejo de RemisionEnDespachos: un documento que NO es RM2/RM3/RSF se
    fotografio desde la tab Remisiones. Se dispara antes de tocar la base."""

    def __init__(self, identificador: str):
        self.identificador = identificador
        super().__init__(f"El documento {identificador} no es una remisión. Usá la pestaña Despachos.")


class _NecesitaTraslado(Exception):
    """Uso interno de procesar_extraccion: se dispara DENTRO de la
    transaccion tentativa (asi el insert que ya se hizo se deshace solo) para
    devolver SituacionEntrega.NECESITA_TRASLADO en vez de crear el
    documento -- ver _TIPO_SEDE_DUENA."""


class NecesitaTrasladoParaConfirmar(Exception):
    """Espejo de _NecesitaTraslado, pero para CONFIRMAR (aplicar_actualizacion_items)
    en vez de crear: una entrega ya existente, con tipo de sede duena, que
    intenta confirmar/editar cantidades una sede distinta de la duena, sin
    traslado valido adjunto. A diferencia de _NecesitaTraslado (interna,
    nunca sale de duplicates.py), esta SI cruza a router/movil -- lleva
    tipo/indicativo_numero por separado (no solo el identificador formateado)
    para que el endpoint arme una respuesta estructurada que el cliente
    pueda distinguir de un error generico (ver actualizar_items en
    routers/entregas.py)."""

    def __init__(self, tipo: str, indicativo_numero: str):
        self.tipo = tipo
        self.indicativo_numero = indicativo_numero
        identificador = _identificador(tipo, indicativo_numero)
        super().__init__(
            f"El documento {identificador} pertenece a otra sede -- se necesita un traslado para confirmarlo."
        )


# tipo (mayusculas) -> codigo de sedes.codigo (SEDE-01/SEDE-02, NO nombre --
# el nombre de una sede se puede renombrar, ej. "Sede Principal" ya paso a
# llamarse "Sede Centro", el codigo es el identificador estable). Un tipo que
# no esta aca (TB, RM3, RM2, RSF, o cualquier otro que la IA transcriba) no tiene
# sede duena, se procesa igual que siempre, sin esta restriccion.
_TIPO_SEDE_DUENA = {
    "EDP": "SEDE-02",  # Polo Sur
    "EDV": "SEDE-02",
    "FEI": "SEDE-01",  # Sede Centro
    "FV1": "SEDE-01",
}


def _concepto_referencia_factura(tipo: str, indicativo_numero: str, concepto_traslado: str) -> bool:
    """El concepto de la guia de traslado (campo de texto libre del
    documento, ver 'concepto' en vision._EXTRACTION_SCHEMA) debe mencionar
    el identificador de la factura para la que se pide la excepcion de sede
    -- no el tipo de la guia en si (que es TB, no el de la factura, asi que
    comparar el tipo del TRASLADO nunca coincidiria), sino la referencia
    "TIPO INDICATIVO" tal como aparece impresa en el documento fisico, con
    guion o con espacio entre tipo y numero (ej. "Factura FEI 21542" o
    "FEI-21542"). Buscar solo el numero suelto daria falsos positivos con
    cualquier numero que aparezca en el concepto por otro motivo -- el
    identificador completo es mucho mas dificil que coincida por casualidad
    con un traslado ajeno.

    Substring normalizado (upper + strip) en vez de igualdad exacta: el
    concepto es texto libre, puede traer palabras alrededor (ej. "Traslado
    por factura FEI-21542 a bodega central"). Todo separador (guion,
    espacios, o espacios pegados a un guion -- tipico ruido de OCR: "FEI -
    21542") se normaliza a un solo guion, asi "FEI 21542" y "FEI-21542"
    coinciden igual. Sigue exigiendo el tipo pegado al numero, no se relaja
    a buscar el numero suelto (eso ya se descarto por dar falsos
    positivos)."""
    numero = indicativo_numero.strip().upper()
    if not numero:
        return False

    def _normalizar(texto: str) -> str:
        return re.sub(r"\s*-\s*|\s+", "-", texto.strip().upper())

    identificador = _normalizar(f"{tipo} {numero}")
    # (?!\d): el numero tiene que terminar ahi. Sin esto "FEI-215" quedaba
    # "contenido" en "FEI-21542" y una guia de traslado de otra factura
    # destrababa por casualidad la restriccion de sede.
    return re.search(re.escape(identificador) + r"(?!\d)", _normalizar(concepto_traslado)) is not None


async def requiere_traslado(tipo: str, sede_id: str, entrega_id: str | None = None) -> bool:
    """Aviso temprano (NO es el gate real) -- True si `tipo` tiene sede
    duena (_TIPO_SEDE_DUENA) y `sede_id` no es esa. Se usa para mostrarle a
    la app la tarjeta "Traslado requerido" apenas se busca/reescanea un
    documento, ANTES de que el bodeguero cargue cantidades que despues no va
    a poder guardar -- el gate que de verdad bloquea sigue siendo
    aplicar_actualizacion_items (NecesitaTrasladoParaConfirmar), esto es
    puramente informativo y nunca escribe ni lanza nada.

    `entrega_id`, si viene, permite cortar temprano: si ESE documento
    puntual ya tiene un traslado guardado (de una visita anterior), no hace
    falta pedirlo de nuevo -- mismo criterio que el gate real."""
    dueno_esperado = _TIPO_SEDE_DUENA.get(tipo)
    if dueno_esperado is None:
        return False
    pool = await get_pool()
    if entrega_id is not None:
        ya_tiene_traslado = await pool.fetchval(
            "select traslado_url is not null from entregas where id = $1::uuid", entrega_id
        )
        if ya_tiene_traslado:
            return False
    fila_sede = await pool.fetchrow("select codigo from sedes where id::text = $1", sede_id)
    return fila_sede is None or fila_sede["codigo"] != dueno_esperado


def marcar_estado_por_confianza(confianza: dict[str, float], min_confidence: float) -> EstadoEntrega:
    # Las cantidades quedan afuera del gate: siempre las confirma el
    # bodeguero a mano en el paso 2 (ver procesar_extraccion), sin importar
    # que tan segura estuvo la IA al leerlas.
    campos_criticos = ("tipo", "indicativo_numero")
    if any(confianza.get(campo, 0.0) < min_confidence for campo in campos_criticos):
        return EstadoEntrega.PENDIENTE_REVISION
    return EstadoEntrega.PROCESADA


async def _items_de_entrega(conn: asyncpg.Connection, entrega_id) -> list[ItemEntrega]:
    rows = await conn.fetch(
        """
        select i.id, i.descripcion, i.cantidad_entregada, i.cantidad_pendiente,
            i.cantidad_no_entregada, i.nota,
            (i.actualizado_at > i.creado_at) as confirmado,
            i.entregado_en_punto_venta,
            i.entregado_en_otra_bodega,
            case
                when i.entregado_por like 'dashboard:%' then substring(i.entregado_por from 11)
                else emp.nombre
            end as entregado_por_nombre
        from entrega_items i
        left join empleados emp on emp.id::text = i.entregado_por
        where i.entrega_id = $1::uuid
        order by i.creado_at
        """,
        entrega_id,
    )
    return [
        ItemEntrega(
            id=str(r["id"]),
            descripcion=r["descripcion"],
            cantidad_entregada=r["cantidad_entregada"],
            cantidad_pendiente=r["cantidad_pendiente"],
            cantidad_no_entregada=r["cantidad_no_entregada"],
            nota=r["nota"],
            confirmado=r["confirmado"],
            entregado_en_punto_venta=r["entregado_en_punto_venta"],
            entregado_en_otra_bodega=r["entregado_en_otra_bodega"],
            entregado_por_nombre=r["entregado_por_nombre"],
        )
        for r in rows
    ]


async def procesar_extraccion(
    extraido: dict,
    *,
    hash_evidencia: str,
    sede_origen_id: str,
    operador_id: str,
    capturado_at: datetime,
    evidencia_url: str,
    min_confidence: float,
    min_confidence_rechazo: float,
    traslado_url: str | None = None,
    concepto_traslado: str | None = None,
    items_traslado: list[dict] | None = None,
    traslado_tipo: str | None = None,
    traslado_indicativo_numero: str | None = None,
    flujo: str = "despacho",
) -> tuple[SituacionEntrega, str | None, list[ItemEntrega], EstadoEntrega, str, str, bool, str | None, str | None]:
    """Paso 1 del flujo (ver Figura 1 / docs/architecture.md):

    - No existia -> intenta insertarla (items = lo que leyo la IA, con
      cantidad_pendiente = cantidad_entregada hasta que el bodeguero confirme
      en el paso 2). El `unique(tipo, indicativo_numero)` de la tabla es la
      barrera real contra la carrera entre sedes -- se inserta primero y se
      atrapa la excepcion, no se pre-chequea con un select (mismo patron que
      ya usaba este modulo).
    - No existia, pero el tipo pertenece a otra sede (ver _TIPO_SEDE_DUENA) y
      no vino traslado_url, o vino pero su concepto no menciona el numero de
      la factura (ver _concepto_referencia_factura) -> no se inserta nada, se devuelve
      "necesita_traslado" (id=None) con lo que leyo la IA. Esto SOLO aplica
      al crear el documento -- una vez aceptado (con o sin traslado), el
      resto del ciclo (confirmar cantidades, devoluciones) sigue sin
      restriccion de sede, igual que hoy. Si el traslado SI se acepta y la
      factura se leyo con poca confianza en los items, se insertan los
      productos leidos del traslado en vez de los de la factura (ver
      confianza_items mas abajo).
    - Ya existia y le queda algo pendiente en cualquier item -> "actualizable",
      no se escribe nada todavia, se devuelven los items tal cual estan.
    - Ya existia y todo esta en pendiente=0 -> EntregaDuplicada (409).
    - Confianza de tipo o indicativo_numero por debajo de min_confidence_rechazo
      (foto practicamente ilegible) -> ExtraccionIlegible, ANTES de intentar el
      insert -- no se crea ningun registro, a diferencia del caso de baja
      confianza "normal" que igual persiste como pendiente_revision.
    """
    pool = await get_pool()
    # .upper() ademas de .strip(): "tipo" ya no esta atado al enum de 4
    # valores conocidos (ver vision.py), la IA puede transcribir cualquier
    # texto -- sin normalizar el casing, "tb" y "TB" quedarian como
    # documentos distintos para la barrera anti-duplicado y para buscar_entrega.
    tipo = (extraido.get("tipo") or "FEI").strip().upper()
    indicativo_numero = (extraido.get("indicativo_numero") or "").strip()
    identificador = _identificador(tipo, indicativo_numero)
    estado = marcar_estado_por_confianza(extraido.get("confianza", {}), min_confidence)
    items_extraidos = extraido.get("items") or []

    confianza = extraido.get("confianza") or {}
    if any(confianza.get(c, 0.0) < min_confidence_rechazo for c in ("tipo", "indicativo_numero")):
        # Antes de tocar la base: una foto ilegible no debe dejar ningun
        # registro, a diferencia del gate de mas arriba (marcar_estado_por_confianza)
        # que igual persiste como pendiente_revision.
        raise ExtraccionIlegible(identificador)

    # Gate de flujo, antes de tocar la base: cada tab de la app movil solo
    # acepta sus propios tipos (RM2/RM3/RSF van por "remision", el resto por
    # "despacho"). Necesita el tipo ya leido por la IA, por eso vive aca y no
    # en el router.
    es_remision = tipo in TIPOS_REMISION
    if flujo == "remision" and not es_remision:
        raise DespachoEnRemisiones(identificador)
    if flujo != "remision" and es_remision:
        raise RemisionEnDespachos(identificador)

    async with pool.acquire() as conn:
        # Gate de rol, antes de tocar la base (mismo momento que
        # ExtraccionIlegible/FacturacionRequerida mas abajo). 'faia_viewer' es
        # de solo lectura -- no puede fotografiar/procesar NADA, ni nueva ni
        # actualizable (ver RolNoAutorizado). 'operador' (bodega) si puede,
        # salvo crear un documento que punto_venta todavia no facturo (ver
        # FacturacionRequerida un poco mas abajo, que solo aplica cuando el
        # documento no existe todavia).
        fila_empleado = await conn.fetchrow(
            "select rol from empleados where id::text = $1", operador_id
        )
        if fila_empleado is not None and fila_empleado["rol"] == "faia_viewer":
            raise RolNoAutorizado()
        # En Remisiones el bodeguero fotografia directo (no hay facturacion
        # previa de punto_venta), asi que punto_venta tampoco participa.
        if flujo == "remision" and fila_empleado is not None and fila_empleado["rol"] == "punto_venta":
            raise RolNoAutorizado()

        # Rol "punto_venta" con doble captura: si el documento TODAVIA no
        # existe, este insert seria SituacionEntrega.NUEVA -- un 'operador'
        # (bodega) no puede crear un documento nuevo, solo re-fotografiar uno
        # que punto_venta ya facturo (ese caso ya no entra aca porque
        # "existe" da true). Se chequea ANTES de insertar -- no insertar y
        # despues borrar -- con un select liviano fuera de la transaccion de
        # insert; la barrera real contra duplicados sigue siendo el unique
        # constraint mas abajo, esto es solo el gate de rol.
        existe = await conn.fetchval(
            "select 1 from entregas where tipo = $1 and indicativo_numero = $2",
            tipo,
            indicativo_numero,
        )
        if (
            flujo != "remision"
            and not existe
            and fila_empleado is not None
            and fila_empleado["rol"] == "operador"
        ):
            raise FacturacionRequerida(identificador)
        # Espejo del gate de arriba: punto_venta puede CREAR (esto no la
        # bloquea) pero no re-tocar un documento que ya existe -- no importa
        # si le queda pendiente o no, esa segunda foto es tarea del
        # bodeguero (ver FacturaYaRegistrada). Asi una factura se factura
        # una sola vez.
        if existe and fila_empleado is not None and fila_empleado["rol"] == "punto_venta":
            raise FacturaYaRegistrada(identificador)

        try:
            async with conn.transaction():
                entrega_id = await conn.fetchval(
                    """
                    insert into entregas (
                        tipo, indicativo_numero, hash_evidencia, sede_origen_id,
                        estado, confianza_ia, evidencia_url, evidencia_creacion_url,
                        operador_id, capturado_at,
                        procesado_at, traslado_url, traslado_tipo, traslado_indicativo_numero
                    ) values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, now(), $10, $11, $12)
                    returning id
                    """,
                    tipo,
                    indicativo_numero,
                    hash_evidencia,
                    sede_origen_id,
                    estado.value,
                    extraido.get("confianza", {}),
                    evidencia_url,
                    operador_id,
                    capturado_at,
                    traslado_url,
                    traslado_tipo,
                    traslado_indicativo_numero,
                )

                # Si bodega habia reportado esta factura como faltante, ya
                # llego: se cierra en la MISMA transaccion del insert (si hay
                # rollback abajo -- ej. necesita_traslado -- el reporte sigue
                # pendiente). El log se escribe despues del commit.
                reportes_resueltos = await resolver_por_entrega(
                    conn, tipo, indicativo_numero, entrega_id
                )

                # Si el tipo pertenece a otra sede, se deshace este insert
                # (la excepcion adentro de la transaccion hace rollback sola)
                # y se devuelve necesita_traslado en vez de crear el
                # documento -- salvo que vino un traslado cuyo concepto
                # menciona el numero de esta factura (ver
                # _concepto_referencia_factura).
                dueno_esperado = _TIPO_SEDE_DUENA.get(tipo)
                if dueno_esperado is not None:
                    fila_sede = await conn.fetchrow(
                        "select codigo from sedes where id::text = $1", sede_origen_id
                    )
                    sede_no_coincide = fila_sede is None or fila_sede["codigo"] != dueno_esperado
                    if sede_no_coincide:
                        traslado_valido = traslado_url is not None and _concepto_referencia_factura(
                            tipo, indicativo_numero, concepto_traslado or ""
                        )
                        if not traslado_valido:
                            raise _NecesitaTraslado()

                        confianza_items = (extraido.get("confianza") or {}).get("items", 1.0)
                        if confianza_items < min_confidence and items_traslado:
                            # La factura no se leyo bien (nombres/cantidades
                            # poco legibles) y el traslado ya fue validado
                            # por numero -- se usan sus productos en vez de
                            # los de la factura, que en la practica suelen
                            # verse mejor en la guia de traslado. Reemplazo
                            # de la lista completa, no item por item
                            # (emparejar dos listas leidas por separado por
                            # OCR es fragil, misma razon por la que se
                            # descarto _items_coinciden).
                            items_extraidos = items_traslado

                items: list[ItemEntrega] = []
                for it in items_extraidos:
                    cantidad = max(0, int(it.get("cantidad") or 0))
                    descripcion = str(it.get("descripcion") or "")
                    # cantidad_entregada arranca en 0, NO en cantidad: todavia
                    # nadie entrego nada de verdad, solo se leyo el documento
                    # (ver el fix de "Entregado" -- antes esto mostraba el
                    # total leido como si ya estuviera entregado). La rama
                    # absoluta de aplicar_actualizacion_items se encarga de
                    # derivarla sola cuando de verdad se confirma.
                    item_id = await conn.fetchval(
                        """
                        insert into entrega_items (entrega_id, descripcion, cantidad_entregada, cantidad_pendiente)
                        values ($1, $2, 0, $3)
                        returning id
                        """,
                        entrega_id,
                        descripcion,
                        cantidad,
                    )
                    await sincronizar_producto(conn, descripcion)
                    items.append(
                        ItemEntrega(
                            id=str(item_id),
                            descripcion=descripcion,
                            cantidad_entregada=0,
                            cantidad_pendiente=cantidad,
                            # Recien insertado, todavia nadie lo confirmo --
                            # ver el comentario en ItemEntrega.confirmado.
                            confirmado=False,
                        )
                    )
        except _NecesitaTraslado:
            # El insert de arriba ya se deshizo (rollback de la transaccion).
            # Se arman los items "vista previa" a partir de lo que leyo la
            # IA -- nunca se insertaron, por eso id="" (el movil no los usa
            # para nada mas que mostrar contexto en el aviso de traslado).
            items_vista = [
                ItemEntrega(
                    id="",
                    descripcion=str(it.get("descripcion") or ""),
                    cantidad_entregada=max(0, int(it.get("cantidad") or 0)),
                    cantidad_pendiente=max(0, int(it.get("cantidad") or 0)),
                    confirmado=False,
                )
                for it in items_extraidos
            ]
            # No se inserto nada -- no hay flag FAIA, nota general ni firma que preservar.
            return SituacionEntrega.NECESITA_TRASLADO, None, items_vista, estado, tipo, indicativo_numero, False, None, None
        except asyncpg.UniqueViolationError as exc:
            # "entregas" tiene DOS unique: (tipo, indicativo_numero) -- la
            # barrera real -- y hash_evidencia -- evita reprocesar la misma
            # foto. Hay que fijarse cual de los dos choco antes de buscar la
            # fila existente, si no la busqueda puede no encontrar nada
            # (ej. mismo hash_evidencia pero tipo/indicativo distintos, como
            # al reusar una foto de la galeria para otro documento) y
            # explotar con un TypeError en vez de responder algo coherente.
            if exc.constraint_name == "entregas_hash_evidencia_key":
                fila = await conn.fetchrow(
                    "select id, tipo, indicativo_numero, es_faia, nota_general, firma_url from entregas"
                    " where hash_evidencia = $1",
                    hash_evidencia,
                )
            else:
                fila = await conn.fetchrow(
                    "select id, tipo, indicativo_numero, es_faia, nota_general, firma_url from entregas"
                    " where tipo = $1 and indicativo_numero = $2",
                    tipo,
                    indicativo_numero,
                )
            if fila is None:
                raise
            items = await _items_de_entrega(conn, fila["id"])
            if all(item.cantidad_pendiente == 0 for item in items):
                await registrar_evento(
                    EventoLog.DUPLICADO_BLOQUEADO,
                    entidad_tipo="entrega",
                    entidad_id=identificador,
                    actor_id=operador_id,
                    sede_id=sede_origen_id,
                    resultado="bloqueado",
                    detalle={"tipo": tipo, "indicativo_numero": indicativo_numero},
                )
                raise EntregaDuplicada(identificador)
            return (
                SituacionEntrega.ACTUALIZABLE,
                str(fila["id"]),
                items,
                estado,
                fila["tipo"],
                fila["indicativo_numero"],
                # Documento ya existente -- se preservan el flag FAIA, la
                # nota general y la firma que ya tenia (ver
                # PATCH /entregas/{id}/items), nunca se reinician por
                # re-fotografiar o re-confirmar.
                fila["es_faia"],
                fila["nota_general"],
                fila["firma_url"],
            )
        else:
            await registrar_evento(
                EventoLog.ENTREGA_INSERTADA,
                entidad_tipo="entrega",
                entidad_id=str(entrega_id),
                actor_id=operador_id,
                sede_id=sede_origen_id,
                resultado="ok",
            )
            # Ya hubo commit: ahora si se registra el cierre automatico de los
            # reportes de factura faltante (ver resolver_por_entrega).
            for reporte_id in reportes_resueltos:
                await registrar_evento(
                    EventoLog.FACTURA_FALTANTE_RESUELTA,
                    entidad_tipo="factura_faltante",
                    entidad_id=reporte_id,
                    actor_id=operador_id,
                    sede_id=sede_origen_id,
                    resultado="ok",
                    detalle={"tipo": tipo, "indicativo_numero": indicativo_numero, "entrega_id": str(entrega_id)},
                )
            # Recien insertada -- default de columna, todavia no hay nada que preservar.
            return SituacionEntrega.NUEVA, str(entrega_id), items, estado, tipo, indicativo_numero, False, None, None


async def aplicar_actualizacion_items(
    entrega_id: str,
    items: list[ItemActualizacion],
    *,
    operador_id: str,
    sede_id: str,
    evidencia_url: str | None = None,
    hash_evidencia: str | None = None,
    firma_url: str | None = None,
    es_faia: bool | None = None,
    nota_general: str | None = None,
    retirado_por: RetiradoPor | None = None,
    traslado_url: str | None = None,
    traslado_tipo: str | None = None,
    traslado_indicativo_numero: str | None = None,
) -> list[ItemEntrega]:
    """Paso 2: confirma una entrega nueva (cantidad_pendiente absoluta) o
    aplica una actualizacion incremental (entregado_hoy, sumado/restado
    atomicamente en SQL -- asi dos visitas casi simultaneas al mismo item no
    se pisan). Cualquier sede puede confirmar una entrega ya existente (no
    solo la que la creo) -- salvo que el tipo tenga sede duena
    (_TIPO_SEDE_DUENA) y la sede que confirma no sea esa: ahi tambien hace
    falta un traslado valido, mismo mecanismo que ya exige procesar_extraccion
    al CREAR (ver el chequeo de sede_no_coincide mas abajo)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        # 'faia_viewer' es de solo lectura -- no puede confirmar ninguna
        # entrega (ver RolNoAutorizado en procesar_extraccion). 'punto_venta'
        # nunca confirma CANTIDADES (eso es tarea del bodeguero, ver
        # FacturaYaRegistrada), pero SI puede marcar/desmarcar es_faia sobre
        # el documento que acaba de facturar (switch en el modal de
        # PantallaCapturaFoto) -- por eso se lo bloquea solo cuando `items`
        # trae algo, no de forma incondicional como a faia_viewer. None (id
        # desconocido, ej. el "supervisor" fijo que manda el dashboard en vez
        # de un empleado_id real) nunca bloquea -- mismo criterio que el
        # resto de los chequeos de rol en este modulo.
        fila_empleado = await conn.fetchrow(
            "select rol from empleados where id::text = $1", operador_id
        )
        if fila_empleado is not None and fila_empleado["rol"] == "faia_viewer":
            raise RolNoAutorizado()
        if fila_empleado is not None and fila_empleado["rol"] == "punto_venta" and items:
            raise RolNoAutorizado()

        # Gate de sede -- solo cuando de verdad se tocan cantidades (mismo
        # criterio de alcance que el bloqueo de punto_venta arriba: una
        # correccion de solo nota/firma/es_faia desde otra sede no exige
        # esto), Y solo para un empleado real (fila_empleado is not None) --
        # mismo criterio que el resto de los chequeos de esta funcion: el
        # "supervisor" fijo del dashboard (revisarEntrega) no matchea ningun
        # empleado real, y una correccion manual desde ahi no debe quedar
        # bloqueada por sede (el dashboard no tiene UI de traslado, a
        # diferencia del movil). Reusa _TIPO_SEDE_DUENA (misma restriccion de
        # sede que ya protege la creacion) -- para que confirmar una entrega
        # pendiente creada por otra sede no sea una puerta trasera a esa
        # restriccion.
        #
        # A diferencia de la creacion, ACA NO se valida el concepto del
        # traslado contra _concepto_referencia_factura: ese chequeo depende
        # de que la IA haya leido el texto real impreso en la foto del
        # traslado (ver procesar_extraccion) -- confirmar cantidades no pasa
        # por la IA, asi que no hay ningun "concepto leido" real que
        # comparar. Pedir aca solo que exista `traslado_url` (una foto
        # adjunta) es la version alcanzable de este mismo gate sin agregar
        # una llamada a IA nueva -- mas liviano que al crear, pero sigue
        # exigiendo una accion deliberada (adjuntar evidencia) en vez de
        # dejar pasar la edicion sin mas.
        #
        # "items no vacio" NO alcanza como condicion: un guardado de solo
        # nota/descripcion por producto (boton "Guardar nota" en
        # PantallaConfirmando, cuando itemsConCambioCantidad esta vacio)
        # tambien manda `items` no vacio, pero sin ningun campo de cantidad
        # -- ese caso tiene que colarse igual que nota_general/firma_url/
        # es_faia (no toca cantidades). Se chequea especificamente que algun
        # item traiga entregado_hoy o cantidad_pendiente.
        hay_cambio_cantidad = any(
            item.entregado_hoy is not None
            or item.cantidad_pendiente is not None
            or item.cantidad_entregada is not None
            for item in items
        )
        if hay_cambio_cantidad and fila_empleado is not None:
            fila_entrega = await conn.fetchrow(
                "select tipo, indicativo_numero, traslado_url from entregas where id = $1::uuid", entrega_id
            )
            dueno_esperado = fila_entrega and _TIPO_SEDE_DUENA.get(fila_entrega["tipo"])
            if dueno_esperado is not None:
                fila_sede = await conn.fetchrow(
                    "select codigo from sedes where id::text = $1", sede_id
                )
                sede_no_coincide = fila_sede is None or fila_sede["codigo"] != dueno_esperado
                # Si el documento ya tiene un traslado guardado de una visita
                # anterior (de este pedido o de uno previo), no hace falta
                # pedirlo de nuevo en cada confirmacion -- una sola vez por
                # documento alcanza (ver requiere_traslado, mismo criterio).
                ya_tiene_traslado = fila_entrega["traslado_url"] is not None
                if sede_no_coincide and traslado_url is None and not ya_tiene_traslado:
                    raise NecesitaTrasladoParaConfirmar(
                        fila_entrega["tipo"], fila_entrega["indicativo_numero"]
                    )

        # Correccion manual desde el dashboard (sesion -> "dashboard:<usuario>",
        # o sede_id fijo "dashboard" que manda actualizarItems): no es una
        # confirmacion de bodega, asi que no pisa bodeguero_id ni entregado_por,
        # y deja en el log el antes/despues de cada campo para la seccion
        # "Cambios del admin" del dashboard.
        es_correccion_dashboard = operador_id.startswith("dashboard:") or sede_id == "dashboard"
        cambios: list[dict] = []

        async with conn.transaction():
            antes = {}
            if es_correccion_dashboard:
                filas_antes = await conn.fetch(
                    "select id, descripcion, cantidad_entregada, cantidad_pendiente"
                    " from entrega_items where entrega_id = $1::uuid",
                    entrega_id,
                )
                antes = {str(f["id"]): f for f in filas_antes}

            for item in items:
                if item.entregado_hoy is not None:
                    # Delta atomico en SQL -- no se lee-modifica-escribe desde
                    # Python, asi dos confirmaciones casi simultaneas al mismo
                    # item no se pisan entre si. El "and cantidad_pendiente >=
                    # $2" es la validacion real (no se puede entregar mas de
                    # lo que queda pendiente): si no hay fila que cumpla la
                    # condicion, el update no afecta ninguna fila y sabemos
                    # que hay que rechazar -- antes esto se "resolvia" con
                    # greatest(0, ...), que dejaba pendiente en 0 pero sumaba
                    # el delta completo a cantidad_entregada igual, rompiendo
                    # la cuenta (entregada + pendiente ya no daba el total).
                    #
                    # El CASE sobre "actualizado_at > creado_at" (mismo campo
                    # calculado que expone _items_de_entrega como
                    # "confirmado") distingue la PRIMERA confirmacion real de
                    # las siguientes. Con el rol punto_venta, el documento
                    # existe antes de que bodega lo fotografie, asi que la
                    # primera confirmacion real de bodega SIEMPRE le llega a
                    # esta rama (situacion 'actualizable'), nunca a la
                    # absoluta ('nueva'). Sin este CASE, esa primera
                    # confirmacion sumaria el delta sobre lo que ya hubiera en
                    # cantidad_entregada en vez de fijarlo (ej. bodega entrega
                    # 2, se veia "Entregado: 4" si algo mas ya la habia
                    # tocado). Con el seed en 0 (ver el insert mas abajo,
                    # antes en procesar_extraccion) esto ya no duplica en la
                    # practica, pero se deja el CASE por las dudas de una
                    # carrera entre sedes u otro camino que deje algo
                    # sembrado ahi antes de la primera confirmacion real.
                    fila = await conn.fetchrow(
                        """
                        update entrega_items
                        set descripcion = coalesce($4, descripcion),
                            nota = coalesce($5, nota),
                            cantidad_entregada = case
                                when actualizado_at > creado_at then cantidad_entregada + $2
                                else $2
                            end,
                            cantidad_pendiente = cantidad_pendiente - $2,
                            actualizado_at = now()
                        where id = $1::uuid and entrega_id = $3::uuid and cantidad_pendiente >= $2
                        returning id
                        """,
                        item.id,
                        item.entregado_hoy,
                        entrega_id,
                        item.descripcion,
                        item.nota,
                    )
                    if fila is None:
                        actual = await conn.fetchrow(
                            "select descripcion, cantidad_pendiente from entrega_items"
                            " where id = $1::uuid and entrega_id = $2::uuid",
                            item.id,
                            entrega_id,
                        )
                        if actual is None:
                            raise CantidadInvalida(f"El item {item.id} no existe en esta entrega.")
                        raise CantidadInvalida(
                            f"'{actual['descripcion']}' tiene {actual['cantidad_pendiente']} pendiente, "
                            f"no se puede entregar {item.entregado_hoy}."
                        )
                    if item.descripcion is not None:
                        await sincronizar_producto(conn, item.descripcion)
                else:
                    # Valores absolutos -- confirmar una entrega nueva desde
                    # el movil (solo cantidad_pendiente, situacion 'nueva'),
                    # o correccion manual desde el dashboard (cualquier
                    # combinacion de campos, incluida una correccion EXPLICITA
                    # de cantidad_entregada). cantidad_entregada arranca en 0
                    # (ver el insert en procesar_extraccion) -- si el movil
                    # solo manda cantidad_pendiente (sin corregir
                    # cantidad_entregada a mano), hay que DERIVAR cuanto se
                    # entrego de verdad a partir de cuanto bajo lo pendiente,
                    # si no "Entregado" se quedaria en 0 para siempre. Si en
                    # cambio SI viene una correccion explicita ($3), esa gana
                    # siempre (ej. dashboard corrigiendo un numero mal
                    # tipeado) -- no se sobreescribe con la derivacion.
                    #
                    # Limite conocido: el movil tambien reusa cantidad_entregada
                    # para "corregir la cantidad leida por la IA" (pantalla
                    # 'nueva', boton "Cantidad leida") -- si esa correccion Y
                    # una entrega parcial pasan en la MISMA visita, gana la
                    # correccion de lectura, no el delta real entregado. Esto
                    # ya pasaba antes de este cambio (cantidad_entregada
                    # tampoco reflejaba lo entregado en ese caso), no es una
                    # regresion nueva.
                    await conn.execute(
                        """
                        update entrega_items
                        set descripcion = coalesce($2, descripcion),
                            cantidad_entregada = case
                                when $3::int is not null then $3::int
                                when $4::int is not null then cantidad_entregada + greatest(cantidad_pendiente - $4::int, 0)
                                else cantidad_entregada
                            end,
                            cantidad_pendiente = coalesce($4, cantidad_pendiente),
                            nota = coalesce($6, nota),
                            actualizado_at = now()
                        where id = $1::uuid and entrega_id = $5::uuid
                        """,
                        item.id,
                        item.descripcion,
                        item.cantidad_entregada,
                        item.cantidad_pendiente,
                        entrega_id,
                        item.nota,
                    )
                    if item.descripcion is not None:
                        await sincronizar_producto(conn, item.descripcion)

            # Items marcados "entregado en el punto de venta": no se acreditan
            # a bodega. Si TODOS los items enviados lo estan, no se toca
            # bodeguero_id (el bodeguero queda solo como actor_id del log).
            # Lo mismo aplica a "entregado en otra bodega" (solo remisiones): no
            # se acredita a esta bodega, pero se guarda aparte.
            ids_punto_venta = {i.id for i in items if i.desde_punto_venta}
            ids_otra_bodega = {i.id for i in items if i.desde_otra_bodega}
            ids_no_acreditados = ids_punto_venta | ids_otra_bodega
            if items and len(ids_no_acreditados) < len(items) and not es_correccion_dashboard:
                # Quien confirmo cantidades reales en ESTA llamada -- a
                # diferencia de operador_id (el creador, nunca se pisa), esto
                # SI se actualiza cada vez, asi refleja quien esta con la
                # factura ahora (ver columna en app/db.py). punto_venta nunca
                # llega aca con items no vacios (RolNoAutorizado mas arriba),
                # asi que esto siempre es bodega o una correccion del
                # dashboard (operador_id="supervisor", ver revisarEntrega).
                await conn.execute(
                    "update entregas set bodeguero_id = $2, actualizado_at = now() where id = $1::uuid",
                    entrega_id,
                    operador_id,
                )

            if evidencia_url and hash_evidencia:
                await conn.execute(
                    """
                    update entregas
                    set evidencia_url = $2, hash_evidencia = $3, actualizado_at = now()
                    where id = $1::uuid
                    """,
                    entrega_id,
                    evidencia_url,
                    hash_evidencia,
                )

            if traslado_url:
                # Solo llega hasta aca si ya paso el gate de sede de arriba
                # (o el tipo no tenia sede duena, en cuyo caso esto es un
                # traslado_url que no hacia falta pero tampoco molesta) --
                # se guarda como "el traslado vigente" de esta entrega, mismo
                # campo que ya usa procesar_extraccion al crear.
                # El codigo propio del traslado (leido en el router) solo pisa
                # el guardado si se pudo leer -- coalesce conserva el anterior.
                await conn.execute(
                    """
                    update entregas
                    set traslado_url = $2,
                        traslado_tipo = coalesce($3, traslado_tipo),
                        traslado_indicativo_numero = coalesce($4, traslado_indicativo_numero),
                        actualizado_at = now()
                    where id = $1::uuid
                    """,
                    entrega_id,
                    traslado_url,
                    traslado_tipo,
                    traslado_indicativo_numero,
                )

            if firma_url:
                await conn.execute(
                    "update entregas set firma_url = $2, actualizado_at = now() where id = $1::uuid",
                    entrega_id,
                    firma_url,
                )

            if es_faia is not None:
                # None significa "no tocar" (correccion parcial desde el
                # dashboard sin marcar/desmarcar FAIA) -- distinto de False.
                # Solo punto_venta puede CAMBIAR el flag -- lo hace desde el
                # modal de PantallaCapturaFoto, con `items` vacio (si viniera
                # con items, ya se rechazo mas arriba). Si el valor pedido es
                # igual al que ya tenia no es una modificacion real (el
                # bodeguero siempre reenvia el valor tal cual lo recibio,
                # nunca lo puede tocar del lado mobile) -- eso se deja pasar
                # sin chequear rol. Si difiere y quien llama no es
                # punto_venta, se ignora el cambio en vez de rechazar todo el
                # request (no hay que romperle la confirmacion de cantidades
                # por esto).
                fila_actual = await conn.fetchrow(
                    "select es_faia from entregas where id = $1::uuid", entrega_id
                )
                valor_actual = fila_actual["es_faia"] if fila_actual is not None else False
                if es_faia != valor_actual:
                    # Reusa el fila_empleado ya resuelto al principio de la
                    # funcion (mismo operador_id) en vez de repetir la consulta.
                    permitido = fila_empleado is not None and fila_empleado["rol"] == "punto_venta"
                else:
                    permitido = True
                if permitido:
                    await conn.execute(
                        "update entregas set es_faia = $2, actualizado_at = now() where id = $1::uuid",
                        entrega_id,
                        es_faia,
                    )

            if nota_general is not None:
                # None significa "no tocar" -- "" (vacio) SI borra la nota,
                # a diferencia de es_faia no hay chequeo de rol: el cliente
                # mobile solo expone este campo en Confirmando (bodeguero),
                # a donde punto_venta ya no llega (ver PantallaCapturaFoto).
                await conn.execute(
                    "update entregas set nota_general = $2, actualizado_at = now() where id = $1::uuid",
                    entrega_id,
                    nota_general,
                )

            # Quien cerro cada item enviado en esta llamada: si queda en pendiente
            # 0 se registra al actor (y si fue del punto de venta); si queda con
            # pendiente se limpia (el item se reabrio). Solo items que cambiaron
            # cantidades: una nota suelta sobre un item ya bloqueado no debe
            # pisar a quien lo entrego.
            for item in items:
                if item.cantidad_pendiente is None and not (item.entregado_hoy or 0) and not item.desde_punto_venta and not item.desde_otra_bodega:
                    continue
                if es_correccion_dashboard:
                    # El admin no pasa a ser "quien entrego": solo se limpia si
                    # su correccion reabrio el item (vuelve a tener pendiente).
                    await conn.execute(
                        """
                        update entrega_items
                        set entregado_por = null, entregado_en_punto_venta = false,
                            entregado_en_otra_bodega = false
                        where id = $1::uuid and entrega_id = $2::uuid and cantidad_pendiente > 0
                        """,
                        item.id,
                        entrega_id,
                    )
                    continue
                await conn.execute(
                    """
                    update entrega_items
                    set entregado_por = case when cantidad_pendiente = 0 then $2 else null end,
                        entregado_en_punto_venta = (cantidad_pendiente = 0 and $3),
                        entregado_en_otra_bodega = (cantidad_pendiente = 0 and $5)
                    where id = $1::uuid and entrega_id = $4::uuid
                    """,
                    item.id,
                    operador_id,
                    item.desde_punto_venta,
                    entrega_id,
                    item.desde_otra_bodega,
                )

            items_actualizados = await _items_de_entrega(conn, entrega_id)

            for despues in items_actualizados:
                previo = antes.get(despues.id)
                if previo is None:
                    continue
                for campo in ("descripcion", "cantidad_entregada", "cantidad_pendiente"):
                    if previo[campo] != getattr(despues, campo):
                        cambios.append(
                            {
                                "item_id": despues.id,
                                "producto": despues.descripcion,
                                "campo": campo,
                                "antes": previo[campo],
                                "despues": getattr(despues, campo),
                            }
                        )

            # Se valida sobre el resultado final (dentro de la transaccion: al
            # lanzar, se deshace todo lo anterior). "Entregado todo" significa
            # que ningun item queda pendiente.
            con_pendiente = [
                i for i in items_actualizados if i.id in ids_no_acreditados and i.cantidad_pendiente > 0
            ]
            if con_pendiente:
                etiqueta = "Entregado en otra bodega" if con_pendiente[0].id in ids_otra_bodega else "Entregado en el punto de venta"
                raise CantidadInvalida(
                    f"'{etiqueta}' exige que no quede nada pendiente, "
                    f"pero '{con_pendiente[0].descripcion}' aun tiene {con_pendiente[0].cantidad_pendiente} pendiente."
                )

    await registrar_evento(
        EventoLog.ENTREGA_ACTUALIZADA,
        entidad_tipo="entrega",
        entidad_id=entrega_id,
        actor_id=operador_id,
        sede_id=sede_id,
        resultado="ok",
        detalle={
            "items": [
                {
                    "id": i.id,
                    "cantidad_entregada": i.cantidad_entregada,
                    "cantidad_pendiente": i.cantidad_pendiente,
                    # Solo presente en los items marcados en esta visita.
                    **({"desde_punto_venta": True} if i.id in ids_punto_venta else {}),
                    **({"desde_otra_bodega": True} if i.id in ids_otra_bodega else {}),
                }
                for i in items_actualizados
            ],
            "evidencia_url": evidencia_url,
            # Solo presente cuando esta visita se firmo (ver RetiradoPor) --
            # no hay columna ni tabla nueva, el historial de quien retiro
            # cada visita se arma leyendo estos eventos (ver GET /logs).
            "retirado_por": retirado_por.model_dump() if retirado_por else None,
            # Solo presente cuando TODA la visita fue del punto de venta (todos
            # los items enviados marcados): el dashboard y resumen-hoy la
            # excluyen del conteo de bodega.
            **({"desde_punto_venta": True} if items and len(ids_punto_venta) == len(items) else {}),
            # Idem para "otra bodega" (solo remisiones).
            **({"desde_otra_bodega": True} if items and len(ids_otra_bodega) == len(items) else {}),
            # Solo en correcciones del dashboard: el dashboard las muestra
            # aparte ("Cambios del admin") y no las cuenta como visita de bodega.
            **({"correccion_dashboard": True, "cambios": cambios} if es_correccion_dashboard else {}),
        },
    )
    return items_actualizados


async def cancelar_entrega_no_confirmada(
    entrega_id: str, *, operador_id: str, sede_id: str
) -> bool:
    """El bodeguero le saca una foto a un documento, ve la pantalla de
    confirmacion (paso 2) y decide cancelar sin confirmar nada. El paso 1
    (procesar_extraccion) ya inserto la entrega -- es la barrera atomica
    contra la carrera entre sedes, no se puede evitar eso -- asi que
    "cancelar" en la practica significa deshacer ese insert.

    Solo borra si TODAVIA nadie confirmo nada: cada item sigue con
    actualizado_at == creado_at (mismo campo que expone _items_de_entrega
    como "confirmado"), que es exactamente como queda un item recien
    insertado por procesar_extraccion, antes de que
    aplicar_actualizacion_items lo toque. NO se usa "cantidad_pendiente ==
    cantidad_entregada" (equivalente antes de que cantidad_entregada
    arrancara en 0 en vez de en cantidad, ver el insert de arriba) -- con el
    seed en 0 esa igualdad ya nunca se cumple salvo que la cantidad leida sea
    0, asi que dejaria de poder cancelarse cualquier entrega nueva. Esto
    evita dos cosas: borrar una entrega real que ya tenia historial (nunca
    deberia pasar, pero mejor prevenir por las dudas), y una carrera rara
    donde otra sede ya la actualizo mientras este bodeguero decidia cancelar.

    Idempotente: si el id no existe o ya se confirmo algo, no hace nada y
    devuelve False -- cancelar nunca deberia ser un error para el movil.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        resultado = await conn.execute(
            """
            delete from entregas
            where id = $1::uuid
              and not exists (
                  select 1 from entrega_items
                  where entrega_id = $1::uuid and actualizado_at > creado_at
              )
            """,
            entrega_id,
        )

    borrado = resultado == "DELETE 1"
    if borrado:
        await registrar_evento(
            EventoLog.ENTREGA_CANCELADA,
            entidad_tipo="entrega",
            entidad_id=entrega_id,
            actor_id=operador_id,
            sede_id=sede_id,
            resultado="ok",
        )
    return borrado
