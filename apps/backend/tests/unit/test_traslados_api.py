"""Router de traslados, puntos, supervisores y talonarios (app/routers/
traslados_puntos.py): mapeo de errores a codigos HTTP, validacion de entrada,
orden de rutas y guardas de autenticacion.

Los servicios se sustituyen por dobles para aislar el router; la logica de los
servicios se prueba en test_traslados_servicio.py y test_talonarios_servicio.py."""

import uuid

import pytest

from app.routers import traslados_puntos as rt
from app.services import talonarios as tl
from app.services import traslados_puntos as tp
from app.services.vision import ExtraccionFallida
from tests.helpers import encabezado_bearer, fila_usuario_dashboard
from tests.helpers_traslados import (
    PUNTO_DESTINO,
    PUNTO_ORIGEN,
    SUPERVISOR,
    USUARIO_ORIGEN,
    cuerpo_llegada_directa,
    cuerpo_recepcion,
    cuerpo_solucion,
    cuerpo_traslado,
)

TRASLADO = str(uuid.uuid4())
ITEM = str(uuid.uuid4())


def _resultado_traslado(**extra) -> dict:
    """Lo que devuelven los servicios: UUID crudos de asyncpg e `items` adentro."""
    resultado = {
        "id": uuid.UUID(TRASLADO),
        "punto_origen_id": uuid.UUID(PUNTO_ORIGEN),
        "punto_destino_id": uuid.UUID(PUNTO_DESTINO),
        "creado_por": uuid.UUID(USUARIO_ORIGEN),
        "talonario_id": None,
        "recibido_por": None,
        "solucionado_por": None,
        "estado": "en_transito",
        "items": [{"id": uuid.UUID(ITEM), "traslado_id": uuid.UUID(TRASLADO), "cantidad": 3}],
    }
    resultado.update(extra)
    return resultado


def _servicio(monkeypatch, nombre: str, resultado=None, *, lanza: Exception | None = None, llamadas=None):
    """Sustituye una funcion de servicio importada en el router."""

    async def _doble(*args, **kwargs):
        if llamadas is not None:
            llamadas.append((args, kwargs))
        if lanza is not None:
            raise lanza
        return resultado() if callable(resultado) else resultado

    monkeypatch.setattr(rt, nombre, _doble)


# ---------------------------------------------------------------------------
# POST /traslados-puntos y /traslados-puntos/llegada-directa
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ruta, servicio, cuerpo",
    [
        ("/traslados-puntos", "crear_traslado", cuerpo_traslado),
        ("/traslados-puntos/llegada-directa", "crear_llegada_directa", cuerpo_llegada_directa),
    ],
)
class TestCrearTrasladoYLlegada:
    async def test_exito_responde_201_con_uuid_como_texto(self, cliente, monkeypatch, ruta, servicio, cuerpo):
        _servicio(monkeypatch, servicio, _resultado_traslado)
        res = await cliente.post(ruta, json=cuerpo())
        assert res.status_code == 201
        datos = res.json()
        assert datos["id"] == TRASLADO and datos["punto_origen_id"] == PUNTO_ORIGEN
        assert datos["items"] == [{"id": ITEM, "traslado_id": TRASLADO, "cantidad": 3}]

    @pytest.mark.parametrize("error", [tl.TalonarioNoDisponible("agotado"), tl.TalonarioConflicto("hoja usada")])
    async def test_conflictos_de_talonario_responden_409(self, cliente, monkeypatch, ruta, servicio, cuerpo, error):
        _servicio(monkeypatch, servicio, lanza=error)
        res = await cliente.post(ruta, json=cuerpo())
        assert res.status_code == 409
        assert res.json()["detail"] == str(error)

    async def test_validacion_de_negocio_responde_422(self, cliente, monkeypatch, ruta, servicio, cuerpo):
        _servicio(monkeypatch, servicio, lanza=tp.TrasladoInvalido("firmas faltantes"))
        res = await cliente.post(ruta, json=cuerpo())
        assert (res.status_code, res.json()["detail"]) == (422, "firmas faltantes")

    async def test_cuerpo_incompleto_responde_422_sin_llamar_al_servicio(self, cliente, monkeypatch, ruta, servicio, cuerpo):
        llamadas: list = []
        _servicio(monkeypatch, servicio, _resultado_traslado, llamadas=llamadas)
        incompleto = cuerpo()
        incompleto.pop("numero_talonario")
        res = await cliente.post(ruta, json=incompleto)
        assert res.status_code == 422 and llamadas == []

    async def test_numero_de_talonario_con_caracteres_invalidos_responde_422(self, cliente, monkeypatch, ruta, servicio, cuerpo):
        llamadas: list = []
        _servicio(monkeypatch, servicio, _resultado_traslado, llamadas=llamadas)
        res = await cliente.post(ruta, json=cuerpo(numero_talonario="A;DROP"))
        assert res.status_code == 422 and llamadas == []


async def test_crear_traslado_sin_items_o_con_cantidad_cero_responde_422(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "crear_traslado", _resultado_traslado, llamadas=llamadas)
    assert (await cliente.post("/traslados-puntos", json=cuerpo_traslado(items=[]))).status_code == 422
    malo = cuerpo_traslado(items=[{"producto": "SAL", "cantidad": 0}])
    assert (await cliente.post("/traslados-puntos", json=malo)).status_code == 422
    assert llamadas == []


# ---------------------------------------------------------------------------
# POST /traslados-puntos/extraer
# ---------------------------------------------------------------------------


async def test_extraer_pasa_los_campos_al_servicio(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "extraer_talonario", {"faltantes": []}, llamadas=llamadas)
    res = await cliente.post(
        "/traslados-puntos/extraer",
        json={"foto_url": "https://x/f.webp", "punto_origen_id": PUNTO_ORIGEN, "letra": "V", "directo": True},
    )
    assert (res.status_code, res.json()) == (200, {"faltantes": []})
    assert llamadas == [(("https://x/f.webp", PUNTO_ORIGEN, "V", True), {})]


async def test_extraer_sin_talonario_responde_409(cliente, monkeypatch):
    _servicio(monkeypatch, "extraer_talonario", lanza=tl.TalonarioNoDisponible("Configura tu talonario"))
    res = await cliente.post("/traslados-puntos/extraer", json={"foto_url": "u", "punto_origen_id": PUNTO_ORIGEN})
    assert (res.status_code, res.json()["detail"]) == (409, "Configura tu talonario")


async def test_extraer_con_foto_ilegible_responde_422(cliente, monkeypatch):
    _servicio(monkeypatch, "extraer_talonario", lanza=ExtraccionFallida("Respuesta de IA invalida"))
    res = await cliente.post("/traslados-puntos/extraer", json={"foto_url": "u", "punto_origen_id": PUNTO_ORIGEN})
    assert (res.status_code, res.json()["detail"]) == (422, "Respuesta de IA invalida")


async def test_extraer_exige_foto_y_punto(cliente):
    assert (await cliente.post("/traslados-puntos/extraer", json={"foto_url": "u"})).status_code == 422


# ---------------------------------------------------------------------------
# Talonarios
# ---------------------------------------------------------------------------


async def test_talonario_del_punto_sin_configurar_responde_200_con_listas_vacias(cliente, monkeypatch):
    _servicio(monkeypatch, "obtener_talonarios_activos", [])
    res = await cliente.get(f"/puntos/{PUNTO_ORIGEN}/talonario")
    assert (res.status_code, res.json()) == (200, {"talonarios": [], "talonario": None})


async def test_talonario_del_punto_conserva_el_primero_para_la_app_vieja(cliente, monkeypatch):
    _servicio(monkeypatch, "obtener_talonarios_activos", [{"letra": "A"}, {"letra": "V"}])
    res = await cliente.get(f"/puntos/{PUNTO_ORIGEN}/talonario")
    assert res.json()["talonario"] == {"letra": "A"} and len(res.json()["talonarios"]) == 2


async def test_talonario_con_id_de_punto_mal_formado_responde_422(cliente):
    assert (await cliente.get("/puntos/no-es-uuid/talonario")).status_code == 422


async def test_resumen_de_talonarios(cliente, monkeypatch):
    _servicio(monkeypatch, "resumen_talonarios_puntos", [{"punto_id": PUNTO_ORIGEN, "talonarios": []}])
    res = await cliente.get("/talonarios-puntos/resumen")
    assert res.status_code == 200 and res.json()[0]["punto_id"] == PUNTO_ORIGEN


CUERPO_CONFIGURAR = {"punto_id": PUNTO_ORIGEN, "usuario_id": USUARIO_ORIGEN, "letra": "a", "numero_inicial": 6300}


async def test_configurar_talonario_responde_201(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "configurar_talonario", {"letra": "A"}, llamadas=llamadas)
    res = await cliente.post("/talonarios-puntos/configurar", json=CUERPO_CONFIGURAR)
    assert (res.status_code, res.json()) == (201, {"talonario": {"letra": "A"}})
    assert llamadas[0][0][0].letra == "A"  # el modelo ya normalizo la letra


@pytest.mark.parametrize(
    "error, codigo",
    [(tl.TalonarioConflicto("otro configuro"), 409), (tl.TalonarioInvalido("falta el motivo"), 422)],
)
async def test_configurar_talonario_mapea_errores(cliente, monkeypatch, error, codigo):
    _servicio(monkeypatch, "configurar_talonario", lanza=error)
    res = await cliente.post("/talonarios-puntos/configurar", json=CUERPO_CONFIGURAR)
    assert (res.status_code, res.json()["detail"]) == (codigo, str(error))


@pytest.mark.parametrize(
    "cambio",
    [{"letra": "1"}, {"letra": "ABCD"}, {"numero_inicial": 0}, {"numero_inicial": 9_999_999}, {"punto_id": "x"}],
)
async def test_configurar_talonario_valida_la_entrada(cliente, monkeypatch, cambio):
    llamadas: list = []
    _servicio(monkeypatch, "configurar_talonario", {}, llamadas=llamadas)
    res = await cliente.post("/talonarios-puntos/configurar", json={**CUERPO_CONFIGURAR, **cambio})
    assert res.status_code == 422 and llamadas == []


async def test_anular_hoja_responde_200_y_mapea_el_error(cliente, monkeypatch):
    cuerpo = {"punto_id": PUNTO_ORIGEN, "usuario_id": USUARIO_ORIGEN, "motivo": "danada"}
    _servicio(monkeypatch, "anular_siguiente_hoja", {"hoja_anulada": "A 6300"})
    res = await cliente.post("/talonarios-puntos/anular-hoja", json=cuerpo)
    assert (res.status_code, res.json()) == (200, {"hoja_anulada": "A 6300"})

    _servicio(monkeypatch, "anular_siguiente_hoja", lanza=tl.TalonarioInvalido("agotado"))
    res = await cliente.post("/talonarios-puntos/anular-hoja", json=cuerpo)
    assert (res.status_code, res.json()["detail"]) == (422, "agotado")


@pytest.mark.parametrize("motivo", ["", "   ", "x" * 501])
async def test_anular_hoja_exige_motivo_valido(cliente, monkeypatch, motivo):
    llamadas: list = []
    _servicio(monkeypatch, "anular_siguiente_hoja", {}, llamadas=llamadas)
    cuerpo = {"punto_id": PUNTO_ORIGEN, "usuario_id": USUARIO_ORIGEN, "motivo": motivo}
    assert (await cliente.post("/talonarios-puntos/anular-hoja", json=cuerpo)).status_code == 422
    assert llamadas == []


# ---------------------------------------------------------------------------
# Listados y orden de rutas
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ruta", ["novedades", "buscar-consecutivo", "syscafe", "actividad"])
async def test_las_rutas_fijas_no_las_captura_el_parametro_traslado_id(cliente, pool, monkeypatch, ruta):
    """Si /{traslado_id} se declarara antes, 'novedades' etc. darian 422 (UUID invalido)."""
    _servicio(monkeypatch, "listar_traslados_syscafe", [])
    _servicio(monkeypatch, "listar_actividad", [])
    res = await cliente.get(f"/traslados-puntos/{ruta}")
    assert res.status_code == 200


async def test_listar_traslados_sin_filtros(cliente, pool, conn):
    res = await cliente.get("/traslados-puntos")
    assert (res.status_code, res.json()) == (200, [])
    (_, sql, args) = conn.sql_ejecutado("from traslados_puntos t")[0]
    assert "t.punto_destino_id =" not in sql and args == ()
    assert "limit 100" in sql


async def test_listar_traslados_combina_los_filtros_con_parametros(cliente, pool, conn):
    conn.responder("fetch", "from traslados_puntos t", [{"id": uuid.UUID(TRASLADO), "creado_por": uuid.UUID(USUARIO_ORIGEN), "cantidad_items": 2}])
    res = await cliente.get(
        "/traslados-puntos",
        params={"destino_id": PUNTO_DESTINO, "origen_id": PUNTO_ORIGEN, "estado": "en_transito", "tipo": "entre_puntos"},
    )
    assert res.status_code == 200
    assert res.json() == [{"id": TRASLADO, "creado_por": USUARIO_ORIGEN, "cantidad_items": 2}]
    (_, sql, args) = conn.sql_ejecutado("from traslados_puntos t")[0]
    assert args == (PUNTO_DESTINO, PUNTO_ORIGEN, "en_transito", "entre_puntos")
    assert "t.punto_destino_id = $1::uuid" in sql and "t.tipo = $4" in sql


@pytest.mark.parametrize("tipo", ["otro", "DIRECTO", ""])
async def test_listar_traslados_tipo_invalido(cliente, pool, tipo):
    res = await cliente.get("/traslados-puntos", params={"tipo": tipo})
    assert res.status_code == 422


async def test_listar_traslados_con_ids_mal_formados_responde_422_y_no_revienta_postgres(cliente, pool):
    assert (await cliente.get("/traslados-puntos", params={"destino_id": "x"})).status_code == 422
    assert (await cliente.get("/traslados-puntos", params={"origen_id": "x"})).status_code == 422


async def test_novedades_pendientes_ordena_la_mas_antigua_primero(cliente, pool, conn):
    await cliente.get("/traslados-puntos/novedades")
    (_, sql, args) = conn.sql_ejecutado("t.novedad_estado = $1")[0]
    assert args == ("pendiente",) and "order by t.recibido_at asc" in sql


async def test_novedades_resueltas_ordena_la_mas_reciente_primero(cliente, pool, conn):
    await cliente.get("/traslados-puntos/novedades", params={"estado": "resuelta"})
    (_, sql, args) = conn.sql_ejecutado("t.novedad_estado = $1")[0]
    assert args == ("resuelta",) and "order by t.solucionado_at desc" in sql


async def test_buscar_consecutivo_vacio_no_consulta_la_base(cliente, pool, conn):
    res = await cliente.get("/traslados-puntos/buscar-consecutivo", params={"q": "   "})
    assert (res.status_code, res.json()) == (200, [])
    assert conn.llamadas == []


async def test_buscar_consecutivo_busca_por_coincidencia_parcial_solo_en_resueltas(cliente, pool, conn):
    await cliente.get("/traslados-puntos/buscar-consecutivo", params={"q": " npt-12 "})
    (_, sql, args) = conn.sql_ejecutado("consecutivo_solucion ilike")[0]
    assert args == ("%npt-12%",) and "novedad_estado = 'resuelta'" in sql


async def test_syscafe_pasa_los_filtros_al_servicio(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "listar_traslados_syscafe", [{"tipo": "traslado"}], llamadas=llamadas)
    res = await cliente.get(
        "/traslados-puntos/syscafe",
        params={"punto_id": PUNTO_ORIGEN, "pendientes": "true", "desde": "2026-01-01", "hasta": "2026-01-31"},
    )
    assert res.json() == [{"tipo": "traslado"}]
    ((punto, pendientes, desde, hasta), _) = llamadas[0]
    assert (punto, pendientes, str(desde), str(hasta)) == (PUNTO_ORIGEN, True, "2026-01-01", "2026-01-31")


@pytest.mark.parametrize("params", [{"desde": "ayer"}, {"punto_id": "x"}])
async def test_syscafe_valida_fechas_y_ids(cliente, monkeypatch, params):
    _servicio(monkeypatch, "listar_traslados_syscafe", [])
    assert (await cliente.get("/traslados-puntos/syscafe", params=params)).status_code == 422


@pytest.mark.parametrize("limite, esperado", [(0, 1), (-5, 1), (10, 10), (1000, 200)])
async def test_actividad_limita_el_tamano_pedido(cliente, monkeypatch, limite, esperado):
    llamadas: list = []
    _servicio(monkeypatch, "listar_actividad", [], llamadas=llamadas)
    await cliente.get("/traslados-puntos/actividad", params={"limite": limite})
    assert llamadas == [((esperado,), {})]


async def test_obtener_traslado_inexistente_responde_404(cliente, pool):
    res = await cliente.get(f"/traslados-puntos/{TRASLADO}")
    assert (res.status_code, res.json()["detail"]) == (404, "Traslado no encontrado")


async def test_obtener_traslado_incluye_sus_items(cliente, pool, conn):
    conn.responder("fetchrow", "where t.id = $1::uuid", {"id": uuid.UUID(TRASLADO), "creado_por": uuid.UUID(USUARIO_ORIGEN)})
    conn.responder("fetch", "from traslado_punto_items", [{"id": uuid.UUID(ITEM), "traslado_id": uuid.UUID(TRASLADO), "cantidad": 3}])
    res = await cliente.get(f"/traslados-puntos/{TRASLADO}")
    assert res.status_code == 200
    assert res.json()["items"] == [{"id": ITEM, "traslado_id": TRASLADO, "cantidad": 3}]


async def test_traslado_con_id_mal_formado_responde_422(cliente, pool):
    assert (await cliente.get("/traslados-puntos/123")).status_code == 422
    assert (await cliente.get("/traslados-puntos/123/historial")).status_code == 422


async def test_historial_del_traslado(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "listar_historial", [{"evento": "traslado_punto_creado"}], llamadas=llamadas)
    res = await cliente.get(f"/traslados-puntos/{TRASLADO}/historial")
    assert res.json() == [{"evento": "traslado_punto_creado"}] and llamadas == [((TRASLADO,), {})]


# ---------------------------------------------------------------------------
# Recepcion y solucion de novedades
# ---------------------------------------------------------------------------


def _cuerpo_recepcion() -> dict:
    return cuerpo_recepcion([{"id": ITEM, "cantidad_recibida": 3}])


async def test_recepcion_exitosa(cliente, monkeypatch):
    _servicio(monkeypatch, "registrar_recepcion", lambda: _resultado_traslado(estado="recibido"))
    res = await cliente.post(f"/traslados-puntos/{TRASLADO}/recepcion", json=_cuerpo_recepcion())
    assert res.status_code == 200 and res.json()["estado"] == "recibido"


@pytest.mark.parametrize(
    "error, codigo",
    [
        (tp.TrasladoNoEncontrado("Traslado no encontrado"), 404),
        (tp.TrasladoYaRecibido("Este traslado ya fue recibido"), 409),
        (tp.TrasladoInvalido("cantidad de mas"), 422),
    ],
)
async def test_recepcion_mapea_errores(cliente, monkeypatch, error, codigo):
    _servicio(monkeypatch, "registrar_recepcion", lanza=error)
    res = await cliente.post(f"/traslados-puntos/{TRASLADO}/recepcion", json=_cuerpo_recepcion())
    assert (res.status_code, res.json()["detail"]) == (codigo, str(error))


@pytest.mark.parametrize(
    "cuerpo",
    [
        cuerpo_recepcion([]),
        cuerpo_recepcion([{"id": ITEM, "cantidad_recibida": -1}]),
        {"items": [{"id": ITEM, "cantidad_recibida": 1}]},
    ],
)
async def test_recepcion_valida_la_entrada(cliente, monkeypatch, cuerpo):
    llamadas: list = []
    _servicio(monkeypatch, "registrar_recepcion", {}, llamadas=llamadas)
    assert (await cliente.post(f"/traslados-puntos/{TRASLADO}/recepcion", json=cuerpo)).status_code == 422
    assert llamadas == []


async def test_solucion_exitosa(cliente, monkeypatch):
    _servicio(monkeypatch, "resolver_novedad", lambda: _resultado_traslado(novedad_estado="resuelta"))
    res = await cliente.post(f"/traslados-puntos/{TRASLADO}/solucion", json=cuerpo_solucion())
    assert res.status_code == 200 and res.json()["novedad_estado"] == "resuelta"


@pytest.mark.parametrize(
    "error, codigo",
    [
        (tp.NovedadNoEncontrada("Traslado no encontrado"), 404),
        (tp.NovedadYaResuelta("Esta novedad ya fue resuelta"), 409),
        (tp.ConsecutivoDuplicado("Ese consecutivo ya está registrado"), 409),
        (tp.NovedadInvalida("Supervisor invalido o inactivo"), 422),
    ],
)
async def test_solucion_mapea_errores(cliente, monkeypatch, error, codigo):
    _servicio(monkeypatch, "resolver_novedad", lanza=error)
    res = await cliente.post(f"/traslados-puntos/{TRASLADO}/solucion", json=cuerpo_solucion())
    assert (res.status_code, res.json()["detail"]) == (codigo, str(error))


async def test_los_dos_409_de_la_solucion_tienen_detalle_distinto(cliente, monkeypatch):
    """El movil distingue 'ya la resolvio otro' de 'ese consecutivo ya existe' por el texto."""
    _servicio(monkeypatch, "resolver_novedad", lanza=tp.NovedadYaResuelta("Esta novedad ya fue resuelta"))
    a = (await cliente.post(f"/traslados-puntos/{TRASLADO}/solucion", json=cuerpo_solucion())).json()["detail"]
    _servicio(monkeypatch, "resolver_novedad", lanza=tp.ConsecutivoDuplicado("Ese consecutivo ya está registrado"))
    b = (await cliente.post(f"/traslados-puntos/{TRASLADO}/solucion", json=cuerpo_solucion())).json()["detail"]
    assert a != b


@pytest.mark.parametrize(
    "cambio",
    [{"solucion": "  "}, {"solucion": "x" * 2001}, {"consecutivo_codigo": "N-1"}, {"consecutivo_numero": "12a"}, {"consecutivo_numero": ""}],
)
async def test_solucion_valida_la_entrada(cliente, monkeypatch, cambio):
    llamadas: list = []
    _servicio(monkeypatch, "resolver_novedad", {}, llamadas=llamadas)
    res = await cliente.post(f"/traslados-puntos/{TRASLADO}/solucion", json=cuerpo_solucion(**cambio))
    assert res.status_code == 422 and llamadas == []


# ---------------------------------------------------------------------------
# Syscafe (movil y dashboard)
# ---------------------------------------------------------------------------


async def test_syscafe_movil_guarda_con_el_nombre_del_supervisor(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "validar_supervisor_activo", "Erika")
    _servicio(monkeypatch, "asignar_numero_syscafe", lambda: _resultado_traslado(numero_syscafe="NBR-945"), llamadas=llamadas)
    res = await cliente.patch(
        f"/traslados-puntos/{TRASLADO}/syscafe", json={"supervisor_id": SUPERVISOR, "numero_syscafe": "nbr 945"}
    )
    assert res.status_code == 200 and res.json()["numero_syscafe"] == "NBR-945"
    assert llamadas == [((TRASLADO, "NBR-945", "Erika"), {})]  # el router ya normalizo el valor


async def test_syscafe_movil_con_supervisor_invalido_responde_422_sin_escribir(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "validar_supervisor_activo", lanza=tp.TrasladoInvalido("Supervisor invalido o inactivo"))
    _servicio(monkeypatch, "asignar_numero_syscafe", {}, llamadas=llamadas)
    res = await cliente.patch(
        f"/traslados-puntos/{TRASLADO}/syscafe", json={"supervisor_id": SUPERVISOR, "numero_syscafe": "NBR-945"}
    )
    assert (res.status_code, res.json()["detail"]) == (422, "Supervisor invalido o inactivo")
    assert llamadas == []


async def test_syscafe_con_formato_invalido_responde_422_con_texto_y_no_escribe(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "validar_supervisor_activo", "Erika")
    _servicio(monkeypatch, "asignar_numero_syscafe", {}, llamadas=llamadas)
    res = await cliente.patch(
        f"/traslados-puntos/{TRASLADO}/syscafe", json={"supervisor_id": SUPERVISOR, "numero_syscafe": "945"}
    )
    assert res.status_code == 422 and isinstance(res.json()["detail"], str)  # texto, no lista de pydantic
    assert llamadas == []


@pytest.mark.parametrize(
    "error, codigo",
    [(tp.TrasladoNoEncontrado("Traslado no encontrado"), 404), (tp.SyscafeDuplicado("ya asignado a A 6305"), 409)],
)
async def test_syscafe_mapea_errores_del_servicio(cliente, monkeypatch, error, codigo):
    _servicio(monkeypatch, "validar_supervisor_activo", "Erika")
    _servicio(monkeypatch, "asignar_numero_syscafe", lanza=error)
    res = await cliente.patch(
        f"/traslados-puntos/{TRASLADO}/syscafe", json={"supervisor_id": SUPERVISOR, "numero_syscafe": "NBR-945"}
    )
    assert (res.status_code, res.json()["detail"]) == (codigo, str(error))


async def test_syscafe_movil_valor_vacio_borra(cliente, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "validar_supervisor_activo", "Erika")
    _servicio(monkeypatch, "asignar_numero_syscafe", lambda: _resultado_traslado(numero_syscafe=None), llamadas=llamadas)
    res = await cliente.patch(f"/traslados-puntos/{TRASLADO}/syscafe", json={"supervisor_id": SUPERVISOR, "numero_syscafe": ""})
    assert res.status_code == 200 and llamadas[0][0][1] is None


def _sesion(conn, **kwargs) -> dict:
    fila = fila_usuario_dashboard(**kwargs)
    conn.responder("fetchrow", "from usuarios_dashboard where id", fila)
    return encabezado_bearer(fila)


RUTA_SYSCAFE_DASHBOARD = f"/traslados-puntos/{TRASLADO}/syscafe/dashboard"


async def test_syscafe_dashboard_sin_credenciales_responde_401(cliente, pool):
    res = await cliente.patch(RUTA_SYSCAFE_DASHBOARD, json={"numero_syscafe": "NBR-945"})
    assert res.status_code == 401


async def test_syscafe_dashboard_con_token_incorrecto_responde_401(cliente, pool):
    res = await cliente.patch(RUTA_SYSCAFE_DASHBOARD, json={"numero_syscafe": "NBR-945"}, headers={"X-Admin-Token": "mal"})
    assert res.status_code == 401


@pytest.mark.parametrize(
    "rol, area, codigo",
    [
        ("admin", "todo", 200),
        ("supervisor", "todo", 200),
        ("supervisor", "traslados", 200),
        ("supervisor", "bodega", 403),
        ("consulta", "traslados", 403),
        ("consulta", "todo", 403),
    ],
)
async def test_syscafe_dashboard_segun_rol_y_area(cliente, pool, conn, monkeypatch, rol, area, codigo):
    llamadas: list = []
    _servicio(monkeypatch, "asignar_numero_syscafe", lambda: _resultado_traslado(numero_syscafe="NBR-945"), llamadas=llamadas)
    encabezado = _sesion(conn, rol=rol, area=area)
    res = await cliente.patch(RUTA_SYSCAFE_DASHBOARD, json={"numero_syscafe": "NBR-945"}, headers=encabezado)
    assert res.status_code == codigo
    assert bool(llamadas) == (codigo == 200)  # un 403 jamas llega a escribir


async def test_syscafe_dashboard_guarda_con_el_nombre_de_la_sesion(cliente, pool, conn, monkeypatch):
    llamadas: list = []
    _servicio(monkeypatch, "asignar_numero_syscafe", lambda: _resultado_traslado(), llamadas=llamadas)
    encabezado = _sesion(conn, rol="supervisor", area="traslados")
    await cliente.patch(RUTA_SYSCAFE_DASHBOARD, json={"numero_syscafe": "nbr-945"}, headers=encabezado)
    assert llamadas == [((TRASLADO, "NBR-945", "Ana Prueba"), {})]


async def test_syscafe_dashboard_con_token_legacy_firma_como_administracion(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    _servicio(monkeypatch, "asignar_numero_syscafe", lambda: _resultado_traslado(), llamadas=llamadas)
    res = await cliente.patch(RUTA_SYSCAFE_DASHBOARD, json={"numero_syscafe": "NBR-945"}, headers=admin_headers)
    assert res.status_code == 200
    assert llamadas == [((TRASLADO, "NBR-945", "Administración"), {})]


async def test_syscafe_dashboard_formato_invalido_responde_422(cliente, pool, monkeypatch, admin_headers):
    llamadas: list = []
    _servicio(monkeypatch, "asignar_numero_syscafe", lambda: _resultado_traslado(), llamadas=llamadas)
    res = await cliente.patch(RUTA_SYSCAFE_DASHBOARD, json={"numero_syscafe": "x"}, headers=admin_headers)
    assert res.status_code == 422 and llamadas == []


# ---------------------------------------------------------------------------
# Guardas de los endpoints administrativos de puntos y supervisores
# ---------------------------------------------------------------------------

OTRO = str(uuid.uuid4())
ADMINISTRATIVOS = [
    ("POST", "/puntos", {"nombre": "Nuevo"}),
    ("POST", f"/puntos/{PUNTO_ORIGEN}/usuarios", {"nombre": "Ana", "pin": "1234"}),
    ("PATCH", f"/puntos/usuarios/{OTRO}", {"nombre": "Ana"}),
    ("DELETE", f"/puntos/usuarios/{OTRO}", None),
    ("POST", f"/puntos/usuarios/{OTRO}/pin", {"pin": "1234"}),
    ("PATCH", f"/puntos/{OTRO}", {"nombre": "Otro"}),
    ("DELETE", f"/puntos/{OTRO}", None),
    ("POST", "/supervisores", {"nombre": "Erika", "pin": "1234"}),
    ("PATCH", f"/supervisores/{OTRO}", {"nombre": "Erika"}),
    ("DELETE", f"/supervisores/{OTRO}", None),
    ("POST", f"/supervisores/{OTRO}/pin", {"pin": "1234"}),
]
LECTURAS_CON_INACTIVOS = [
    "/puntos?incluir_inactivos=true",
    f"/puntos/{PUNTO_ORIGEN}/usuarios?incluir_inactivos=true",
    "/supervisores?incluir_inactivos=true",
]


@pytest.mark.parametrize("metodo, ruta, cuerpo", ADMINISTRATIVOS)
class TestGuardasAdministrativas:
    async def test_sin_credenciales_responde_401(self, cliente, pool, conn, metodo, ruta, cuerpo):
        res = await cliente.request(metodo, ruta, json=cuerpo)
        assert res.status_code == 401
        assert conn.llamadas == []  # ni siquiera toca la base

    async def test_token_incorrecto_responde_401(self, cliente, pool, conn, metodo, ruta, cuerpo):
        res = await cliente.request(metodo, ruta, json=cuerpo, headers={"X-Admin-Token": "mal"})
        assert res.status_code == 401 and conn.llamadas == []

    @pytest.mark.parametrize("rol", ["supervisor", "consulta"])
    async def test_sesion_sin_rol_admin_responde_403(self, cliente, pool, conn, metodo, ruta, cuerpo, rol):
        encabezado = _sesion(conn, rol=rol, area="todo")
        conn.llamadas.clear()
        res = await cliente.request(metodo, ruta, json=cuerpo, headers=encabezado)
        assert res.status_code == 403
        assert [c for c in conn.llamadas if "usuarios_dashboard" not in c[1]] == []

    async def test_sesion_vencida_responde_401(self, cliente, pool, conn, metodo, ruta, cuerpo):
        res = await cliente.request(metodo, ruta, json=cuerpo, headers={"Authorization": "Bearer token-falso"})
        assert res.status_code == 401


@pytest.mark.parametrize("ruta", LECTURAS_CON_INACTIVOS)
async def test_listar_inactivos_exige_admin(cliente, pool, conn, ruta):
    assert (await cliente.get(ruta)).status_code == 401
    assert (await cliente.get(ruta, headers={"X-Admin-Token": "mal"})).status_code == 401
    assert conn.llamadas == []


async def test_listar_puntos_es_publico_y_solo_trae_activos(cliente, pool, conn):
    conn.responder("fetch", "from puntos where activo = true", [{"id": uuid.UUID(PUNTO_ORIGEN), "nombre": "CFC", "codigo": "CFC"}])
    res = await cliente.get("/puntos")
    assert res.status_code == 200 and res.json() == [{"id": PUNTO_ORIGEN, "nombre": "CFC", "codigo": "CFC"}]


async def test_listar_puntos_inactivos_con_token_agrega_el_campo_activo(cliente, pool, conn, admin_headers):
    conn.responder("fetch", "from puntos order by activo", [{"id": uuid.UUID(PUNTO_ORIGEN), "nombre": "CFC", "codigo": "CFC", "activo": False}])
    res = await cliente.get("/puntos", params={"incluir_inactivos": "true"}, headers=admin_headers)
    assert res.json()[0]["activo"] is False


async def test_listar_usuarios_de_punto_nunca_expone_el_pin(cliente, pool, conn):
    conn.responder(
        "fetch", "from usuarios_punto where punto_id",
        [{"id": uuid.UUID(USUARIO_ORIGEN), "punto_id": uuid.UUID(PUNTO_ORIGEN), "nombre": "Ana", "pin_hash": "h", "pin_salt": "s"}],
    )
    res = await cliente.get(f"/puntos/{PUNTO_ORIGEN}/usuarios")
    assert res.status_code == 200
    (usuario,) = res.json()
    assert "pin_hash" not in usuario and "pin_salt" not in usuario
    assert usuario["id"] == USUARIO_ORIGEN and usuario["punto_id"] == PUNTO_ORIGEN
    (_, sql, _) = conn.sql_ejecutado("from usuarios_punto where punto_id")[0]
    assert "estado = 'activo'" in sql  # el listado publico solo trae activos


async def test_listar_supervisores_publico_solo_trae_activos_y_sin_pin(cliente, pool, conn):
    conn.responder("fetch", "from supervisores where estado = 'activo'", [{"id": uuid.UUID(SUPERVISOR), "nombre": "Erika"}])
    res = await cliente.get("/supervisores")
    assert res.json() == [{"id": SUPERVISOR, "nombre": "Erika"}]


async def test_crear_punto_con_token_admin(cliente, pool, conn, admin_headers):
    conn.responder("fetchrow", "insert into puntos", {"id": uuid.UUID(PUNTO_ORIGEN), "nombre": "Nuevo"})
    res = await cliente.post("/puntos", json={"nombre": "Nuevo"}, headers=admin_headers)
    assert (res.status_code, res.json()) == (201, {"id": PUNTO_ORIGEN, "nombre": "Nuevo"})


async def test_crear_punto_repetido_responde_400(cliente, pool, conn, admin_headers):
    from tests.fakes import violacion_unica

    conn.responder("fetchrow", "insert into puntos", violacion_unica("puntos_nombre_key"))
    res = await cliente.post("/puntos", json={"nombre": "Repetido"}, headers=admin_headers)
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Login por PIN de puntos y supervisores
# ---------------------------------------------------------------------------


def _usuario_con_pin(pin: str, **extra) -> dict:
    from app.services.auth_pin import generar_sal, hashear_pin

    sal = generar_sal()
    fila = {"id": uuid.UUID(USUARIO_ORIGEN), "nombre": "Ana", "punto_id": uuid.UUID(PUNTO_ORIGEN), "pin_salt": sal, "pin_hash": hashear_pin(pin, sal)}
    fila.update(extra)
    return fila


async def test_login_de_punto_con_pin_correcto(cliente, pool, conn):
    conn.responder("fetchrow", "from usuarios_punto where id", _usuario_con_pin("1234"))
    res = await cliente.post("/puntos/auth/pin", json={"usuario_id": USUARIO_ORIGEN, "pin": "1234"})
    assert (res.status_code, res.json()) == (200, {"id": USUARIO_ORIGEN, "nombre": "Ana", "punto_id": PUNTO_ORIGEN})


async def test_login_de_punto_con_pin_incorrecto_o_usuario_inactivo(cliente, pool, conn):
    conn.responder("fetchrow", "from usuarios_punto where id", _usuario_con_pin("1234"), None)
    assert (await cliente.post("/puntos/auth/pin", json={"usuario_id": USUARIO_ORIGEN, "pin": "9999"})).status_code == 401
    assert (await cliente.post("/puntos/auth/pin", json={"usuario_id": USUARIO_ORIGEN, "pin": "1234"})).status_code == 401


async def test_login_de_punto_con_pin_de_formato_invalido_responde_422(cliente, pool):
    assert (await cliente.post("/puntos/auth/pin", json={"usuario_id": USUARIO_ORIGEN, "pin": "12"})).status_code == 422


async def test_login_de_supervisor(cliente, pool, conn):
    fila = _usuario_con_pin("4321")
    conn.responder("fetchrow", "from supervisores where id", fila, fila, None)
    bueno = await cliente.post("/supervisores/auth/pin", json={"supervisor_id": SUPERVISOR, "pin": "4321"})
    malo = await cliente.post("/supervisores/auth/pin", json={"supervisor_id": SUPERVISOR, "pin": "1111"})
    inactivo = await cliente.post("/supervisores/auth/pin", json={"supervisor_id": SUPERVISOR, "pin": "4321"})
    assert (bueno.status_code, malo.status_code, inactivo.status_code) == (200, 401, 401)
    assert "pin_hash" not in bueno.json()
