"""Servicio de traslados entre puntos (app/services/traslados_puntos.py) con la
base de datos simulada: reglas de validacion, rutas de error y eventos en `logs`.

La toma de la hoja del talonario (validar_y_tomar_hoja) se sustituye por un
doble: su logica se prueba aparte (test_talonarios_servicio.py y las pruebas de
integracion con Postgres real)."""

from datetime import date

import pytest

from app.models.traslado_punto import (
    LlegadaDirectaCrear,
    RecepcionTraslado,
    SolucionNovedad,
    TrasladoPuntoCrear,
)
from app.services import traslados_puntos as tp
from app.services.talonarios import TalonarioConflicto, TalonarioNoDisponible
from tests.fakes import violacion_unica
from tests.helpers_traslados import (
    PUNTO_DESTINO,
    PUNTO_ORIGEN,
    SUPERVISOR,
    TALONARIO_ID,
    USUARIO_DESTINO,
    USUARIO_ORIGEN,
    cuerpo_llegada_directa,
    cuerpo_recepcion,
    cuerpo_solucion,
    cuerpo_traslado,
    estado_talonario,
    nuevo_id,
)

# ---------------------------------------------------------------------------
# Ayudas internas
# ---------------------------------------------------------------------------


def test_normalizar_quita_tildes_guiones_largos_y_espacios():
    assert tp._normalizar("  CFC — La   Cumbre ") == "cfc - la cumbre"
    assert tp._normalizar("Bodega Ibagué") == "bodega ibague"
    assert tp._normalizar("") == ""
    assert tp._normalizar(None) == ""  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "nombre, codigo, esperado",
    [
        ("CFC — La Cumbre", "CFC", "la cumbre"),
        ("CFC – La Cumbre", "cfc", "la cumbre"),
        ("CFC - La Cumbre", "CFC", "la cumbre"),
        ("CFC — La Cumbre", None, "la cumbre"),  # sin codigo se acepta cualquier prefijo
        ("OTRO — La Cumbre", "CFC", "otro - la cumbre"),  # el prefijo no es el codigo del punto
        ("La Cumbre", "CFC", "la cumbre"),  # sin separador
    ],
)
def test_nombre_sin_codigo(nombre, codigo, esperado):
    assert tp._nombre_sin_codigo(nombre, codigo) == esperado


@pytest.mark.parametrize(
    "texto, valido",
    [("2026-03-05", True), ("2026-02-30", False), ("05/03/2026", False), ("", False), ("2026-3-5", False)],
)
def test_fecha_iso_valida(texto, valido):
    assert tp._fecha_iso_valida(texto) is valido


PUNTOS = [
    {"id": "p1", "nombre": "CFC — La Cumbre", "codigo": "CFC"},
    {"id": "p2", "nombre": "BDG — Bodega Central", "codigo": "BDG"},
    {"id": "p3", "nombre": "MNZ — Manizales Norte", "codigo": "MNZ"},
]


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("CFC", "p1"),  # codigo exacto
        ("cfc", "p1"),
        ("CFC — La Cumbre", "p1"),  # nombre completo
        ("la cumbre", "p1"),  # sin prefijo de codigo
        ("Bodega Central", "p2"),
        ("La Cumbree", "p1"),  # error de lectura pero un unico candidato claro
        ("Manizalez Norte", "p3"),
    ],
)
def test_resolver_destino_encuentra_el_punto(texto, esperado):
    assert tp._resolver_destino(texto, PUNTOS)["id"] == esperado


@pytest.mark.parametrize("texto", ["", "   ", "Cartagena", "xx"])
def test_resolver_destino_sin_coincidencia_devuelve_none(texto):
    assert tp._resolver_destino(texto, PUNTOS) is None


def test_resolver_destino_ambiguo_no_elige_ninguno():
    gemelos = [
        {"id": "a", "nombre": "BDG — Bodega Norte 1", "codigo": "BD1"},
        {"id": "b", "nombre": "BDG — Bodega Norte 2", "codigo": "BD2"},
    ]
    assert tp._resolver_destino("Bodega Norte", gemelos) is None


def test_resolver_destino_sin_puntos():
    assert tp._resolver_destino("CFC", []) is None


def test_resolver_destino_codigo_vacio_no_coincide_con_texto_vacio():
    assert tp._resolver_destino("x", [{"id": "p", "nombre": "Algo", "codigo": None}]) is None


# ---------------------------------------------------------------------------
# crear_traslado
# ---------------------------------------------------------------------------


@pytest.fixture
def hoja(monkeypatch):
    """Sustituye la toma de la hoja por un doble que registra lo que recibio."""
    llamadas: list[tuple] = []

    async def _tomar(conn, punto_id, numero_talonario):
        llamadas.append((punto_id, numero_talonario))
        return TALONARIO_ID, "A 6300"

    monkeypatch.setattr(tp, "validar_y_tomar_hoja", _tomar)
    return llamadas


def _conn_traslado_valido(conn, payload: TrasladoPuntoCrear):
    conn.responder("fetchrow", "select id from puntos where id", {"id": PUNTO_ORIGEN}, {"id": PUNTO_DESTINO})
    conn.responder("fetchrow", "from usuarios_punto where id", {"punto_id": PUNTO_ORIGEN})
    conn.responder(
        "fetchrow", "insert into traslados_puntos",
        lambda *args: {"id": args[0], "estado": "en_transito", "numero_talonario": args[9]},
    )
    conn.responder("fetchrow", "insert into traslado_punto_items", lambda *args: {"traslado_id": args[0], "cantidad": args[1], "producto": args[2]})


async def test_crear_traslado_valido_inserta_items_y_deja_evento(pool, conn, hoja):
    payload = TrasladoPuntoCrear(**cuerpo_traslado())
    _conn_traslado_valido(conn, payload)

    resultado = await tp.crear_traslado(payload)

    assert resultado["estado"] == "en_transito"
    assert resultado["numero_talonario"] == "A 6300"  # la referencia canonica, no el texto tipeado
    assert [i["producto"] for i in resultado["items"]] == ["SAL BLANCA"]
    assert hoja == [(PUNTO_ORIGEN, "A 6300")]
    assert conn.eventos_log() == ["traslado_punto_creado"]
    (evento, tipo, entidad, actor, sede, res, detalle) = conn.inserts_log()[0]
    assert (tipo, entidad, actor, sede, res) == ("traslado_punto", payload.id, USUARIO_ORIGEN, PUNTO_ORIGEN, "ok")
    assert detalle == {"punto_destino_id": PUNTO_DESTINO, "cantidad_items": 1}


async def test_crear_traslado_guarda_el_talonario_id_de_la_hoja_tomada(pool, conn, hoja):
    payload = TrasladoPuntoCrear(**cuerpo_traslado())
    _conn_traslado_valido(conn, payload)
    await tp.crear_traslado(payload)
    (_, _, args) = conn.sql_ejecutado("insert into traslados_puntos")[0]
    assert args[9] == "A 6300" and args[11] == TALONARIO_ID


async def test_crear_traslado_mismo_origen_y_destino_se_rechaza_sin_tocar_la_base(pool, conn, hoja):
    payload = TrasladoPuntoCrear(**cuerpo_traslado(punto_destino_id=PUNTO_ORIGEN))
    with pytest.raises(tp.TrasladoInvalido, match="no pueden ser el mismo"):
        await tp.crear_traslado(payload)
    assert conn.llamadas == []
    assert hoja == []


@pytest.mark.parametrize("campo", ["firma_despacha_url", "firma_transporta_url"])
async def test_crear_traslado_exige_ambas_firmas(pool, conn, hoja, campo):
    payload = TrasladoPuntoCrear(**cuerpo_traslado(**{campo: ""}))
    with pytest.raises(tp.TrasladoInvalido, match="firmas"):
        await tp.crear_traslado(payload)
    assert conn.llamadas == [] and hoja == []


async def test_crear_traslado_origen_inactivo(pool, conn, hoja):
    conn.responder("fetchrow", "select id from puntos where id", None)
    with pytest.raises(tp.TrasladoInvalido, match="origen no existe"):
        await tp.crear_traslado(TrasladoPuntoCrear(**cuerpo_traslado()))
    assert hoja == [] and conn.eventos_log() == []


async def test_crear_traslado_destino_inactivo(pool, conn, hoja):
    conn.responder("fetchrow", "select id from puntos where id", {"id": PUNTO_ORIGEN}, None)
    with pytest.raises(tp.TrasladoInvalido, match="destino no existe"):
        await tp.crear_traslado(TrasladoPuntoCrear(**cuerpo_traslado()))
    assert hoja == []


@pytest.mark.parametrize("fila", [None, {"punto_id": PUNTO_DESTINO}])
async def test_crear_traslado_quien_despacha_debe_ser_del_punto_origen(pool, conn, hoja, fila):
    conn.responder("fetchrow", "select id from puntos where id", {"id": PUNTO_ORIGEN})
    conn.responder("fetchrow", "from usuarios_punto where id", fila)
    with pytest.raises(tp.TrasladoInvalido, match="pertenecer al punto de origen"):
        await tp.crear_traslado(TrasladoPuntoCrear(**cuerpo_traslado()))
    assert hoja == [] and conn.eventos_log() == []


async def test_crear_traslado_hoja_ya_usada_responde_conflicto_y_no_registra_evento(pool, conn, hoja):
    payload = TrasladoPuntoCrear(**cuerpo_traslado())
    _conn_traslado_valido(conn, payload)
    conn._reglas.insert(0, ("fetchrow", "insert into traslados_puntos", [violacion_unica("traslados_puntos_talonario_hoja_key")]))
    with pytest.raises(TalonarioConflicto, match="Esa hoja ya se usó"):
        await tp.crear_traslado(payload)
    assert conn.eventos_log() == []
    assert conn.sql_ejecutado("insert into traslado_punto_items") == []


async def test_crear_traslado_id_repetido_es_traslado_invalido(pool, conn, hoja):
    payload = TrasladoPuntoCrear(**cuerpo_traslado())
    _conn_traslado_valido(conn, payload)
    conn._reglas.insert(0, ("fetchrow", "insert into traslados_puntos", [violacion_unica("traslados_puntos_pkey")]))
    with pytest.raises(tp.TrasladoInvalido, match="Ya existe un traslado con ese id"):
        await tp.crear_traslado(payload)
    assert conn.eventos_log() == []


async def test_crear_traslado_propaga_el_error_de_talonario(pool, conn, monkeypatch):
    async def _sin_talonario(conn, punto_id, numero):
        raise TalonarioNoDisponible("sin talonario")

    monkeypatch.setattr(tp, "validar_y_tomar_hoja", _sin_talonario)
    payload = TrasladoPuntoCrear(**cuerpo_traslado())
    _conn_traslado_valido(conn, payload)
    with pytest.raises(TalonarioNoDisponible):
        await tp.crear_traslado(payload)
    assert conn.sql_ejecutado("insert into traslados_puntos") == []
    assert conn.eventos_log() == []


# ---------------------------------------------------------------------------
# crear_llegada_directa
# ---------------------------------------------------------------------------


def _conn_llegada_valida(conn, *, punto_creador=PUNTO_DESTINO):
    conn.responder("fetchrow", "select id from puntos where id", {"id": PUNTO_DESTINO})
    conn.responder("fetchrow", "from usuarios_punto where id", {"punto_id": punto_creador})
    conn.responder(
        "fetchrow", "insert into traslados_puntos",
        lambda *args: {"id": args[0], "estado": args[5], "novedad_estado": args[7], "contenido_texto": args[11]},
    )
    conn.responder("fetchrow", "insert into traslado_punto_items", lambda *args: {"cantidad": args[1], "producto": args[2]})


async def test_llegada_directa_nace_recibida_y_deja_evento(pool, conn, monkeypatch):
    llamadas = []

    async def _tomar(c, punto_id, numero):
        llamadas.append((punto_id, numero))
        return TALONARIO_ID, "A 100"

    monkeypatch.setattr(tp, "validar_y_tomar_hoja", _tomar)
    _conn_llegada_valida(conn)
    payload = LlegadaDirectaCrear(**cuerpo_llegada_directa())

    resultado = await tp.crear_llegada_directa(payload)

    assert resultado["estado"] == "recibido"
    assert resultado["novedad_estado"] is None
    assert llamadas == [(PUNTO_DESTINO, "A 100")]  # la hoja sale del talonario del punto que recibe
    assert [i["producto"] for i in resultado["items"]] == ["AZUCAR"]
    (evento, _, entidad, actor, sede, res, detalle) = conn.inserts_log()[0]
    assert (evento, entidad, actor, sede, res) == ("llegada_directa_registrada", payload.id, USUARIO_DESTINO, PUNTO_DESTINO, "recibido")
    assert detalle == {"cantidad_items": 1, "novedad": None}


async def test_llegada_directa_lo_recibido_es_lo_que_dice_la_hoja(pool, conn, hoja):
    _conn_llegada_valida(conn)
    await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa()))
    (_, insert, args) = conn.sql_ejecutado("insert into traslado_punto_items")[0]
    assert "cantidad_recibida" in insert and "$2)" in insert  # cantidad_recibida = la misma cantidad ($2)
    assert args[1] == 4


async def test_llegada_directa_con_novedad_queda_pendiente_para_supervision(pool, conn, hoja):
    _conn_llegada_valida(conn)
    resultado = await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa(novedad="  caja golpeada  ")))
    assert resultado["estado"] == "recibido_con_novedad"
    assert resultado["novedad_estado"] == "pendiente"
    assert conn.inserts_log()[0][5] == "recibido_con_novedad"
    assert conn.inserts_log()[0][6]["novedad"] == "caja golpeada"


async def test_llegada_directa_novedad_en_blanco_no_cuenta_como_novedad(pool, conn, hoja):
    _conn_llegada_valida(conn)
    resultado = await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa(novedad="   ")))
    assert resultado["estado"] == "recibido" and resultado["novedad_estado"] is None


async def test_llegada_directa_solo_con_texto_libre_se_acepta_y_lo_compacta(pool, conn, hoja):
    _conn_llegada_valida(conn)
    cuerpo = cuerpo_llegada_directa(items=[], contenido_texto="  10 bultos\n\n de   sal ")
    resultado = await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo))
    assert resultado["contenido_texto"] == "10 bultos de sal"
    assert resultado["items"] == []
    assert conn.sql_ejecutado("insert into traslado_punto_items") == []


@pytest.mark.parametrize("texto", [None, "", "  \n "])
async def test_llegada_directa_sin_items_ni_texto_se_rechaza(pool, conn, hoja, texto):
    _conn_llegada_valida(conn)
    with pytest.raises(tp.TrasladoInvalido, match="al menos un producto"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa(items=[], contenido_texto=texto)))
    assert conn.sql_ejecutado("insert into traslados_puntos") == []
    assert conn.eventos_log() == []


async def test_llegada_directa_exige_declaracion_aceptada(pool, conn, hoja):
    with pytest.raises(tp.TrasladoInvalido, match="declaración"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa(declaracion_aceptada=False)))
    assert conn.llamadas == [] and hoja == []


async def test_llegada_directa_exige_firma(pool, conn, hoja):
    with pytest.raises(tp.TrasladoInvalido, match="firma"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa(firma_recibe_url="")))
    assert conn.llamadas == [] and hoja == []


async def test_llegada_directa_punto_inactivo(pool, conn, hoja):
    conn.responder("fetchrow", "select id from puntos where id", None)
    with pytest.raises(tp.TrasladoInvalido, match="punto no existe"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa()))
    assert hoja == []


@pytest.mark.parametrize("fila", [None, {"punto_id": PUNTO_ORIGEN}])
async def test_llegada_directa_quien_recibe_debe_ser_del_punto(pool, conn, hoja, fila):
    conn.responder("fetchrow", "select id from puntos where id", {"id": PUNTO_DESTINO})
    conn.responder("fetchrow", "from usuarios_punto where id", fila)
    with pytest.raises(tp.TrasladoInvalido, match="pertenecer al punto"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa()))
    assert hoja == []


async def test_llegada_directa_fecha_ausente_se_deja_a_la_base(pool, conn, hoja):
    _conn_llegada_valida(conn)
    await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa()))
    (_, sql, args) = conn.sql_ejecutado("insert into traslados_puntos")[0]
    assert args[2] is None and "coalesce($3::date, current_date)" in sql
    await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa(fecha="2026-03-05")))
    assert conn.sql_ejecutado("insert into traslados_puntos")[1][2][2] == date(2026, 3, 5)


async def test_llegada_directa_hoja_ya_usada_responde_conflicto(pool, conn, hoja):
    _conn_llegada_valida(conn)
    conn._reglas.insert(0, ("fetchrow", "insert into traslados_puntos", [violacion_unica("traslados_puntos_talonario_hoja_key")]))
    with pytest.raises(TalonarioConflicto, match="Esa hoja ya se usó"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa()))
    assert conn.eventos_log() == []


async def test_llegada_directa_id_repetido(pool, conn, hoja):
    _conn_llegada_valida(conn)
    conn._reglas.insert(0, ("fetchrow", "insert into traslados_puntos", [violacion_unica("traslados_puntos_pkey")]))
    with pytest.raises(tp.TrasladoInvalido, match="Ya existe un traslado"):
        await tp.crear_llegada_directa(LlegadaDirectaCrear(**cuerpo_llegada_directa()))


# ---------------------------------------------------------------------------
# registrar_recepcion
# ---------------------------------------------------------------------------

ITEM_A = nuevo_id()
ITEM_B = nuevo_id()
TRASLADO = nuevo_id()


def _conn_recepcion(conn, *, actualizado: dict | None = None):
    conn.responder("fetchrow", "select * from traslados_puntos where id", {"id": TRASLADO, "punto_destino_id": PUNTO_DESTINO})
    conn.responder(
        "fetch", "from traslado_punto_items where traslado_id",
        [
            {"id": ITEM_A, "cantidad": 10, "producto": "SAL"},
            {"id": ITEM_B, "cantidad": 5, "producto": "AZUCAR"},
        ],
    )
    conn.responder(
        "fetchrow", "update traslados_puntos",
        actualizado if actualizado is not None else (lambda *args: {"id": args[0], "estado": args[1]}),
    )
    conn.responder("fetchrow", "update traslado_punto_items", lambda *args: {"id": args[0], "cantidad_recibida": args[1]})


def _recepcion(*items, **extra) -> RecepcionTraslado:
    return RecepcionTraslado(**cuerpo_recepcion(list(items), **extra))


async def test_recepcion_completa_queda_recibido_sin_evento_de_novedad(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(
        TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 10}, {"id": ITEM_B, "cantidad_recibida": 5})
    )
    assert resultado["estado"] == "recibido"
    assert [i["cantidad_recibida"] for i in resultado["items"]] == [10, 5]
    assert conn.eventos_log() == ["traslado_punto_recibido"]
    (_, _, entidad, actor, sede, res, detalle) = conn.inserts_log()[0]
    assert (entidad, actor, sede, res) == (TRASLADO, USUARIO_DESTINO, PUNTO_DESTINO, "recibido")
    assert detalle == {"declaracion_aceptada": True}


async def test_recepcion_con_faltante_queda_con_novedad_y_deja_dos_eventos(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(
        TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 7}, {"id": ITEM_B, "cantidad_recibida": 5})
    )
    assert resultado["estado"] == "recibido_con_novedad"
    assert conn.eventos_log() == ["traslado_punto_recibido", "traslado_punto_novedad"]
    assert conn.inserts_log()[0][5] == "recibido_con_novedad"


async def test_recepcion_con_novedad_general_aunque_llegue_completo(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(
        TRASLADO,
        _recepcion({"id": ITEM_A, "cantidad_recibida": 10}, {"id": ITEM_B, "cantidad_recibida": 5}, novedad="empaque roto"),
    )
    assert resultado["estado"] == "recibido_con_novedad"
    assert conn.inserts_log()[1][6] == {"novedad": "empaque roto"}


async def test_recepcion_con_novedad_en_un_item(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(
        TRASLADO,
        _recepcion({"id": ITEM_A, "cantidad_recibida": 10, "novedad": "vencido"}, {"id": ITEM_B, "cantidad_recibida": 5}),
    )
    assert resultado["estado"] == "recibido_con_novedad"


async def test_recepcion_novedades_en_blanco_no_cuentan(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(
        TRASLADO,
        _recepcion({"id": ITEM_A, "cantidad_recibida": 10, "novedad": "  "}, {"id": ITEM_B, "cantidad_recibida": 5}, novedad=" "),
    )
    assert resultado["estado"] == "recibido"


async def test_recepcion_del_estado_nuevo_se_pasa_al_update_atomico(pool, conn):
    _conn_recepcion(conn)
    await tp.registrar_recepcion(TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 3}))
    (_, sql, args) = conn.sql_ejecutado("update traslados_puntos")[0]
    assert "estado = 'en_transito'" in sql  # el guardado que impide recibir dos veces
    assert args[1] == "recibido_con_novedad"
    assert args[2] == USUARIO_DESTINO


async def test_recepcion_traslado_inexistente(pool, conn):
    conn.responder("fetchrow", "select * from traslados_puntos where id", None)
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tp.registrar_recepcion(TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 1}))
    assert conn.eventos_log() == []


async def test_recepcion_con_item_ajeno_se_rechaza_antes_de_actualizar(pool, conn):
    _conn_recepcion(conn)
    with pytest.raises(tp.TrasladoInvalido, match="no pertenece a este traslado"):
        await tp.registrar_recepcion(TRASLADO, _recepcion({"id": nuevo_id(), "cantidad_recibida": 1}))
    assert conn.sql_ejecutado("update ") == []
    assert conn.eventos_log() == []


async def test_recepcion_no_puede_superar_lo_enviado(pool, conn):
    _conn_recepcion(conn)
    with pytest.raises(tp.TrasladoInvalido, match=r"más de lo enviado|mas de lo enviado") as exc:
        await tp.registrar_recepcion(TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 11}))
    assert "(10)" in str(exc.value) and "SAL" in str(exc.value)
    assert conn.sql_ejecutado("update ") == []


async def test_recepcion_exactamente_lo_enviado_es_valida(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 10}))
    assert resultado["estado"] == "recibido"


async def test_recepcion_en_cero_es_valida_y_cuenta_como_faltante(pool, conn):
    _conn_recepcion(conn)
    resultado = await tp.registrar_recepcion(TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 0}))
    assert resultado["estado"] == "recibido_con_novedad"


async def test_recepcion_ya_recibida_responde_conflicto_sin_tocar_items_ni_logs(pool, conn):
    _conn_recepcion(conn)
    conn._reglas.insert(0, ("fetchrow", "update traslados_puntos", [None]))
    with pytest.raises(tp.TrasladoYaRecibido):
        await tp.registrar_recepcion(TRASLADO, _recepcion({"id": ITEM_A, "cantidad_recibida": 10}))
    assert conn.sql_ejecutado("update traslado_punto_items") == []
    assert conn.eventos_log() == []


# ---------------------------------------------------------------------------
# resolver_novedad
# ---------------------------------------------------------------------------


def _conn_novedad(conn):
    conn.responder(
        "fetchrow", "select * from traslados_puntos where id",
        {"id": TRASLADO, "punto_destino_id": PUNTO_DESTINO, "novedad_estado": "pendiente"},
    )
    conn.responder("fetchrow", "from supervisores where id", {"id": SUPERVISOR})
    conn.responder("fetchrow", "from puntos where codigo", {"id": PUNTO_DESTINO})
    conn.responder("fetchrow", "update traslados_puntos", lambda *args: {"id": args[0], "consecutivo_solucion": args[3]})
    conn.responder("fetch", "from traslado_punto_items", [{"id": ITEM_A}])


def _solucion(**extra) -> SolucionNovedad:
    return SolucionNovedad(**cuerpo_solucion(**extra))


async def test_resolver_novedad_archiva_el_consecutivo_y_deja_evento(pool, conn):
    _conn_novedad(conn)
    resultado = await tp.resolver_novedad(TRASLADO, _solucion())
    assert resultado["consecutivo_solucion"] == "NPT-0012"  # conserva los ceros a la izquierda
    assert resultado["items"] == [{"id": ITEM_A}]
    assert conn.eventos_log() == ["traslado_punto_novedad_resuelta"]
    (_, _, entidad, actor, sede, res, _) = conn.inserts_log()[0]
    assert (entidad, actor, sede, res) == (TRASLADO, SUPERVISOR, PUNTO_DESTINO, "ok")


async def test_resolver_novedad_el_update_solo_aplica_a_novedades_pendientes(pool, conn):
    _conn_novedad(conn)
    await tp.resolver_novedad(TRASLADO, _solucion())
    (_, sql, _) = conn.sql_ejecutado("update traslados_puntos")[0]
    assert "novedad_estado = 'pendiente'" in sql


async def test_resolver_novedad_traslado_inexistente(pool, conn):
    conn.responder("fetchrow", "select * from traslados_puntos where id", None)
    with pytest.raises(tp.NovedadNoEncontrada):
        await tp.resolver_novedad(TRASLADO, _solucion())


async def test_resolver_novedad_sin_novedad_para_resolver(pool, conn):
    conn.responder("fetchrow", "select * from traslados_puntos where id", {"novedad_estado": None})
    with pytest.raises(tp.NovedadInvalida, match="no tiene una novedad"):
        await tp.resolver_novedad(TRASLADO, _solucion())
    assert conn.eventos_log() == []


async def test_resolver_novedad_supervisor_inactivo(pool, conn):
    _conn_novedad(conn)
    conn._reglas.insert(0, ("fetchrow", "from supervisores where id", [None]))
    with pytest.raises(tp.NovedadInvalida, match="Supervisor"):
        await tp.resolver_novedad(TRASLADO, _solucion())
    assert conn.sql_ejecutado("update traslados_puntos") == []


async def test_resolver_novedad_codigo_de_punto_inexistente(pool, conn):
    _conn_novedad(conn)
    conn._reglas.insert(0, ("fetchrow", "from puntos where codigo", [None]))
    with pytest.raises(tp.NovedadInvalida, match="código de punto"):
        await tp.resolver_novedad(TRASLADO, _solucion())
    assert conn.sql_ejecutado("update traslados_puntos") == []


async def test_resolver_novedad_consecutivo_repetido_es_error_distinto_al_de_ya_resuelta(pool, conn):
    _conn_novedad(conn)
    conn._reglas.insert(0, ("fetchrow", "update traslados_puntos", [violacion_unica("traslados_puntos_consecutivo_solucion_key")]))
    with pytest.raises(tp.ConsecutivoDuplicado, match="consecutivo ya está registrado"):
        await tp.resolver_novedad(TRASLADO, _solucion())
    assert conn.eventos_log() == []


async def test_resolver_novedad_ya_resuelta_por_otro(pool, conn):
    _conn_novedad(conn)
    conn._reglas.insert(0, ("fetchrow", "update traslados_puntos", [None]))
    with pytest.raises(tp.NovedadYaResuelta):
        await tp.resolver_novedad(TRASLADO, _solucion())
    assert conn.eventos_log() == []


def test_las_excepciones_de_conflicto_son_distinguibles():
    assert not issubclass(tp.ConsecutivoDuplicado, tp.NovedadYaResuelta)
    assert not issubclass(tp.NovedadYaResuelta, tp.ConsecutivoDuplicado)


# ---------------------------------------------------------------------------
# asignar_numero_syscafe / validar_supervisor_activo
# ---------------------------------------------------------------------------


async def test_syscafe_se_normaliza_y_no_escribe_en_logs(pool, conn):
    conn.responder("fetchrow", "update traslados_puntos set numero_syscafe", lambda *args: {"id": args[0], "numero_syscafe": args[1]})
    resultado = await tp.asignar_numero_syscafe(TRASLADO, "nbr 945", "Erika")
    assert resultado["numero_syscafe"] == "NBR-945"
    (_, _, args) = conn.sql_ejecutado("update traslados_puntos set numero_syscafe")[0]
    assert args == (TRASLADO, "NBR-945", "Erika")
    assert conn.eventos_log() == []  # sin auditoria en logs, a proposito (ver el docstring)


@pytest.mark.parametrize("valor", [None, "", "   "])
async def test_syscafe_vacio_borra_el_valor(pool, conn, valor):
    conn.responder("fetchrow", "update traslados_puntos set numero_syscafe", lambda *args: {"numero_syscafe": args[1]})
    resultado = await tp.asignar_numero_syscafe(TRASLADO, valor)
    assert resultado["numero_syscafe"] is None


async def test_syscafe_formato_invalido_no_llega_a_la_base(pool, conn):
    with pytest.raises(ValueError):
        await tp.asignar_numero_syscafe(TRASLADO, "945")
    assert conn.llamadas == []


async def test_syscafe_traslado_inexistente(pool, conn):
    conn.responder("fetchrow", "update traslados_puntos set numero_syscafe", None)
    with pytest.raises(tp.TrasladoNoEncontrado):
        await tp.asignar_numero_syscafe(TRASLADO, "NBR-945")


@pytest.mark.parametrize(
    "otro, referencia",
    [
        ({"numero_talonario": "A 6305", "talonario_id": TALONARIO_ID, "consecutivo": 7}, "A 6305"),
        ({"numero_talonario": None, "talonario_id": None, "consecutivo": 7}, "TP-000007"),
        ({"numero_talonario": "viejo", "talonario_id": None, "consecutivo": 12}, "TP-000012"),
        (None, "otro traslado"),
    ],
)
async def test_syscafe_duplicado_nombra_el_otro_traslado(pool, conn, otro, referencia):
    conn.responder("fetchrow", "update traslados_puntos set numero_syscafe", violacion_unica("traslados_puntos_numero_syscafe_key"))
    conn.responder("fetchrow", "where numero_syscafe = $1", otro)
    with pytest.raises(tp.SyscafeDuplicado) as exc:
        await tp.asignar_numero_syscafe(TRASLADO, "NBR-945")
    assert "NBR-945" in str(exc.value) and referencia in str(exc.value)


async def test_validar_supervisor_activo_devuelve_el_nombre(pool, conn):
    conn.responder("fetchrow", "from supervisores", {"id": SUPERVISOR, "nombre": "Erika"})
    assert await tp.validar_supervisor_activo(SUPERVISOR) == "Erika"


async def test_validar_supervisor_inexistente_o_inactivo(pool, conn):
    conn.responder("fetchrow", "from supervisores", None)
    with pytest.raises(tp.TrasladoInvalido, match="Supervisor invalido"):
        await tp.validar_supervisor_activo(SUPERVISOR)


async def test_validar_supervisor_con_id_mal_formado_no_revienta(pool, conn):
    import asyncpg

    conn.responder("fetchrow", "from supervisores", asyncpg.DataError("invalid input for query argument"))
    with pytest.raises(tp.TrasladoInvalido, match="Supervisor invalido"):
        await tp.validar_supervisor_activo("no-es-uuid")


# ---------------------------------------------------------------------------
# extraer_talonario (la IA siempre simulada)
# ---------------------------------------------------------------------------

FOTO = "https://storage.prueba/talonario.webp"
CONFIANZA_ALTA = {"numero_talonario": 0.95, "destino": 0.95, "transportador": 0.95, "fecha": 0.95}
LECTURA_COMPLETA = {
    "numero_talonario": "A 6305",
    "destino": "CFC — La Cumbre",
    "transportador": "Pedro Perez",
    "fecha": "2026-03-05",
    "llega_directo": False,
    "items": [{"cantidad": 3, "producto": "sal blanca", "marca": "", "presentacion": "", "fecha_vencimiento": ""}],
    "texto_libre": "",
    "confianza": CONFIANZA_ALTA,
}


@pytest.fixture
def ia(monkeypatch, pool, conn):
    """Doble de la lectura de vision + talonarios disponibles del punto origen."""

    class Guion:
        lectura: dict = dict(LECTURA_COMPLETA)
        disponibles: list[dict] | Exception = [estado_talonario("A", 6305)]
        llamadas: list[tuple] = []

    guion = Guion()
    guion.llamadas = []

    async def _leer(url, destinos=None, letras=None):
        guion.llamadas.append((url, destinos, letras))
        return guion.lectura

    async def _hojas(punto_id):
        if isinstance(guion.disponibles, Exception):
            raise guion.disponibles
        return guion.disponibles

    monkeypatch.setattr(tp, "extraer_datos_talonario", _leer)
    monkeypatch.setattr(tp, "hojas_esperadas", _hojas)
    conn.responder("fetch", "from puntos where activo", [{"id": "p1", "nombre": "CFC — La Cumbre", "codigo": "CFC"}])
    return guion


async def test_extraer_lectura_limpia_no_deja_faltantes(ia):
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["faltantes"] == []
    assert resultado["numero_talonario"] == "A 6305"
    assert resultado["punto_destino"] == {"id": "p1", "nombre": "CFC — La Cumbre", "codigo": "CFC"}
    assert resultado["items"][0]["producto"] == "SAL BLANCA"
    assert resultado["hojas_esperadas"] == ["A 6305"]
    assert resultado["letra_leida"] == "A"


async def test_extraer_le_muestra_a_la_ia_los_destinos_y_todas_las_letras(ia):
    ia.disponibles = [estado_talonario("A", 6305), estado_talonario("V", 120, inicial=100)]
    await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, letra="V")
    ((url, destinos, letras),) = ia.llamadas
    assert (url, destinos, letras) == (FOTO, ["CFC — La Cumbre"], ["A", "V"])


async def test_extraer_numero_equivocado_pide_repetir_y_dice_cual_toca(ia):
    ia.lectura = {**LECTURA_COMPLETA, "numero_talonario": "A 6306"}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert "Número de talonario" in resultado["faltantes"]
    assert resultado["numero_esperado"] == "A 6305"
    assert resultado["numero_talonario"] == "A 6306"  # se devuelve lo leido, no se "corrige"


async def test_extraer_numero_con_confianza_baja_no_se_acepta_aunque_coincida(ia):
    ia.lectura = {**LECTURA_COMPLETA, "confianza": {**CONFIANZA_ALTA, "numero_talonario": 0.5}}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["faltantes"] == ["Número de talonario"]


async def test_extraer_letra_ilegible_ofrece_todas_las_hojas_esperadas(ia):
    ia.disponibles = [estado_talonario("A", 6305), estado_talonario("V", 120, inicial=100)]
    ia.lectura = {**LECTURA_COMPLETA, "numero_talonario": "???"}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["letra_leida"] is None
    assert resultado["numero_esperado"] == "A 6305 o V 120"
    assert resultado["hojas_esperadas"] == ["A 6305", "V 120"]


async def test_extraer_segun_la_letra_leida_elige_el_talonario(ia):
    ia.disponibles = [estado_talonario("A", 6305), estado_talonario("V", 120, inicial=100)]
    ia.lectura = {**LECTURA_COMPLETA, "numero_talonario": "v120"}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["numero_talonario"] == "V 120"
    assert "Número de talonario" not in resultado["faltantes"]


async def test_extraer_con_letra_elegida_una_hoja_de_otra_letra_es_faltante(ia):
    ia.disponibles = [estado_talonario("A", 6305), estado_talonario("V", 120, inicial=100)]
    ia.lectura = {**LECTURA_COMPLETA, "numero_talonario": "V 120"}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, letra="a")
    assert "Número de talonario" in resultado["faltantes"]
    assert resultado["numero_esperado"] == "A 6305"
    assert resultado["hojas_esperadas"] == ["A 6305"]
    assert resultado["letra_leida"] == "V"


async def test_extraer_letra_sin_talonario_activo_falla_antes_de_llamar_a_la_ia(ia):
    with pytest.raises(TalonarioNoDisponible, match="talonario Z"):
        await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, letra=" z ")
    assert ia.llamadas == []


async def test_extraer_sin_talonario_falla_antes_de_llamar_a_la_ia(ia):
    ia.disponibles = TalonarioNoDisponible("Tu punto no tiene un talonario activo")
    with pytest.raises(TalonarioNoDisponible):
        await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert ia.llamadas == []


@pytest.mark.parametrize(
    "cambio, faltante",
    [
        ({"destino": "Cartagena"}, "Destino"),  # no coincide con ningun punto
        ({"confianza": {**CONFIANZA_ALTA, "destino": 0.2}}, "Destino"),
        ({"transportador": ""}, "Transportador"),
        ({"confianza": {**CONFIANZA_ALTA, "transportador": 0.2}}, "Transportador"),
        ({"fecha": ""}, "Fecha"),
        ({"fecha": "2026-13-45"}, "Fecha"),
        ({"fecha": "05/03/2026"}, "Fecha"),
        ({"confianza": {**CONFIANZA_ALTA, "fecha": 0.1}}, "Fecha"),
        ({"items": []}, "Productos"),
    ],
)
async def test_extraer_marca_lo_que_no_se_pudo_leer(ia, cambio, faltante):
    ia.lectura = {**LECTURA_COMPLETA, **cambio}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["faltantes"] == [faltante]


async def test_extraer_confianza_ausente_cuenta_como_cero(ia):
    ia.lectura = {k: v for k, v in LECTURA_COMPLETA.items() if k != "confianza"}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["faltantes"] == ["Número de talonario", "Destino", "Transportador", "Fecha"]


async def test_extraer_llegada_directa_elegida_no_exige_destino_ni_transportador(ia):
    ia.lectura = {**LECTURA_COMPLETA, "destino": "", "transportador": ""}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, directo=True)
    assert resultado["faltantes"] == []
    assert resultado["punto_destino"] is None


async def test_extraer_llegada_directa_con_solo_texto_libre_no_falta_productos(ia):
    ia.lectura = {**LECTURA_COMPLETA, "items": [], "texto_libre": "  10 bultos\n  de sal "}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, directo=True)
    assert resultado["faltantes"] == []
    assert resultado["texto_libre"] == "10 bultos de sal"


async def test_extraer_llegada_directa_sin_items_ni_texto_falta_productos(ia):
    ia.lectura = {**LECTURA_COMPLETA, "items": [], "texto_libre": "  "}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, directo=True)
    assert resultado["faltantes"] == ["Productos"]


async def test_extraer_entre_puntos_el_texto_libre_no_sustituye_los_productos(ia):
    ia.lectura = {**LECTURA_COMPLETA, "items": [], "texto_libre": "algo escrito"}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["faltantes"] == ["Productos"]


async def test_extraer_usa_llega_directo_de_la_ia_si_el_operador_no_eligio(ia):
    ia.lectura = {**LECTURA_COMPLETA, "destino": "", "transportador": "", "llega_directo": True}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    assert resultado["llega_directo"] is True
    assert resultado["faltantes"] == []


async def test_extraer_la_eleccion_del_operador_manda_sobre_la_ia(ia):
    ia.lectura = {**LECTURA_COMPLETA, "destino": "", "transportador": "", "llega_directo": True}
    resultado = await tp.extraer_talonario(FOTO, PUNTO_ORIGEN, directo=False)
    assert resultado["faltantes"] == ["Destino", "Transportador"]
    assert resultado["llega_directo"] is True  # lo que leyo la IA, informativo para la app


async def test_extraer_excluye_el_punto_origen_de_los_destinos(ia, conn):
    await tp.extraer_talonario(FOTO, PUNTO_ORIGEN)
    (_, sql, args) = conn.sql_ejecutado("from puntos where activo")[0]
    assert "id <> $1::uuid" in sql and args == (PUNTO_ORIGEN,)


# ---------------------------------------------------------------------------
# Listados (forma y filtros)
# ---------------------------------------------------------------------------


async def test_listar_syscafe_pasa_los_filtros_y_serializa_los_uuid(pool, conn):
    import uuid

    uid = uuid.uuid4()
    conn.responder("fetch", "from traslados_puntos t", [{"tipo": "traslado", "id": uid, "talonario_id": None, "punto_origen_id": uid, "punto_destino_id": None}])
    resultado = await tp.listar_traslados_syscafe(PUNTO_ORIGEN, False, date(2026, 1, 1), date(2026, 1, 31))
    assert resultado == [{"tipo": "traslado", "id": str(uid), "talonario_id": None, "punto_origen_id": str(uid), "punto_destino_id": None}]
    (_, sql, args) = conn.sql_ejecutado("from traslados_puntos t")[0]
    assert args == (PUNTO_ORIGEN, date(2026, 1, 1), date(2026, 1, 31))
    assert "union all" in sql  # incluye las hojas anuladas


async def test_listar_syscafe_pendientes_excluye_las_anuladas(pool, conn):
    await tp.listar_traslados_syscafe(None, True)
    (_, sql, _) = conn.sql_ejecutado("from traslados_puntos t")[0]
    assert "t.numero_syscafe is null" in sql
    assert "union all" not in sql


async def test_listar_historial_pide_solo_los_eventos_del_punto(pool, conn):
    conn.responder("fetch", "from logs l", [{"evento": "traslado_punto_creado"}])
    assert await tp.listar_historial(TRASLADO) == [{"evento": "traslado_punto_creado"}]
    (_, _, args) = conn.sql_ejecutado("from logs l")[0]
    assert args == (
        TRASLADO, "traslado_punto_creado", "traslado_punto_recibido", "traslado_punto_novedad", "llegada_directa_registrada",
    )


def _fila_actividad(tipo, **extra):
    from datetime import datetime, timezone

    fila = {
        "tipo": tipo, "momento": datetime(2026, 3, 5, 12, 0, tzinfo=timezone.utc), "traslado_id": None,
        "referencia": "A 6305", "origen": "CFC", "destino": "BDG", "actor": None, "detalle": None,
        "estado": "en_transito", "tipo_traslado": "entre_puntos",
    }
    fila.update(extra)
    return fila


@pytest.mark.parametrize(
    "fila, texto",
    [
        (_fila_actividad("envio"), "CFC envió A 6305 a BDG"),
        (_fila_actividad("envio", tipo_traslado="directo", estado="recibido"), "BDG registró la llegada directa A 6305"),
        (
            _fila_actividad("envio", tipo_traslado="directo", estado="recibido_con_novedad"),
            "BDG registró la llegada directa A 6305 con novedad",
        ),
        (_fila_actividad("recepcion", estado="recibido"), "BDG recibió A 6305"),
        (_fila_actividad("recepcion", estado="recibido_con_novedad"), "BDG recibió A 6305 con novedad"),
        (_fila_actividad("solucion", detalle="NPT-12"), "Supervisión resolvió la novedad de A 6305 (NPT-12)"),
        (_fila_actividad("solucion"), "Supervisión resolvió la novedad de A 6305"),
        (_fila_actividad("syscafe", actor="Erika", detalle="NBR-945"), "Erika asignó Syscafe NBR-945 a A 6305"),
        (_fila_actividad("syscafe"), "Supervisión quitó el Syscafe de A 6305"),
        (_fila_actividad("anulada", detalle="hoja dañada", destino=None), "Se anuló la hoja A 6305 de CFC: hoja dañada"),
        (_fila_actividad("anulada", origen=None, destino=None), "Se anuló la hoja A 6305 de —"),
    ],
)
async def test_listar_actividad_redacta_cada_tipo_en_lenguaje_simple(pool, conn, fila, texto):
    conn.responder("fetch", "union all", [fila])
    (item,) = await tp.listar_actividad(10)
    assert item["texto"] == texto
    assert item["momento"].startswith("2026-03-05T12:00:00")


async def test_listar_actividad_serializa_el_id_del_traslado(pool, conn):
    import uuid

    uid = uuid.uuid4()
    conn.responder("fetch", "union all", [_fila_actividad("envio", traslado_id=uid)])
    (item,) = await tp.listar_actividad()
    assert item["traslado_id"] == str(uid)
    assert conn.sql_ejecutado("union all")[0][2] == (50,)
