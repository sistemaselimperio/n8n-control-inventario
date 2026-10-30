"""Servicio de talonarios (app/services/talonarios.py) con la base simulada:
toma de hojas, configuracion, anulacion y lecturas. Las funciones puras
(parsear_referencia, _estado, elegir_por_letra...) ya las cubre
test_reglas_de_negocio.py."""

import pytest

from app.models.talonario import HojaAnular, TalonarioConfigurar
from app.services import talonarios as tl
from tests.fakes import violacion_unica
from tests.helpers_traslados import (
    PUNTO_DESTINO,
    PUNTO_ORIGEN,
    TALONARIO_ID,
    USUARIO_ORIGEN,
    fila_talonario,
)

OTRO_TALONARIO = "77777777-7777-7777-7777-777777777777"


def _usadas(letra: str, desde: int, hasta: int) -> list[dict]:
    return [{"numero_talonario": f"{letra} {n}"} for n in range(desde, hasta + 1)]


# ---------------------------------------------------------------------------
# validar_y_tomar_hoja
# ---------------------------------------------------------------------------


def _activo(conn, *filas, bloqueada=True):
    """Talonarios activos del punto; `bloqueada` es la fila que devuelve el
    select ... for update (None simula que otro lo cerro entre la lectura y el lock)."""
    conn.responder("fetch", "select * from talonarios_punto where punto_id", list(filas))
    conn.responder("fetchrow", "for update", filas[0] if bloqueada is True else bloqueada)


async def test_tomar_hoja_devuelve_el_id_y_la_referencia_canonica(conn):
    _activo(conn, fila_talonario("A", 6300))
    assert await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "a-6300") == (TALONARIO_ID, "A 6300")


async def test_tomar_hoja_toma_el_lock_sobre_el_talonario_de_la_letra(conn):
    _activo(conn, fila_talonario("A", 6300))
    await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6300")
    (_, sql, args) = conn.sql_ejecutado("for update")[0]
    assert "estado = 'activo'" in sql  # revalida el estado ya con el lock
    assert args == (TALONARIO_ID,)


async def test_tomar_hoja_salta_las_usadas_y_anuladas(conn):
    _activo(conn, fila_talonario("A", 6300))
    conn.responder("fetch", "from traslados_puntos where talonario_id", _usadas("A", 6300, 6301))
    conn.responder("fetch", "from talonario_hojas_anuladas", [{"numero": 6302}])
    assert await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6303") == (TALONARIO_ID, "A 6303")


async def test_tomar_una_hoja_ya_usada_es_conflicto_y_dice_cual_toca(conn):
    _activo(conn, fila_talonario("A", 6300))
    conn.responder("fetch", "from traslados_puntos where talonario_id", _usadas("A", 6300, 6300))
    with pytest.raises(tl.TalonarioConflicto, match="A 6301"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6300")


async def test_tomar_una_hoja_saltandose_otra_es_conflicto(conn):
    _activo(conn, fila_talonario("A", 6300))
    with pytest.raises(tl.TalonarioConflicto, match="A 6300"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6302")


async def test_tomar_una_hoja_anulada_es_conflicto(conn):
    _activo(conn, fila_talonario("A", 6300))
    conn.responder("fetch", "from talonario_hojas_anuladas", [{"numero": 6300}])
    with pytest.raises(tl.TalonarioConflicto, match="A 6301"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6300")


async def test_tomar_hoja_sin_talonario_activo(conn):
    conn.responder("fetch", "select * from talonarios_punto where punto_id", [])
    with pytest.raises(tl.TalonarioNoDisponible, match="no tiene un talonario activo"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6300")


@pytest.mark.parametrize("texto", ["basura", "", "6300", "A"])
async def test_tomar_hoja_con_referencia_ilegible_es_conflicto_con_la_esperada(conn, texto):
    _activo(conn, fila_talonario("A", 6300))
    with pytest.raises(tl.TalonarioConflicto, match="Toma la foto de la hoja A 6300"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, texto)
    assert conn.sql_ejecutado("for update") == []


async def test_tomar_hoja_de_una_letra_que_el_punto_no_tiene(conn):
    _activo(conn, fila_talonario("A", 6300), fila_talonario("V", 100, talonario_id=OTRO_TALONARIO))
    with pytest.raises(tl.TalonarioConflicto, match="A 6300 o V 100"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "Z 5")


async def test_tomar_hoja_con_todos_los_talonarios_agotados_y_letra_desconocida(conn):
    _activo(conn, fila_talonario("A", 6300))
    conn.responder("fetch", "from traslados_puntos where talonario_id", _usadas("A", 6300, 6349))
    with pytest.raises(tl.TalonarioNoDisponible, match="agotado"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "Z 5")


async def test_tomar_hoja_de_un_talonario_agotado(conn):
    _activo(conn, fila_talonario("A", 6300))
    conn.responder("fetch", "from traslados_puntos where talonario_id", _usadas("A", 6300, 6349))
    with pytest.raises(tl.TalonarioNoDisponible, match="agotado"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6349")


async def test_tomar_hoja_si_el_talonario_cambio_mientras_tanto(conn):
    _activo(conn, fila_talonario("A", 6300), bloqueada=None)
    with pytest.raises(tl.TalonarioConflicto, match="acaba de cambiar"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6300")


async def test_tomar_hoja_respeta_numero_desde(conn):
    _activo(conn, fila_talonario("A", 6300, desde=6320))
    with pytest.raises(tl.TalonarioConflicto, match="A 6320"):
        await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6300")
    assert await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "A 6320") == (TALONARIO_ID, "A 6320")


async def test_dos_letras_en_paralelo_cada_una_con_su_siguiente(conn):
    fila_v = fila_talonario("V", 100, talonario_id=OTRO_TALONARIO)
    _activo(conn, fila_talonario("A", 6300), fila_v, bloqueada=fila_v)  # el lock recae sobre el talonario V
    assert await tl.validar_y_tomar_hoja(conn, PUNTO_ORIGEN, "V 100") == (OTRO_TALONARIO, "V 100")


# ---------------------------------------------------------------------------
# configurar_talonario
# ---------------------------------------------------------------------------


def _config(**extra) -> TalonarioConfigurar:
    cuerpo = {"punto_id": PUNTO_ORIGEN, "usuario_id": USUARIO_ORIGEN, "letra": "a", "numero_inicial": 6300}
    cuerpo.update(extra)
    return TalonarioConfigurar(**cuerpo)


def _conn_configurar(conn, *, activo=None, usadas=(), previos=0):
    conn.responder("fetchrow", "from usuarios_punto where id", {"punto_id": PUNTO_ORIGEN})
    conn.responder("fetchrow", "select id from puntos where id", {"id": PUNTO_ORIGEN})
    conn.responder("fetchrow", "and estado = 'activo' for update", activo)
    conn.responder("fetchval", "select count(*) from talonarios_punto", previos)
    conn.responder(
        "fetchrow", "insert into talonarios_punto",
        lambda *args: fila_talonario(args[1], args[2], talonario_id=OTRO_TALONARIO, desde=args[4]),
    )
    # La primera lectura de usadas es la del talonario que se cierra; la del nuevo arranca vacia.
    conn.responder("fetch", "from traslados_puntos where talonario_id", list(usadas), [])


async def test_configurar_primer_talonario_deja_evento(pool, conn):
    _conn_configurar(conn)
    nuevo = await tl.configurar_talonario(_config())
    assert (nuevo["letra"], nuevo["siguiente_hoja"], nuevo["quedan"]) == ("A", "A 6300", 50)
    assert conn.eventos_log() == ["talonario_configurado"]
    (_, tipo, entidad, actor, sede, res, detalle) = conn.inserts_log()[0]
    assert (tipo, entidad, actor, sede, res) == ("talonario_punto", OTRO_TALONARIO, USUARIO_ORIGEN, PUNTO_ORIGEN, "ok")
    assert detalle["desde"] is None
    assert detalle["hacia"]["desde_hoja"] == "A 6300"


async def test_configurar_talonario_el_final_es_inicial_mas_49(pool, conn):
    _conn_configurar(conn)
    await tl.configurar_talonario(_config(numero_inicial=100))
    (_, _, args) = conn.sql_ejecutado("insert into talonarios_punto")[0]
    assert (args[2], args[3]) == (100, 149)


@pytest.mark.parametrize("siguiente", [5999, 6350, 1])
async def test_configurar_siguiente_fuera_del_rango_se_rechaza_sin_tocar_la_base(pool, conn, siguiente):
    with pytest.raises(tl.TalonarioInvalido, match="entre 6300 y 6349"):
        await tl.configurar_talonario(_config(numero_siguiente=siguiente))
    assert conn.llamadas == []


async def test_configurar_talonario_ya_en_uso_arranca_en_la_hoja_indicada(pool, conn):
    _conn_configurar(conn)
    nuevo = await tl.configurar_talonario(_config(numero_siguiente=6320))
    assert (nuevo["siguiente_hoja"], nuevo["quedan"]) == ("A 6320", 30)
    assert conn.inserts_log()[0][6]["hacia"]["desde_hoja"] == "A 6320"


async def test_configurar_solo_el_primer_talonario_puede_registrarse_ya_en_uso(pool, conn):
    _conn_configurar(conn, previos=1)
    with pytest.raises(tl.TalonarioInvalido, match="Solo el primer talonario"):
        await tl.configurar_talonario(_config(numero_siguiente=6320))
    assert conn.sql_ejecutado("insert into talonarios_punto") == []
    assert conn.eventos_log() == []


@pytest.mark.parametrize("fila", [None, {"punto_id": PUNTO_DESTINO}])
async def test_configurar_quien_configura_debe_ser_del_punto(pool, conn, fila):
    conn.responder("fetchrow", "from usuarios_punto where id", fila)
    with pytest.raises(tl.TalonarioInvalido, match="pertenecer a este punto"):
        await tl.configurar_talonario(_config())
    assert conn.eventos_log() == []


async def test_configurar_punto_inactivo(pool, conn):
    conn.responder("fetchrow", "from usuarios_punto where id", {"punto_id": PUNTO_ORIGEN})
    conn.responder("fetchrow", "select id from puntos where id", None)
    with pytest.raises(tl.TalonarioInvalido, match="punto no existe"):
        await tl.configurar_talonario(_config())


async def test_cambiar_un_talonario_con_hojas_sin_usar_exige_motivo(pool, conn):
    _conn_configurar(conn, activo=fila_talonario("A", 6300), usadas=_usadas("A", 6300, 6310))
    with pytest.raises(tl.TalonarioInvalido, match="motivo"):
        await tl.configurar_talonario(_config(numero_inicial=6400))
    assert conn.sql_ejecutado("update talonarios_punto") == []
    assert conn.sql_ejecutado("insert into talonarios_punto") == []
    assert conn.eventos_log() == []


async def test_cambiar_un_talonario_con_motivo_cierra_el_anterior_y_lo_registra(pool, conn):
    _conn_configurar(conn, activo=fila_talonario("A", 6300), usadas=_usadas("A", 6300, 6310))
    nuevo = await tl.configurar_talonario(_config(numero_inicial=6400, motivo="  se perdio  "))
    (_, _, args) = conn.sql_ejecutado("update talonarios_punto")[0]
    assert args == (TALONARIO_ID, "se perdio")
    assert nuevo["siguiente_hoja"] == "A 6400"
    detalle = conn.inserts_log()[0][6]
    assert detalle["desde"] == {"talonario_id": TALONARIO_ID, "rango": "A 6300 – A 6349", "quedaban": 39}
    assert detalle["motivo"] == "se perdio"


async def test_cambiar_un_talonario_agotado_no_pide_motivo(pool, conn):
    _conn_configurar(conn, activo=fila_talonario("A", 6300), usadas=_usadas("A", 6300, 6349))
    await tl.configurar_talonario(_config(numero_inicial=6400))
    (_, _, args) = conn.sql_ejecutado("update talonarios_punto")[0]
    assert args[1] == "Talonario agotado"
    assert conn.inserts_log()[0][6]["desde"]["quedaban"] == 0


async def test_configurar_dos_veces_la_misma_letra_a_la_vez_es_conflicto(pool, conn):
    _conn_configurar(conn)
    conn._reglas.insert(0, ("fetchrow", "insert into talonarios_punto", [violacion_unica("talonarios_punto_activo_letra_key")]))
    with pytest.raises(tl.TalonarioConflicto, match="Alguien más"):
        await tl.configurar_talonario(_config())
    assert conn.eventos_log() == []


# ---------------------------------------------------------------------------
# anular_siguiente_hoja
# ---------------------------------------------------------------------------


def _anular(**extra) -> HojaAnular:
    cuerpo = {"punto_id": PUNTO_ORIGEN, "usuario_id": USUARIO_ORIGEN, "motivo": "hoja danada"}
    cuerpo.update(extra)
    return HojaAnular(**cuerpo)


def _conn_anular(conn, *, activos=None, usadas=()):
    conn.responder("fetchrow", "from usuarios_punto where id", {"punto_id": PUNTO_ORIGEN})
    conn.responder("fetch", "and estado = 'activo' for update", activos if activos is not None else [fila_talonario("A", 6300)])
    conn.responder("fetchrow", "and estado = 'activo' for update", fila_talonario("A", 6300))
    anuladas: list[dict] = []
    conn.responder("fetch", "from traslados_puntos where talonario_id", list(usadas))
    conn.responder("fetch", "from talonario_hojas_anuladas", lambda *a: list(anuladas))

    def _insertar(talonario_id, numero, motivo, usuario):
        anuladas.append({"numero": numero})
        return "INSERT 0 1"

    conn.responder("execute", "insert into talonario_hojas_anuladas", _insertar)


async def test_anular_consume_la_siguiente_hoja_y_deja_evento(pool, conn):
    _conn_anular(conn, usadas=_usadas("A", 6300, 6301))
    resultado = await tl.anular_siguiente_hoja(_anular())
    assert resultado["hoja_anulada"] == "A 6302"
    assert resultado["talonario"]["siguiente_hoja"] == "A 6303"
    assert resultado["talonario"]["anuladas"] == 1
    (_, _, args) = conn.sql_ejecutado("insert into talonario_hojas_anuladas")[0]
    assert args == (TALONARIO_ID, 6302, "hoja danada", USUARIO_ORIGEN)
    (evento, _, entidad, actor, sede, res, detalle) = conn.inserts_log()[0]
    assert (evento, entidad, actor, sede, res) == ("talonario_hoja_anulada", TALONARIO_ID, USUARIO_ORIGEN, PUNTO_ORIGEN, "ok")
    assert detalle == {"hoja": "A 6302", "motivo": "hoja danada", "quedan": 47}


async def test_anular_con_talonario_id_busca_ese_talonario_del_punto(pool, conn):
    _conn_anular(conn)
    await tl.anular_siguiente_hoja(_anular(talonario_id=TALONARIO_ID))
    (_, sql, args) = conn.sql_ejecutado("id = $1::uuid and punto_id = $2::uuid")[0]
    assert args == (TALONARIO_ID, PUNTO_ORIGEN)


async def test_anular_talonario_que_no_esta_activo_en_el_punto(pool, conn):
    _conn_anular(conn)
    conn._reglas.insert(0, ("fetchrow", "and estado = 'activo' for update", [None]))
    with pytest.raises(tl.TalonarioInvalido, match="no tiene ese talonario activo"):
        await tl.anular_siguiente_hoja(_anular(talonario_id=TALONARIO_ID))
    assert conn.sql_ejecutado("insert into talonario_hojas_anuladas") == []
    assert conn.eventos_log() == []


async def test_anular_sin_indicar_talonario_con_varios_activos_exige_elegir(pool, conn):
    _conn_anular(conn, activos=[fila_talonario("A", 6300), fila_talonario("V", 100, talonario_id=OTRO_TALONARIO)])
    with pytest.raises(tl.TalonarioInvalido, match="de cuál talonario"):
        await tl.anular_siguiente_hoja(_anular())
    assert conn.sql_ejecutado("insert into talonario_hojas_anuladas") == []


async def test_anular_sin_talonario_activo(pool, conn):
    _conn_anular(conn, activos=[])
    with pytest.raises(tl.TalonarioInvalido, match="no tiene ese talonario activo"):
        await tl.anular_siguiente_hoja(_anular())


async def test_anular_en_un_talonario_agotado(pool, conn):
    _conn_anular(conn, usadas=_usadas("A", 6300, 6349))
    with pytest.raises(tl.TalonarioInvalido, match="agotado"):
        await tl.anular_siguiente_hoja(_anular())
    assert conn.sql_ejecutado("insert into talonario_hojas_anuladas") == []
    assert conn.eventos_log() == []


@pytest.mark.parametrize("fila", [None, {"punto_id": PUNTO_DESTINO}])
async def test_anular_quien_anula_debe_ser_del_punto(pool, conn, fila):
    conn.responder("fetchrow", "from usuarios_punto where id", fila)
    with pytest.raises(tl.TalonarioInvalido, match="pertenecer a este punto"):
        await tl.anular_siguiente_hoja(_anular())
    assert conn.eventos_log() == []


# ---------------------------------------------------------------------------
# Lecturas
# ---------------------------------------------------------------------------


async def test_obtener_talonarios_activos_devuelve_un_estado_por_letra(pool, conn):
    conn.responder("fetch", "from talonarios_punto where punto_id", [fila_talonario("A", 6300), fila_talonario("V", 100, talonario_id=OTRO_TALONARIO)])
    estados = await tl.obtener_talonarios_activos(PUNTO_ORIGEN)
    assert [(e["letra"], e["siguiente_hoja"]) for e in estados] == [("A", "A 6300"), ("V", "V 100")]


async def test_obtener_talonarios_activos_sin_talonarios(pool, conn):
    assert await tl.obtener_talonarios_activos(PUNTO_ORIGEN) == []


async def test_hojas_esperadas_sin_talonarios_pide_configurar(pool, conn):
    with pytest.raises(tl.TalonarioNoDisponible, match="Configura tu talonario"):
        await tl.hojas_esperadas(PUNTO_ORIGEN)


async def test_hojas_esperadas_todos_agotados(pool, conn):
    conn.responder("fetch", "from talonarios_punto where punto_id", [fila_talonario("A", 6300)])
    conn.responder("fetch", "from traslados_puntos where talonario_id", _usadas("A", 6300, 6349))
    with pytest.raises(tl.TalonarioNoDisponible, match="agotado"):
        await tl.hojas_esperadas(PUNTO_ORIGEN)


async def test_hojas_esperadas_omite_los_agotados_y_conserva_los_demas(pool, conn):
    conn.responder(
        "fetch", "from talonarios_punto where punto_id",
        [fila_talonario("A", 6300), fila_talonario("V", 100, talonario_id=OTRO_TALONARIO)],
    )
    conn.responder("fetch", "from traslados_puntos where talonario_id", _usadas("A", 6300, 6349), [])
    disponibles = await tl.hojas_esperadas(PUNTO_ORIGEN)
    assert [d["letra"] for d in disponibles] == ["V"]


async def test_resumen_incluye_los_puntos_sin_talonario_con_lista_vacia(pool, conn):
    conn.responder("fetch", "from puntos order by nombre", [{"id": PUNTO_ORIGEN, "nombre": "CFC"}, {"id": PUNTO_DESTINO, "nombre": "BDG"}])
    conn.responder("fetch", "where estado = 'activo' order by letra", [fila_talonario("A", 6300)])
    resumen = await tl.resumen_talonarios_puntos()
    assert [(r["punto_nombre"], len(r["talonarios"])) for r in resumen] == [("CFC", 1), ("BDG", 0)]
    assert resumen[0]["talonarios"][0]["siguiente_hoja"] == "A 6300"
