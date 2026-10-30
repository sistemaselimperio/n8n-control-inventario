"""Flujos de traslados contra Postgres real: despacho -> recepcion (con y sin
novedad) -> solucion de la novedad, llegadas directas, numero Syscafe y los
listados de Supervision. La IA y el almacenamiento nunca se tocan."""

import asyncio
import uuid

import asyncpg
import pytest

from app.models.traslado_punto import SolucionNovedad
from app.services import traslados_puntos as tp
from app.services.talonarios import TalonarioConflicto, obtener_talonarios_activos
from tests.integration.conftest import eventos_en_logs
from tests.integration.datos_traslados import (
    configurar,
    crear_supervisor,
    crear_usuario_punto,
    escenario,
    fila_traslado,
    hojas_usadas,
    llegada,
    recepcion,
    traslado,
)

pytestmark = pytest.mark.integration


def solucion(esc, **extra) -> SolucionNovedad:
    cuerpo = {
        "supervisor_id": esc.supervisor,
        "solucion": "Se repuso lo faltante",
        "consecutivo_codigo": "cfc",
        "consecutivo_numero": "0012",
    }
    cuerpo.update(extra)
    return SolucionNovedad(**cuerpo)


def _con_id_texto(resultado: dict) -> dict:
    """Los servicios devuelven el id como UUID (el router lo serializa); los demas
    servicios lo reciben como texto, igual que cuando lo llama el router."""
    resultado["id"] = str(resultado["id"])
    return resultado


async def despachar(esc, hoja="A 6300", **extra) -> dict:
    return _con_id_texto(await tp.crear_traslado(traslado(esc, hoja, **extra)))


async def llegar(esc, hoja="A 100", **extra) -> dict:
    return _con_id_texto(await tp.crear_llegada_directa(llegada(esc, hoja, **extra)))


def ids_items(creado: dict) -> dict[str, str]:
    """producto -> id del item, para armar la recepcion."""
    return {i["producto"]: str(i["id"]) for i in creado["items"]}


@pytest.fixture
async def esc(pg):
    escenario_listo = await escenario(pg)
    await configurar(pg, escenario_listo.origen, escenario_listo.usuario_origen)
    await configurar(pg, escenario_listo.destino, escenario_listo.usuario_destino, inicial=100)
    return escenario_listo


# ---------------------------------------------------------------------------
# Despacho -> recepcion
# ---------------------------------------------------------------------------


async def test_despacho_nace_en_transito_con_sus_items_y_la_hoja_tomada(pg, esc):
    creado = await despachar(esc)
    assert creado["estado"] == "en_transito" and creado["tipo"] == "entre_puntos"
    assert creado["numero_talonario"] == "A 6300"
    assert sorted((i["producto"], i["cantidad"], i["cantidad_recibida"]) for i in creado["items"]) == [
        ("AZUCAR", 5, None), ("SAL BLANCA", 10, None),
    ]
    fila = await fila_traslado(pg, creado["id"])
    assert fila["talonario_id"] == await pg.fetchval("select id from talonarios_punto where punto_id = $1::uuid", esc.origen)
    assert fila["novedad_estado"] is None and fila["recibido_at"] is None


async def test_recepcion_completa_cierra_el_traslado_sin_novedad(pg, esc):
    creado = await despachar(esc)
    ids = ids_items(creado)
    recibido = await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 10), (ids["AZUCAR"], 5)]))

    assert recibido["estado"] == "recibido" and recibido["novedad_estado"] is None
    assert str(recibido["recibido_por"]) == esc.usuario_destino and recibido["recibido_at"] is not None
    assert recibido["declaracion_aceptada_at"] is not None
    assert sorted(i["cantidad_recibida"] for i in recibido["items"]) == [5, 10]
    assert await eventos_en_logs(pg) == [
        "talonario_configurado", "talonario_configurado", "traslado_punto_creado", "traslado_punto_recibido",
    ]


async def test_recepcion_con_faltante_queda_con_novedad_pendiente_y_dos_eventos(pg, esc):
    creado = await despachar(esc)
    ids = ids_items(creado)
    recibido = await tp.registrar_recepcion(
        creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 7), (ids["AZUCAR"], 5)], novedad="faltaron 3 de sal")
    )
    assert (recibido["estado"], recibido["novedad_estado"], recibido["novedad"]) == (
        "recibido_con_novedad", "pendiente", "faltaron 3 de sal",
    )
    eventos = await eventos_en_logs(pg)
    assert eventos[-2:] == ["traslado_punto_recibido", "traslado_punto_novedad"]


async def test_recepcion_no_acepta_mas_de_lo_enviado_y_no_cambia_nada(pg, esc):
    creado = await despachar(esc)
    ids = ids_items(creado)
    with pytest.raises(tp.TrasladoInvalido):
        await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 11)]))
    fila = await fila_traslado(pg, creado["id"])
    assert fila["estado"] == "en_transito" and fila["recibido_at"] is None
    assert await pg.fetchval("select count(*) from traslado_punto_items where cantidad_recibida is not null") == 0
    assert "traslado_punto_recibido" not in await eventos_en_logs(pg)


async def test_recepcion_con_item_de_otro_traslado_se_rechaza(pg, esc):
    uno = await despachar(esc, "A 6300")
    otro = await despachar(esc, "A 6301")
    item_ajeno = ids_items(otro)["SAL BLANCA"]
    with pytest.raises(tp.TrasladoInvalido, match="no pertenece a este traslado"):
        await tp.registrar_recepcion(uno["id"], recepcion(esc, [(item_ajeno, 1)]))
    assert (await fila_traslado(pg, uno["id"]))["estado"] == "en_transito"


async def test_recepcion_de_un_traslado_inexistente(pg, esc):
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tp.registrar_recepcion(str(uuid.uuid4()), recepcion(esc, [(str(uuid.uuid4()), 1)]))


async def test_un_traslado_ya_recibido_no_se_puede_recibir_de_nuevo(pg, esc):
    creado = await despachar(esc)
    ids = ids_items(creado)
    await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 10), (ids["AZUCAR"], 5)]))
    with pytest.raises(tp.TrasladoYaRecibido):
        await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 1)], novedad="otro"))
    # La segunda llamada no piso nada.
    fila = await fila_traslado(pg, creado["id"])
    assert (fila["estado"], fila["novedad"]) == ("recibido", None)
    assert await pg.fetchval("select cantidad_recibida from traslado_punto_items where id = $1::uuid", ids["SAL BLANCA"]) == 10
    assert (await eventos_en_logs(pg)).count("traslado_punto_recibido") == 1


async def test_dos_recepciones_simultaneas_solo_una_gana(pg, esc):
    creado = await despachar(esc)
    ids = ids_items(creado)
    completa = recepcion(esc, [(ids["SAL BLANCA"], 10), (ids["AZUCAR"], 5)])
    con_faltante = recepcion(esc, [(ids["SAL BLANCA"], 1), (ids["AZUCAR"], 1)], novedad="faltante")
    resultados = await asyncio.gather(
        tp.registrar_recepcion(creado["id"], completa),
        tp.registrar_recepcion(creado["id"], con_faltante),
        return_exceptions=True,
    )
    errores = [r for r in resultados if isinstance(r, BaseException)]
    assert len(errores) == 1 and isinstance(errores[0], tp.TrasladoYaRecibido)
    ganador = next(r for r in resultados if not isinstance(r, BaseException))
    # Lo que queda en la base es exactamente lo del ganador: no se mezclan items de las dos.
    fila = await fila_traslado(pg, creado["id"])
    assert fila["estado"] == ganador["estado"]
    recibidas = sorted(f["cantidad_recibida"] for f in await pg.fetch("select cantidad_recibida from traslado_punto_items"))
    assert recibidas == sorted(i["cantidad_recibida"] for i in ganador["items"])
    assert (await eventos_en_logs(pg)).count("traslado_punto_recibido") == 1


# ---------------------------------------------------------------------------
# Solucion de la novedad
# ---------------------------------------------------------------------------


async def traslado_con_novedad(pg, esc, hoja="A 6300") -> str:
    creado = await despachar(esc, hoja)
    ids = ids_items(creado)
    await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 2), (ids["AZUCAR"], 5)]))
    return creado["id"]


async def test_flujo_completo_hasta_resolver_la_novedad(pg, esc):
    traslado_id = await traslado_con_novedad(pg, esc)
    resuelto = await tp.resolver_novedad(traslado_id, solucion(esc))

    assert resuelto["novedad_estado"] == "resuelta"
    assert resuelto["consecutivo_solucion"] == "CFC-0012"  # codigo en mayusculas, ceros conservados
    assert str(resuelto["solucionado_por"]) == esc.supervisor and resuelto["solucionado_at"] is not None
    assert resuelto["estado"] == "recibido_con_novedad"  # el estado del traslado no cambia al resolver
    assert len(resuelto["items"]) == 2
    assert (await eventos_en_logs(pg))[-1] == "traslado_punto_novedad_resuelta"


async def test_resolver_una_novedad_ya_resuelta_responde_conflicto(pg, esc):
    traslado_id = await traslado_con_novedad(pg, esc)
    await tp.resolver_novedad(traslado_id, solucion(esc))
    with pytest.raises(tp.NovedadYaResuelta):
        await tp.resolver_novedad(traslado_id, solucion(esc, consecutivo_numero="13", solucion="otra"))
    fila = await fila_traslado(pg, traslado_id)
    assert (fila["solucion"], fila["consecutivo_solucion"]) == ("Se repuso lo faltante", "CFC-0012")
    assert (await eventos_en_logs(pg)).count("traslado_punto_novedad_resuelta") == 1


async def test_el_mismo_consecutivo_no_se_puede_usar_en_dos_novedades(pg, esc):
    uno = await traslado_con_novedad(pg, esc, "A 6300")
    dos = await traslado_con_novedad(pg, esc, "A 6301")
    await tp.resolver_novedad(uno, solucion(esc))
    with pytest.raises(tp.ConsecutivoDuplicado):
        await tp.resolver_novedad(dos, solucion(esc))
    fila = await fila_traslado(pg, dos)
    assert (fila["novedad_estado"], fila["consecutivo_solucion"], fila["solucion"]) == ("pendiente", None, None)
    # Con otro consecutivo la segunda si se puede resolver.
    await tp.resolver_novedad(dos, solucion(esc, consecutivo_numero="13"))


async def test_consecutivos_con_distinto_cero_a_la_izquierda_son_distintos(pg, esc):
    uno = await traslado_con_novedad(pg, esc, "A 6300")
    dos = await traslado_con_novedad(pg, esc, "A 6301")
    await tp.resolver_novedad(uno, solucion(esc, consecutivo_numero="12"))
    await tp.resolver_novedad(dos, solucion(esc, consecutivo_numero="012"))  # se guarda tal cual se escribio
    assert sorted(f["consecutivo_solucion"] for f in await pg.fetch("select consecutivo_solucion from traslados_puntos")) == ["CFC-012", "CFC-12"]


async def test_dos_supervisores_resolviendo_a_la_vez_solo_uno_gana(pg, esc):
    traslado_id = await traslado_con_novedad(pg, esc)
    otro_supervisor = await crear_supervisor(pg, "Otra")
    resultados = await asyncio.gather(
        tp.resolver_novedad(traslado_id, solucion(esc, consecutivo_numero="1")),
        tp.resolver_novedad(traslado_id, solucion(esc, supervisor_id=otro_supervisor, consecutivo_numero="2")),
        return_exceptions=True,
    )
    errores = [r for r in resultados if isinstance(r, BaseException)]
    assert len(errores) == 1 and isinstance(errores[0], tp.NovedadYaResuelta)
    assert (await eventos_en_logs(pg)).count("traslado_punto_novedad_resuelta") == 1
    ganador = next(r for r in resultados if not isinstance(r, BaseException))
    assert (await fila_traslado(pg, traslado_id))["consecutivo_solucion"] == ganador["consecutivo_solucion"]


async def test_resolver_exige_novedad_supervisor_activo_y_codigo_de_punto_valido(pg, esc):
    sin_novedad = await despachar(esc, "A 6300")
    with pytest.raises(tp.NovedadInvalida, match="no tiene una novedad"):
        await tp.resolver_novedad(sin_novedad["id"], solucion(esc))

    con_novedad = await traslado_con_novedad(pg, esc, "A 6301")
    inactivo = await crear_supervisor(pg, "Inactivo", "inactivo")
    with pytest.raises(tp.NovedadInvalida, match="Supervisor"):
        await tp.resolver_novedad(con_novedad, solucion(esc, supervisor_id=inactivo))
    with pytest.raises(tp.NovedadInvalida, match="Supervisor"):
        await tp.resolver_novedad(con_novedad, solucion(esc, supervisor_id=str(uuid.uuid4())))
    with pytest.raises(tp.NovedadInvalida, match="código de punto"):
        await tp.resolver_novedad(con_novedad, solucion(esc, consecutivo_codigo="ZZZ"))
    await pg.execute("update puntos set activo = false where codigo = 'CFC'")
    with pytest.raises(tp.NovedadInvalida, match="código de punto"):
        await tp.resolver_novedad(con_novedad, solucion(esc))
    assert (await fila_traslado(pg, con_novedad))["novedad_estado"] == "pendiente"
    with pytest.raises(tp.NovedadNoEncontrada):
        await tp.resolver_novedad(str(uuid.uuid4()), solucion(esc))


# ---------------------------------------------------------------------------
# Reglas que impone la base
# ---------------------------------------------------------------------------


async def test_creacion_de_traslado_valida_puntos_y_usuarios_contra_la_base(pg, esc):
    inactivo = await pg.fetchval("insert into puntos (nombre, codigo, activo) values ('Cerrado', 'CER', false) returning id")
    with pytest.raises(tp.TrasladoInvalido, match="destino no existe"):
        await despachar(esc, "A 6300", punto_destino_id=str(inactivo))
    with pytest.raises(tp.TrasladoInvalido, match="pertenecer al punto de origen"):
        await despachar(esc, "A 6300", creado_por=esc.usuario_destino)
    usuario_inactivo = await crear_usuario_punto(pg, esc.origen, "Baja", "inactivo")
    with pytest.raises(tp.TrasladoInvalido, match="pertenecer al punto de origen"):
        await despachar(esc, "A 6300", creado_por=usuario_inactivo)
    assert await pg.fetchval("select count(*) from traslados_puntos") == 0
    await despachar(esc, "A 6300")  # nada de lo anterior gasto la hoja


async def test_el_id_repetido_no_gasta_otra_hoja(pg, esc):
    primero = await despachar(esc, "A 6300")
    with pytest.raises(tp.TrasladoInvalido, match="Ya existe un traslado con ese id"):
        await despachar(esc, "A 6301", id=primero["id"])
    (activo,) = await obtener_talonarios_activos(esc.origen)
    assert activo["siguiente_hoja"] == "A 6301"  # la hoja del intento fallido sigue libre


async def test_la_base_exige_origen_distinto_de_destino_y_origen_nulo_solo_en_directas(pg, esc):
    base = "insert into traslados_puntos (id, tipo, punto_origen_id, punto_destino_id, fecha, creado_por) values (gen_random_uuid(), $1, $2, $3::uuid, current_date, $4::uuid)"
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute(base, "entre_puntos", uuid.UUID(esc.origen), esc.origen, esc.usuario_origen)
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute(base, "entre_puntos", None, esc.destino, esc.usuario_destino)
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute(base, "directo", uuid.UUID(esc.origen), esc.destino, esc.usuario_destino)
    with pytest.raises(asyncpg.CheckViolationError):
        await pg.execute(base, "otro", None, esc.destino, esc.usuario_destino)


# ---------------------------------------------------------------------------
# Llegada directa
# ---------------------------------------------------------------------------


async def test_llegada_directa_nace_recibida_sin_origen_y_gasta_una_hoja_del_punto_que_recibe(pg, esc):
    creada = await llegar(esc, "A 100")
    assert (creada["tipo"], creada["estado"], creada["punto_origen_id"]) == ("directo", "recibido", None)
    assert str(creada["punto_destino_id"]) == esc.destino and str(creada["recibido_por"]) == esc.usuario_destino
    assert creada["recibido_at"] is not None and creada["declaracion_aceptada_at"] is not None
    assert creada["novedad_estado"] is None
    assert [(i["producto"], i["cantidad"], i["cantidad_recibida"]) for i in creada["items"]] == [("ARROZ", 8, 8)]
    assert await hojas_usadas(pg, esc.destino) == ["A 100"]
    assert await hojas_usadas(pg, esc.origen) == []  # el talonario del origen no se toco
    assert (await eventos_en_logs(pg))[-1] == "llegada_directa_registrada"
    evento = await pg.fetchrow("select * from logs where evento = 'llegada_directa_registrada'")
    assert (evento["resultado"], evento["actor_id"], evento["sede_id"]) == ("recibido", esc.usuario_destino, esc.destino)


async def test_llegada_directa_respeta_la_secuencia_y_la_fecha_por_defecto(pg, esc):
    with pytest.raises(TalonarioConflicto, match="A 100"):
        await llegar(esc, "A 101")
    creada = await llegar(esc, "A 100")
    assert creada["fecha"] is not None  # sin fecha en el payload, la base pone la de hoy
    con_fecha = await llegar(esc, "A 101", fecha="2026-02-01")
    assert str(con_fecha["fecha"]) == "2026-02-01"


async def test_llegada_directa_con_novedad_entra_al_flujo_de_supervision(pg, esc):
    creada = await llegar(esc, "A 100", novedad="caja golpeada")
    assert (creada["estado"], creada["novedad_estado"], creada["novedad"]) == ("recibido_con_novedad", "pendiente", "caja golpeada")
    resuelta = await tp.resolver_novedad(creada["id"], solucion(esc))
    assert resuelta["novedad_estado"] == "resuelta"
    assert await pg.fetchval("select count(*) from traslados_puntos where novedad_estado = 'pendiente'") == 0


async def test_llegada_directa_solo_con_texto_libre(pg, esc):
    creada = await llegar(esc, "A 100", items=[], contenido_texto="  10 bultos\n de sal  ")
    assert creada["items"] == [] and creada["contenido_texto"] == "10 bultos de sal"
    assert await pg.fetchval("select count(*) from traslado_punto_items") == 0


async def test_llegada_directa_invalida_no_gasta_la_hoja(pg, esc):
    with pytest.raises(tp.TrasladoInvalido):
        await llegar(esc, "A 100", items=[], contenido_texto=None)
    with pytest.raises(tp.TrasladoInvalido):
        await llegar(esc, "A 100", declaracion_aceptada=False)
    with pytest.raises(tp.TrasladoInvalido, match="pertenecer al punto"):
        await llegar(esc, "A 100", creado_por=esc.usuario_origen)
    assert await hojas_usadas(pg, esc.destino) == []
    await llegar(esc, "A 100")


async def test_llegada_directa_no_puede_recibirse_otra_vez(pg, esc):
    creada = await llegar(esc, "A 100")
    item = str(creada["items"][0]["id"])
    with pytest.raises(tp.TrasladoYaRecibido):
        await tp.registrar_recepcion(creada["id"], recepcion(esc, [(item, 8)]))


# ---------------------------------------------------------------------------
# Numero Syscafe
# ---------------------------------------------------------------------------


async def test_syscafe_se_normaliza_se_guarda_con_auditoria_y_no_escribe_en_logs(pg, esc):
    creado = await despachar(esc)
    logs_antes = await eventos_en_logs(pg)
    asignado = await tp.asignar_numero_syscafe(creado["id"], "nbr 945", "Erika")
    assert asignado["numero_syscafe"] == "NBR-945"
    assert (asignado["numero_syscafe_por"], asignado["numero_syscafe_at"] is not None) == ("Erika", True)
    assert len(asignado["items"]) == 2
    assert await eventos_en_logs(pg) == logs_antes


async def test_syscafe_repetido_en_otro_traslado_se_rechaza_nombrando_la_hoja(pg, esc):
    uno = await despachar(esc, "A 6300")
    dos = await despachar(esc, "A 6301")
    await tp.asignar_numero_syscafe(uno["id"], "NBR-945")
    with pytest.raises(tp.SyscafeDuplicado) as exc:
        await tp.asignar_numero_syscafe(dos["id"], "nbr945")  # normaliza al mismo valor
    assert "NBR-945" in str(exc.value) and "A 6300" in str(exc.value)
    assert (await fila_traslado(pg, dos["id"]))["numero_syscafe"] is None


async def test_syscafe_repetido_nombra_tp_consecutivo_si_el_otro_no_tiene_talonario(pg, esc):
    uno = await despachar(esc, "A 6300")
    await pg.execute("update traslados_puntos set talonario_id = null, numero_talonario = null where id = $1::uuid", uno["id"])
    dos = await despachar(esc, "A 6300")
    await tp.asignar_numero_syscafe(uno["id"], "NBR-945")
    consecutivo = (await fila_traslado(pg, uno["id"]))["consecutivo"]
    with pytest.raises(tp.SyscafeDuplicado, match=f"TP-{consecutivo:06d}"):
        await tp.asignar_numero_syscafe(dos["id"], "NBR-945")


async def test_syscafe_reasignar_el_mismo_valor_al_mismo_traslado_es_valido(pg, esc):
    creado = await despachar(esc)
    await tp.asignar_numero_syscafe(creado["id"], "NBR-945", "Erika")
    otra_vez = await tp.asignar_numero_syscafe(creado["id"], "NBR-945", "Otra")
    assert otra_vez["numero_syscafe"] == "NBR-945" and otra_vez["numero_syscafe_por"] == "Otra"


async def test_syscafe_se_puede_borrar_y_reutilizar_en_otro_traslado(pg, esc):
    uno = await despachar(esc, "A 6300")
    dos = await despachar(esc, "A 6301")
    await tp.asignar_numero_syscafe(uno["id"], "NBR-945")
    borrado = await tp.asignar_numero_syscafe(uno["id"], None, "Erika")
    assert borrado["numero_syscafe"] is None and borrado["numero_syscafe_por"] == "Erika"  # el borrado tambien deja huella
    await tp.asignar_numero_syscafe(dos["id"], "NBR-945")
    assert (await fila_traslado(pg, dos["id"]))["numero_syscafe"] == "NBR-945"


async def test_varios_traslados_sin_syscafe_no_chocan_entre_si(pg, esc):
    uno = await despachar(esc, "A 6300")
    dos = await despachar(esc, "A 6301")
    await tp.asignar_numero_syscafe(uno["id"], "")
    await tp.asignar_numero_syscafe(dos["id"], None)
    assert await pg.fetchval("select count(*) from traslados_puntos where numero_syscafe is null") == 2


async def test_dos_syscafe_iguales_simultaneos_solo_uno_gana(pg, esc):
    uno = await despachar(esc, "A 6300")
    dos = await despachar(esc, "A 6301")
    resultados = await asyncio.gather(
        tp.asignar_numero_syscafe(uno["id"], "NBR-945"), tp.asignar_numero_syscafe(dos["id"], "NBR-945"), return_exceptions=True
    )
    errores = [r for r in resultados if isinstance(r, BaseException)]
    assert len(errores) == 1 and isinstance(errores[0], tp.SyscafeDuplicado)
    assert await pg.fetchval("select count(*) from traslados_puntos where numero_syscafe = 'NBR-945'") == 1


async def test_syscafe_en_traslado_inexistente(pg, esc):
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tp.asignar_numero_syscafe(str(uuid.uuid4()), "NBR-945")


async def test_syscafe_valida_supervisor_activo(pg, esc):
    assert await tp.validar_supervisor_activo(esc.supervisor) == "Erika"
    inactivo = await crear_supervisor(pg, "Baja", "inactivo")
    for malo in (inactivo, str(uuid.uuid4()), "no-es-uuid"):
        with pytest.raises(tp.TrasladoInvalido, match="Supervisor invalido"):
            await tp.validar_supervisor_activo(malo)


# ---------------------------------------------------------------------------
# Listados
# ---------------------------------------------------------------------------


async def test_listado_syscafe_incluye_traslados_directas_y_anuladas_con_pendientes_primero(pg, esc):
    from app.models.talonario import HojaAnular
    from app.services.talonarios import anular_siguiente_hoja

    con_syscafe = await despachar(esc, "A 6300")
    sin_syscafe = await despachar(esc, "A 6301")
    directa = await llegar(esc, "A 100")
    await anular_siguiente_hoja(HojaAnular(punto_id=esc.origen, usuario_id=esc.usuario_origen, motivo="danada"))
    await tp.asignar_numero_syscafe(con_syscafe["id"], "NBR-945")

    todo = await tp.listar_traslados_syscafe(None, False)
    assert {(f["tipo"], f["numero_talonario"]) for f in todo} == {
        ("traslado", "A 6300"), ("traslado", "A 6301"), ("traslado", "A 100"), ("anulada", "A 6302"),
    }
    assert {f["id"] for f in todo if f["tipo"] == "traslado"} == {con_syscafe["id"], sin_syscafe["id"], directa["id"]}
    primeros = [f["numero_talonario"] for f in todo[:2]]
    assert sorted(primeros) == ["A 100", "A 6301"]  # los pendientes (sin Syscafe) van arriba
    assert all(isinstance(f["id"], str) for f in todo)

    pendientes = await tp.listar_traslados_syscafe(None, True)
    assert {f["numero_talonario"] for f in pendientes} == {"A 6301", "A 100"}  # sin anuladas ni asignados

    del_origen = await tp.listar_traslados_syscafe(esc.origen, False)
    assert {f["numero_talonario"] for f in del_origen} == {"A 6300", "A 6301", "A 6302"}
    del_destino = await tp.listar_traslados_syscafe(esc.destino, False)
    assert "A 100" in {f["numero_talonario"] for f in del_destino}  # la directa cuenta para el punto que recibe


async def test_actividad_cuenta_cada_hecho_una_vez_y_la_directa_no_se_duplica(pg, esc):
    creado = await despachar(esc, "A 6300")
    ids = ids_items(creado)
    await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 10), (ids["AZUCAR"], 5)]))
    await llegar(esc, "A 100")
    await tp.asignar_numero_syscafe(creado["id"], "NBR-945", "Erika")

    textos = [a["texto"] for a in await tp.listar_actividad(50)]
    assert any("envió A 6300" in t for t in textos)
    assert any("recibió A 6300" in t for t in textos)
    assert any("registró la llegada directa A 100" in t for t in textos)
    assert not any("recibió A 100" in t for t in textos)
    assert any("Erika asignó Syscafe NBR-945 a A 6300" in t for t in textos)
    assert len(await tp.listar_actividad(2)) == 2


async def test_historial_solo_trae_los_eventos_del_punto_en_orden(pg, esc):
    creado = await despachar(esc)
    ids = ids_items(creado)
    await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 2), (ids["AZUCAR"], 5)]))
    await tp.resolver_novedad(creado["id"], solucion(esc))
    historial = await tp.listar_historial(creado["id"])
    assert [h["evento"] for h in historial] == ["traslado_punto_creado", "traslado_punto_recibido", "traslado_punto_novedad"]
    assert historial[0]["actor_nombre"] == "Despachador" and historial[1]["actor_nombre"] == "Receptor"


async def test_listar_traslados_extraer_y_filtros_por_http(cliente, pg, esc):
    creado = await despachar(esc, "A 6300")
    directa = await llegar(esc, "A 100")
    ids = ids_items(creado)
    await tp.registrar_recepcion(creado["id"], recepcion(esc, [(ids["SAL BLANCA"], 2), (ids["AZUCAR"], 5)]))

    todos = (await cliente.get("/traslados-puntos")).json()
    assert {t["id"] for t in todos} == {creado["id"], directa["id"]}
    assert all(t["cantidad_items"] in (1, 2) for t in todos)

    solo_directas = (await cliente.get("/traslados-puntos", params={"tipo": "directo"})).json()
    assert [t["id"] for t in solo_directas] == [directa["id"]]
    assert solo_directas[0]["punto_origen_id"] is None and solo_directas[0]["punto_origen_nombre"] is None

    enviados = (await cliente.get("/traslados-puntos", params={"origen_id": esc.origen})).json()
    assert [t["id"] for t in enviados] == [creado["id"]]
    por_recibir = (await cliente.get("/traslados-puntos", params={"destino_id": esc.destino, "estado": "en_transito"})).json()
    assert por_recibir == []

    novedades = (await cliente.get("/traslados-puntos/novedades")).json()
    assert [t["id"] for t in novedades] == [creado["id"]]
    await tp.resolver_novedad(creado["id"], solucion(esc))
    assert (await cliente.get("/traslados-puntos/novedades")).json() == []
    resueltas = (await cliente.get("/traslados-puntos/novedades", params={"estado": "resuelta"})).json()
    assert [t["id"] for t in resueltas] == [creado["id"]]
    encontrados = (await cliente.get("/traslados-puntos/buscar-consecutivo", params={"q": "cfc-00"})).json()
    assert [t["id"] for t in encontrados] == [creado["id"]]
    assert (await cliente.get("/traslados-puntos/buscar-consecutivo", params={"q": "zzz"})).json() == []

    detalle = (await cliente.get(f"/traslados-puntos/{creado['id']}")).json()
    assert len(detalle["items"]) == 2 and detalle["recibido_por_nombre"] == "Receptor"
    assert (await cliente.get(f"/traslados-puntos/{uuid.uuid4()}")).status_code == 404


async def test_flujo_completo_por_http(cliente, pg, esc):
    cuerpo = traslado(esc, "A 6300").model_dump(mode="json")
    creado = await cliente.post("/traslados-puntos", json=cuerpo)
    assert creado.status_code == 201
    repetido = await cliente.post("/traslados-puntos", json={**cuerpo, "id": str(uuid.uuid4())})
    assert repetido.status_code == 409 and "A 6301" in repetido.json()["detail"]

    items = {i["producto"]: i["id"] for i in creado.json()["items"]}
    cuerpo_recepcion = recepcion(esc, [(items["SAL BLANCA"], 4), (items["AZUCAR"], 5)]).model_dump(mode="json")
    recibido = await cliente.post(f"/traslados-puntos/{cuerpo['id']}/recepcion", json=cuerpo_recepcion)
    assert recibido.status_code == 200 and recibido.json()["estado"] == "recibido_con_novedad"
    assert (await cliente.post(f"/traslados-puntos/{cuerpo['id']}/recepcion", json=cuerpo_recepcion)).status_code == 409

    cuerpo_solucion = solucion(esc).model_dump(mode="json")
    assert (await cliente.post(f"/traslados-puntos/{cuerpo['id']}/solucion", json=cuerpo_solucion)).status_code == 200
    assert (await cliente.post(f"/traslados-puntos/{cuerpo['id']}/solucion", json=cuerpo_solucion)).status_code == 409

    syscafe = await cliente.patch(
        f"/traslados-puntos/{cuerpo['id']}/syscafe", json={"supervisor_id": esc.supervisor, "numero_syscafe": "nbr 945"}
    )
    assert syscafe.status_code == 200 and syscafe.json()["numero_syscafe"] == "NBR-945"
    otro = await cliente.post("/traslados-puntos", json=traslado(esc, "A 6301").model_dump(mode="json"))
    choque = await cliente.patch(
        f"/traslados-puntos/{otro.json()['id']}/syscafe", json={"supervisor_id": esc.supervisor, "numero_syscafe": "NBR-945"}
    )
    assert choque.status_code == 409 and "A 6300" in choque.json()["detail"]


async def test_llegada_directa_por_http(cliente, pg, esc):
    cuerpo = llegada(esc, "A 100").model_dump(mode="json")
    creada = await cliente.post("/traslados-puntos/llegada-directa", json=cuerpo)
    assert creada.status_code == 201 and creada.json()["tipo"] == "directo"
    repetida = await cliente.post("/traslados-puntos/llegada-directa", json={**cuerpo, "id": str(uuid.uuid4())})
    assert repetida.status_code == 409
    sin_firma = await cliente.post("/traslados-puntos/llegada-directa", json={**cuerpo, "id": str(uuid.uuid4()), "numero_talonario": "A 101", "firma_recibe_url": ""})
    assert sin_firma.status_code == 422
    talonario = (await cliente.get(f"/puntos/{esc.destino}/talonario")).json()
    assert talonario["talonario"]["siguiente_hoja"] == "A 101"  # el rechazo por firma no gasto la hoja
