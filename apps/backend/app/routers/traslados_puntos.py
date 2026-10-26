"""Endpoints de puntos (bodegas del flujo de traslados, distintas de las
sedes de despachos) y del flujo de traslados entre puntos -- ver
app/services/traslados_puntos.py y el plan "traslados-entre-puntos". Todo en
un solo router (dos prefijos de path, /puntos y /traslados-puntos) porque son
el mismo flujo chico, igual que sedes/empleados son routers separados pero
ahi si son dos flujos con entidad propia bien grande cada uno.
"""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException

from app.db import get_pool
from app.models.empleado import PinNuevo
from app.models.punto import PinLoginPunto, PuntoActualizar, PuntoCrear, UsuarioPuntoActualizar, UsuarioPuntoCrear
from app.models.supervisor import PinLoginSupervisor, SupervisorActualizar, SupervisorCrear
from app.models.talonario import HojaAnular, TalonarioConfigurar
from app.models.traslado_punto import (
    AsignarSyscafe,
    AsignarSyscafeDashboard,
    ExtraerTalonario,
    LlegadaDirectaCrear,
    RecepcionTraslado,
    SolucionNovedad,
    TrasladoPuntoCrear,
    normalizar_numero_syscafe,
)
from app.services import borrado_admin
from app.services.permisos_dashboard import ActorDashboard, autorizar_admin, requiere_admin, requiere_supervisor_area
from app.services.auth_pin import generar_sal, hashear_pin, verificar_pin
from app.services.talonarios import (
    TalonarioConflicto,
    TalonarioInvalido,
    TalonarioNoDisponible,
    anular_siguiente_hoja,
    configurar_talonario,
    obtener_talonarios_activos,
    resumen_talonarios_puntos,
)
from app.services.traslados_puntos import (
    ConsecutivoDuplicado,
    NovedadInvalida,
    NovedadNoEncontrada,
    NovedadYaResuelta,
    SyscafeDuplicado,
    TrasladoInvalido,
    TrasladoNoEncontrado,
    TrasladoYaRecibido,
    asignar_numero_syscafe,
    crear_llegada_directa,
    crear_traslado,
    extraer_talonario,
    listar_actividad,
    listar_historial,
    listar_traslados_syscafe,
    registrar_recepcion,
    resolver_novedad,
    validar_supervisor_activo,
)
from app.services.vision import ExtraccionFallida
from app.services.usuarios import (
    DatoInvalido,
    RegistroNoEncontrado,
    actualizar_fila,
    crear_con_pin,
    resetear_pin,
)

router = APIRouter(tags=["traslados-puntos"])


def _sin_pin(row) -> dict:
    fila = dict(row)
    fila.pop("pin_hash", None)
    fila.pop("pin_salt", None)
    fila["id"] = str(fila["id"])
    if fila.get("punto_id") is not None:
        fila["punto_id"] = str(fila["punto_id"])
    return fila


@router.get("/puntos")
async def listar_puntos(
    incluir_inactivos: bool = False,
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
) -> list[dict]:
    """Publico solo con puntos activos (lo usa el movil); con
    incluir_inactivos=true exige sesion admin (o X-Admin-Token legacy) y agrega el campo activo
    (pantalla /creador)."""
    pool = await get_pool()
    if incluir_inactivos:
        await autorizar_admin(authorization, x_admin_token)
        rows = await pool.fetch(
            "select id, nombre, codigo, activo from puntos order by activo desc, codigo nulls last, nombre"
        )
        return [
            {"id": str(r["id"]), "nombre": r["nombre"], "codigo": r["codigo"], "activo": r["activo"]} for r in rows
        ]
    rows = await pool.fetch(
        "select id, nombre, codigo from puntos where activo = true order by codigo nulls last, nombre"
    )
    return [{"id": str(r["id"]), "nombre": r["nombre"], "codigo": r["codigo"]} for r in rows]


@router.post("/puntos", status_code=201, dependencies=[Depends(requiere_admin)])
async def crear_punto(payload: PuntoCrear) -> dict:
    """Alta de un punto -- protegida con X-Admin-Token (mismo mecanismo que
    el borrado definitivo de entregas, ver requiere_admin). Se usa
    desde la pantalla /creador del dashboard, desde aca o desde
    scripts/crear_punto.py."""
    pool = await get_pool()
    try:
        row = await pool.fetchrow(
            "insert into puntos (nombre) values ($1) returning id, nombre", payload.nombre
        )
    except Exception as exc:  # noqa: BLE001 - mismo criterio que crear_empleado/crear_sede
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": str(row["id"]), "nombre": row["nombre"]}


@router.get("/puntos/{punto_id}/usuarios")
async def listar_usuarios_punto(
    punto_id: str,
    incluir_inactivos: bool = False,
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
) -> list[dict]:
    """Publico solo con usuarios activos (lo usa el login movil); con
    incluir_inactivos=true exige sesion admin (o X-Admin-Token legacy) (pantalla /creador)."""
    if incluir_inactivos:
        await autorizar_admin(authorization, x_admin_token)
    filtro_estado = "" if incluir_inactivos else " and estado = 'activo'"
    pool = await get_pool()
    rows = await pool.fetch(
        f"select * from usuarios_punto where punto_id = $1::uuid{filtro_estado} order by estado, nombre",
        punto_id,
    )
    return [_sin_pin(r) for r in rows]


@router.post("/puntos/{punto_id}/usuarios", status_code=201, dependencies=[Depends(requiere_admin)])
async def crear_usuario_punto(punto_id: str, payload: UsuarioPuntoCrear) -> dict:
    pool = await get_pool()
    sal = generar_sal()
    pin_hash = hashear_pin(payload.pin, sal)
    try:
        row = await pool.fetchrow(
            """
            insert into usuarios_punto (nombre, punto_id, pin_hash, pin_salt)
            values ($1, $2::uuid, $3, $4)
            returning *
            """,
            payload.nombre,
            punto_id,
            pin_hash,
            sal,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _sin_pin(row)


@router.patch("/puntos/usuarios/{usuario_id}", dependencies=[Depends(requiere_admin)])
async def actualizar_usuario_punto(usuario_id: UUID, payload: UsuarioPuntoActualizar) -> dict:
    """Ruta con 3 segmentos (/puntos/usuarios/{id}): no colisiona con
    PATCH /puntos/{punto_id} (2 segmentos) ni con /puntos/{punto_id}/usuarios."""
    try:
        return await actualizar_fila("usuarios_punto", str(usuario_id), payload.model_dump(exclude_none=True))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Usuario de punto no encontrado") from exc
    except DatoInvalido as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/puntos/usuarios/{usuario_id}", dependencies=[Depends(requiere_admin)])
async def eliminar_usuario_punto(usuario_id: UUID) -> dict:
    """Borra el usuario de punto solo si nunca se uso; con historial responde 409 (se
    desactiva en su lugar). Ver app/services/borrado_admin.py."""
    try:
        await borrado_admin.eliminar_usuario_punto(str(usuario_id))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Usuario de punto no encontrado") from exc
    except borrado_admin.TieneHistorial as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/puntos/usuarios/{usuario_id}/pin", dependencies=[Depends(requiere_admin)])
async def resetear_pin_usuario_punto(usuario_id: UUID, payload: PinNuevo) -> dict:
    try:
        await resetear_pin("usuarios_punto", str(usuario_id), payload.pin)
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Usuario de punto no encontrado") from exc
    return {"ok": True}


@router.patch("/puntos/{punto_id}", dependencies=[Depends(requiere_admin)])
async def actualizar_punto(punto_id: UUID, payload: PuntoActualizar) -> dict:
    try:
        return await actualizar_fila("puntos", str(punto_id), payload.model_dump(exclude_none=True))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Punto no encontrado") from exc
    except DatoInvalido as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/puntos/{punto_id}", dependencies=[Depends(requiere_admin)])
async def eliminar_punto(punto_id: UUID) -> dict:
    """Borra el punto solo si nunca se uso; con historial responde 409 (se
    desactiva en su lugar). Ver app/services/borrado_admin.py."""
    try:
        await borrado_admin.eliminar_punto(str(punto_id))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Punto no encontrado") from exc
    except borrado_admin.TieneHistorial as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/puntos/auth/pin")
async def login_pin_punto(payload: PinLoginPunto) -> dict:
    """Mismo patron que POST /auth/pin de empleados (app/routers/auth.py) --
    el usuario de punto ya se eligio en el paso anterior del login movil, el
    PIN solo confirma esa identidad puntual."""
    pool = await get_pool()
    candidato = await pool.fetchrow(
        "select * from usuarios_punto where id = $1::uuid and estado = 'activo' and pin_hash is not null",
        payload.usuario_id,
    )
    if candidato and verificar_pin(payload.pin, candidato["pin_salt"], candidato["pin_hash"]):
        return {
            "id": str(candidato["id"]),
            "nombre": candidato["nombre"],
            "punto_id": str(candidato["punto_id"]),
        }
    raise HTTPException(status_code=401, detail="PIN incorrecto")


@router.get("/supervisores")
async def listar_supervisores(
    incluir_inactivos: bool = False,
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
) -> list[dict]:
    """Publico solo con supervisores activos (lo usa el login movil); con
    incluir_inactivos=true exige sesion admin (o X-Admin-Token legacy) y agrega el estado."""
    pool = await get_pool()
    if incluir_inactivos:
        await autorizar_admin(authorization, x_admin_token)
        rows = await pool.fetch("select id, nombre, estado from supervisores order by estado, nombre")
        return [{"id": str(r["id"]), "nombre": r["nombre"], "estado": r["estado"]} for r in rows]
    rows = await pool.fetch("select id, nombre from supervisores where estado = 'activo' order by nombre")
    return [{"id": str(r["id"]), "nombre": r["nombre"]} for r in rows]


@router.post("/supervisores", status_code=201, dependencies=[Depends(requiere_admin)])
async def crear_supervisor(payload: SupervisorCrear) -> dict:
    """Alta de un supervisor con PIN (equivale a scripts/crear_supervisor.py,
    pero sin la rama de "si ya existe, cambiale el PIN": para eso esta el
    reset de PIN)."""
    try:
        fila = await crear_con_pin("supervisores", {"nombre": payload.nombre}, payload.pin)
    except DatoInvalido as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": fila["id"], "nombre": fila["nombre"], "estado": fila["estado"]}


@router.post("/supervisores/auth/pin")
async def login_pin_supervisor(payload: PinLoginSupervisor) -> dict:
    """Mismo patron que POST /puntos/auth/pin -- el supervisor ya se eligio
    en el paso anterior del login movil (hoy solo Erika), el PIN solo
    confirma esa identidad."""
    pool = await get_pool()
    candidato = await pool.fetchrow(
        "select * from supervisores where id = $1::uuid and estado = 'activo' and pin_hash is not null",
        payload.supervisor_id,
    )
    if candidato and verificar_pin(payload.pin, candidato["pin_salt"], candidato["pin_hash"]):
        return {"id": str(candidato["id"]), "nombre": candidato["nombre"]}
    raise HTTPException(status_code=401, detail="PIN incorrecto")


# OJO: estas rutas con {supervisor_id} tienen que declararse DESPUES de
# POST /supervisores/auth/pin -- FastAPI resuelve por orden de registro y,
# si quedaran antes, "auth" caeria en el path param (UUID) y daria 422.
@router.patch("/supervisores/{supervisor_id}", dependencies=[Depends(requiere_admin)])
async def actualizar_supervisor(supervisor_id: UUID, payload: SupervisorActualizar) -> dict:
    try:
        return await actualizar_fila("supervisores", str(supervisor_id), payload.model_dump(exclude_none=True))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Supervisor no encontrado") from exc
    except DatoInvalido as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/supervisores/{supervisor_id}", dependencies=[Depends(requiere_admin)])
async def eliminar_supervisor(supervisor_id: UUID) -> dict:
    """Borra el supervisor solo si nunca se uso; con historial responde 409 (se
    desactiva en su lugar). Ver app/services/borrado_admin.py."""
    try:
        await borrado_admin.eliminar_supervisor(str(supervisor_id))
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Supervisor no encontrado") from exc
    except borrado_admin.TieneHistorial as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/supervisores/{supervisor_id}/pin", dependencies=[Depends(requiere_admin)])
async def resetear_pin_supervisor(supervisor_id: UUID, payload: PinNuevo) -> dict:
    try:
        await resetear_pin("supervisores", str(supervisor_id), payload.pin)
    except RegistroNoEncontrado as exc:
        raise HTTPException(status_code=404, detail="Supervisor no encontrado") from exc
    return {"ok": True}


_SELECT_TRASLADOS = """
    select t.*, po.nombre as punto_origen_nombre, pd.nombre as punto_destino_nombre,
        s.nombre as solucionado_por_nombre, uc.nombre as creado_por_nombre,
        ur.nombre as recibido_por_nombre,
        (select count(*) from traslado_punto_items ti where ti.traslado_id = t.id) as cantidad_items
    from traslados_puntos t
    left join puntos po on po.id = t.punto_origen_id
    left join puntos pd on pd.id = t.punto_destino_id
    left join supervisores s on s.id = t.solucionado_por
    left join usuarios_punto uc on uc.id = t.creado_por
    left join usuarios_punto ur on ur.id = t.recibido_por
"""

_CAMPOS_UUID_TRASLADO = (
    "id",
    "punto_origen_id",
    "punto_destino_id",
    "creado_por",
    "talonario_id",
    "recibido_por",
    "solucionado_por",
)


def _serializar_traslado(fila: dict, items: list[dict] | None = None) -> dict:
    """uuid -> str en los campos del traslado (y de sus items, si vienen) --
    asyncpg devuelve uuid.UUID crudo, que json no sabe serializar solo."""
    resultado = dict(fila)
    for campo in _CAMPOS_UUID_TRASLADO:
        if resultado.get(campo) is not None:
            resultado[campo] = str(resultado[campo])
    if items is not None:
        resultado["items"] = [
            {**item, "id": str(item["id"]), "traslado_id": str(item["traslado_id"])} for item in items
        ]
    return resultado


@router.post("/traslados-puntos", status_code=201)
async def crear_traslado_endpoint(payload: TrasladoPuntoCrear) -> dict:
    try:
        resultado = await crear_traslado(payload)
    except (TalonarioNoDisponible, TalonarioConflicto) as exc:
        # 409: conflicto de estado del talonario (sin talonario, agotado, o la
        # hoja ya la uso otra persona) -- el detail dice que hoja toca ahora.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TrasladoInvalido as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    items = resultado.pop("items")
    return _serializar_traslado(resultado, items)


@router.post("/traslados-puntos/llegada-directa", status_code=201)
async def crear_llegada_directa_endpoint(payload: LlegadaDirectaCrear) -> dict:
    """Registra mercancia que llega directo del proveedor al punto: nace ya
    recibida (sin bandeja) y consume una hoja del talonario del punto que
    recibe. Mismos 409/422 que POST /traslados-puntos."""
    try:
        resultado = await crear_llegada_directa(payload)
    except (TalonarioNoDisponible, TalonarioConflicto) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TrasladoInvalido as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    items = resultado.pop("items")
    return _serializar_traslado(resultado, items)


@router.post("/traslados-puntos/extraer")
async def extraer_talonario_endpoint(payload: ExtraerTalonario) -> dict:
    """Lee la foto del talonario (IA de vision) y devuelve encabezado, items,
    destino resuelto y `faltantes`. Es POST, asi que no colisiona con las
    rutas GET /traslados-puntos/{traslado_id}; igual se declara antes de las
    rutas con path param por consistencia con /novedades."""
    try:
        return await extraer_talonario(payload.foto_url, payload.punto_origen_id, payload.letra, payload.directo)
    except TalonarioNoDisponible as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ExtraccionFallida as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/puntos/{punto_id}/talonario")
async def obtener_talonario_punto(punto_id: UUID) -> dict:
    """Talonarios activos del punto (uno por letra) con la siguiente hoja,
    cuantas quedan y el rango. Sin talonarios responde 200 con
    `{"talonarios": [], "talonario": null}` (no es un error: es el estado
    inicial de un punto, la app muestra "Configura tu talonario").
    `talonario` (el primero) se mantiene para la app vieja."""
    talonarios = await obtener_talonarios_activos(str(punto_id))
    return {"talonarios": talonarios, "talonario": talonarios[0] if talonarios else None}


@router.get("/talonarios-puntos/resumen")
async def resumen_talonarios() -> list[dict]:
    """Todos los puntos con sus talonarios activos (lista vacia = sin
    configurar). Lo usa el dashboard en /traslados."""
    return await resumen_talonarios_puntos()


@router.post("/talonarios-puntos/configurar", status_code=201)
async def configurar_talonario_endpoint(payload: TalonarioConfigurar) -> dict:
    """Configura o cambia el talonario activo del punto. Si el activo no se
    agoto, `motivo` es obligatorio (422 si falta)."""
    try:
        return {"talonario": await configurar_talonario(payload)}
    except TalonarioConflicto as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TalonarioInvalido as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/talonarios-puntos/anular-hoja")
async def anular_hoja_endpoint(payload: HojaAnular) -> dict:
    """Anula la siguiente hoja pendiente del talonario activo (con motivo)."""
    try:
        return await anular_siguiente_hoja(payload)
    except TalonarioInvalido as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/traslados-puntos")
async def listar_traslados(
    # UUID (no str): un id mal formado responde 422 en vez de romper el
    # cast ::uuid de Postgres con un 500.
    destino_id: UUID | None = None,
    origen_id: UUID | None = None,
    estado: str | None = None,
    tipo: str | None = None,
) -> list[dict]:
    """Bandeja por recibir (destino_id) o enviados (origen_id) -- devuelve el
    conteo de items, no la lista completa (ver GET /traslados-puntos/{id}
    para el detalle con items). `tipo` ("entre_puntos" | "directo") filtra por
    clase de traslado; las llegadas directas no tienen origen, asi que solo
    salen con destino_id o sin filtro de punto."""
    if tipo is not None and tipo not in ("entre_puntos", "directo"):
        raise HTTPException(status_code=422, detail="tipo debe ser 'entre_puntos' o 'directo'")
    pool = await get_pool()
    condiciones: list[str] = []
    parametros: list[object] = []
    if destino_id:
        parametros.append(str(destino_id))
        condiciones.append(f"t.punto_destino_id = ${len(parametros)}::uuid")
    if origen_id:
        parametros.append(str(origen_id))
        condiciones.append(f"t.punto_origen_id = ${len(parametros)}::uuid")
    if estado:
        parametros.append(estado)
        condiciones.append(f"t.estado = ${len(parametros)}")
    if tipo:
        parametros.append(tipo)
        condiciones.append(f"t.tipo = ${len(parametros)}")
    where = f" where {' and '.join(condiciones)}" if condiciones else ""
    rows = await pool.fetch(_SELECT_TRASLADOS + where + " order by t.created_at desc limit 100", *parametros)
    return [_serializar_traslado(dict(r)) for r in rows]


@router.get("/traslados-puntos/novedades")
async def listar_novedades(estado: str = "pendiente") -> list[dict]:
    """Bandeja de Supervision: traslados con novedad -- pendientes (el que
    lleva mas tiempo esperando, primero) o resueltas (la mas reciente,
    primero). OJO: esta ruta tiene que declararse ANTES que
    GET /traslados-puntos/{traslado_id} en este archivo -- FastAPI resuelve
    por orden de registro, y si quedara despues "novedades" caeria en el path
    param y Pydantic la rechazaria como un UUID invalido (422) en vez de
    listar."""
    pool = await get_pool()
    orden = "t.recibido_at asc" if estado == "pendiente" else "t.solucionado_at desc"
    rows = await pool.fetch(
        _SELECT_TRASLADOS + " where t.novedad_estado = $1 order by " + orden + " limit 200",
        estado,
    )
    return [_serializar_traslado(dict(r)) for r in rows]


@router.get("/traslados-puntos/buscar-consecutivo")
async def buscar_consecutivo_traslado(q: str = "") -> list[dict]:
    """Busqueda de Supervision por consecutivo (ej. "NPT-1234", ver
    resolver_novedad en app/services/traslados_puntos.py). OJO: mismo motivo
    que /novedades arriba -- esta ruta tiene que declararse ANTES que
    GET /traslados-puntos/{traslado_id} en este archivo, o el path param se
    la come primero."""
    texto = q.strip()
    if not texto:
        return []
    pool = await get_pool()
    rows = await pool.fetch(
        _SELECT_TRASLADOS
        + " where t.novedad_estado = 'resuelta' and t.consecutivo_solucion ilike $1"
        + " order by t.solucionado_at desc limit 50",
        f"%{texto}%",
    )
    return [_serializar_traslado(dict(r)) for r in rows]


@router.get("/traslados-puntos/syscafe")
async def listar_syscafe(
    punto_id: UUID | None = None,
    pendientes: bool = False,
    desde: date | None = None,
    hasta: date | None = None,
) -> list[dict]:
    """Lista de Supervision para registrar el numero Syscafe: traslados (tipo
    "traslado") y hojas anuladas (tipo "anulada"), pendientes primero. OJO: mismo
    motivo que /novedades -- tiene que declararse ANTES que
    GET /traslados-puntos/{traslado_id}. `desde`/`hasta` (YYYY-MM-DD, inclusivos)
    filtran por la fecha del traslado y por la de creacion de las anuladas."""
    return await listar_traslados_syscafe(str(punto_id) if punto_id else None, pendientes, desde, hasta)


@router.get("/traslados-puntos/actividad")
async def actividad_traslados(limite: int = 50) -> list[dict]:
    """Feed de actividad reciente del panel de traslados (envios, recepciones,
    novedades resueltas, hojas anuladas y Syscafe asignados), lo mas reciente
    primero. OJO: tiene que declararse ANTES que GET /traslados-puntos/{traslado_id}."""
    return await listar_actividad(max(1, min(limite, 200)))


@router.get("/traslados-puntos/{traslado_id}")
async def obtener_traslado(traslado_id: UUID) -> dict:
    pool = await get_pool()
    row = await pool.fetchrow(_SELECT_TRASLADOS + " where t.id = $1::uuid", str(traslado_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Traslado no encontrado")
    items = await pool.fetch(
        "select * from traslado_punto_items where traslado_id = $1::uuid order by id", str(traslado_id)
    )
    return _serializar_traslado(dict(row), [dict(i) for i in items])


@router.get("/traslados-puntos/{traslado_id}/historial")
async def historial_traslado(traslado_id: UUID) -> list[dict]:
    """Eventos del punto sobre este traslado (envio, recepcion, novedad) para el
    expediente del dashboard. Sin auth, igual que GET /traslados-puntos/{id}."""
    return await listar_historial(str(traslado_id))


@router.post("/traslados-puntos/{traslado_id}/recepcion")
async def recibir_traslado(traslado_id: UUID, payload: RecepcionTraslado) -> dict:
    try:
        resultado = await registrar_recepcion(str(traslado_id), payload)
    except TrasladoNoEncontrado as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except TrasladoYaRecibido as exc:
        # 409 y no 422 -- es un conflicto de estado (ya lo recibio otro),
        # no un dato invalido (mismo criterio que EntregaDuplicada/
        # FacturaYaRegistrada en app/routers/entregas.py).
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TrasladoInvalido as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    items = resultado.pop("items")
    return _serializar_traslado(resultado, items)


@router.post("/traslados-puntos/{traslado_id}/solucion")
async def resolver_novedad_endpoint(traslado_id: UUID, payload: SolucionNovedad) -> dict:
    try:
        resultado = await resolver_novedad(str(traslado_id), payload)
    except NovedadNoEncontrada as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except NovedadYaResuelta as exc:
        # 409 y no 422 -- mismo criterio que TrasladoYaRecibido: es un
        # conflicto de estado (alguien mas ya la resolvio), no un dato
        # invalido.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConsecutivoDuplicado as exc:
        # 409 tambien, pero con un detail distinto del de NovedadYaResuelta
        # de arriba -- el movil necesita distinguir "alguien mas ya resolvio
        # esta novedad" (recargar y mostrar resuelta) de "el consecutivo que
        # tipeaste ya lo uso otra novedad" (quedarse en el formulario, ver
        # esErrorConsecutivoDuplicado en apps/mobile/errorMessages.ts).
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except NovedadInvalida as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    items = resultado.pop("items")
    return _serializar_traslado(resultado, items)


async def _asignar_syscafe(traslado_id: UUID, valor: str | None, por: str | None = None) -> dict:
    try:
        valor = normalizar_numero_syscafe(valor)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        resultado = await asignar_numero_syscafe(str(traslado_id), valor, por)
    except TrasladoNoEncontrado as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SyscafeDuplicado as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    items = resultado.pop("items")
    return _serializar_traslado(resultado, items)


@router.patch("/traslados-puntos/{traslado_id}/syscafe")
async def asignar_syscafe_movil(traslado_id: UUID, payload: AsignarSyscafe) -> dict:
    """Movil (Supervision): guarda o borra (null/vacio) el numero Syscafe."""
    try:
        nombre = await validar_supervisor_activo(payload.supervisor_id)
    except TrasladoInvalido as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await _asignar_syscafe(traslado_id, payload.numero_syscafe, nombre)


@router.patch("/traslados-puntos/{traslado_id}/syscafe/dashboard")
async def asignar_syscafe_dashboard(
    traslado_id: UUID,
    payload: AsignarSyscafeDashboard,
    actor: ActorDashboard = Depends(requiere_supervisor_area("todo", "traslados")),
) -> dict:
    """Dashboard: sesion admin/supervisor con area todo o traslados (o token legacy); `consulta` queda fuera."""
    # Nombre para el feed de actividad: el de la sesion; con el token legacy no hay usuario.
    nombre = actor.usuario["nombre"] if actor.usuario else "Administración"
    return await _asignar_syscafe(traslado_id, payload.numero_syscafe, nombre)
