"""Numeracion secuencial de las hojas del talonario contra Postgres real: una
hoja no se toma dos veces, no se salta ninguna, anular avanza la numeracion y
las tomas simultaneas se serializan con el lock del talonario."""

import asyncio

import asyncpg
import pytest

from app.models.talonario import HojaAnular
from app.services import talonarios as tl
from app.services.traslados_puntos import crear_llegada_directa, crear_traslado
from tests.integration.conftest import eventos_en_logs
from tests.integration.datos_traslados import (
    configurar,
    escenario,
    hojas_usadas,
    llegada,
    traslado,
)

pytestmark = pytest.mark.integration


async def anular(esc, motivo="hoja danada", punto=None, usuario=None, **extra):
    return await tl.anular_siguiente_hoja(
        HojaAnular(punto_id=punto or esc.origen, usuario_id=usuario or esc.usuario_origen, motivo=motivo, **extra)
    )


# ---------------------------------------------------------------------------
# Secuencia
# ---------------------------------------------------------------------------


async def test_las_hojas_se_toman_en_orden_y_se_guardan_en_formato_canonico(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    for hoja in ("a-6300", "A6301", "a 6302"):
        await crear_traslado(traslado(esc, hoja))
    assert await hojas_usadas(pg, esc.origen) == ["A 6300", "A 6301", "A 6302"]
    (activo,) = await tl.obtener_talonarios_activos(esc.origen)
    assert (activo["siguiente_hoja"], activo["quedan"], activo["usadas"]) == ("A 6303", 47, 3)


async def test_una_hoja_no_se_puede_tomar_dos_veces(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    await crear_traslado(traslado(esc, "A 6300"))
    with pytest.raises(tl.TalonarioConflicto, match="A 6301"):
        await crear_traslado(traslado(esc, "A 6300"))
    assert await pg.fetchval("select count(*) from traslados_puntos") == 1
    assert (await eventos_en_logs(pg)).count("traslado_punto_creado") == 1


async def test_no_se_puede_saltar_una_hoja(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    with pytest.raises(tl.TalonarioConflicto, match="A 6300"):
        await crear_traslado(traslado(esc, "A 6301"))
    assert await pg.fetchval("select count(*) from traslados_puntos") == 0
    # El rechazo no consumio nada: la hoja correcta sigue disponible.
    await crear_traslado(traslado(esc, "A 6300"))


async def test_un_traslado_rechazado_no_deja_items_huerfanos(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    with pytest.raises(tl.TalonarioConflicto):
        await crear_traslado(traslado(esc, "A 6350"))
    assert await pg.fetchval("select count(*) from traslado_punto_items") == 0


async def test_el_talonario_se_agota_a_las_50_hojas(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    for n in range(6300, 6350):
        await crear_traslado(traslado(esc, f"A {n}", items=[{"producto": "sal", "cantidad": 1}]))
    (activo,) = await tl.obtener_talonarios_activos(esc.origen)
    assert activo["agotado"] and activo["quedan"] == 0 and activo["siguiente_hoja"] is None
    with pytest.raises(tl.TalonarioNoDisponible, match="agotado"):
        await crear_traslado(traslado(esc, "A 6350"))
    with pytest.raises(tl.TalonarioNoDisponible, match="agotado"):
        await tl.hojas_esperadas(esc.origen)
    with pytest.raises(tl.TalonarioInvalido, match="agotado"):
        await anular(esc)


async def test_punto_sin_talonario_no_puede_crear_traslados(pg):
    esc = await escenario(pg)
    with pytest.raises(tl.TalonarioNoDisponible, match="no tiene un talonario activo"):
        await crear_traslado(traslado(esc, "A 6300"))
    assert await pg.fetchval("select count(*) from traslados_puntos") == 0


async def test_talonario_ya_en_uso_arranca_en_la_hoja_indicada(pg):
    esc = await escenario(pg)
    nuevo = await configurar(pg, esc.origen, esc.usuario_origen, numero_siguiente=6320)
    assert (nuevo["siguiente_hoja"], nuevo["quedan"]) == ("A 6320", 30)
    with pytest.raises(tl.TalonarioConflicto, match="A 6320"):
        await crear_traslado(traslado(esc, "A 6300"))
    await crear_traslado(traslado(esc, "A 6320"))


async def test_cada_letra_lleva_su_propia_secuencia_en_paralelo(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen, "A", 6300)
    await configurar(pg, esc.origen, esc.usuario_origen, "V", 100)
    await crear_traslado(traslado(esc, "V 100"))
    await crear_traslado(traslado(esc, "A 6300"))
    with pytest.raises(tl.TalonarioConflicto, match="V 101"):
        await crear_traslado(traslado(esc, "V 100"))
    activos = {a["letra"]: a for a in await tl.obtener_talonarios_activos(esc.origen)}
    assert (activos["A"]["siguiente_hoja"], activos["V"]["siguiente_hoja"]) == ("A 6301", "V 101")


async def test_hoja_de_una_letra_que_el_punto_no_tiene(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    with pytest.raises(tl.TalonarioConflicto, match="no corresponde a un talonario activo"):
        await crear_traslado(traslado(esc, "Z 1"))


async def test_los_talonarios_de_dos_puntos_son_independientes(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen, "A", 6300)
    await configurar(pg, esc.destino, esc.usuario_destino, "A", 100)
    await crear_traslado(traslado(esc, "A 6300"))
    # El destino no consumio nada: su primera hoja sigue siendo A 100.
    (activo,) = await tl.obtener_talonarios_activos(esc.destino)
    assert activo["siguiente_hoja"] == "A 100"


async def test_el_indice_unico_de_la_base_es_el_ultimo_seguro_contra_hojas_repetidas(pg):
    esc = await escenario(pg)
    nuevo = await configurar(pg, esc.origen, esc.usuario_origen)
    await crear_traslado(traslado(esc, "A 6300"))
    with pytest.raises(asyncpg.UniqueViolationError) as exc:
        await pg.execute(
            """
            insert into traslados_puntos (id, punto_origen_id, punto_destino_id, fecha, creado_por, numero_talonario, talonario_id)
            values (gen_random_uuid(), $1::uuid, $2::uuid, current_date, $3::uuid, 'A 6300', $4::uuid)
            """,
            esc.origen, esc.destino, esc.usuario_origen, nuevo["id"],
        )
    assert exc.value.constraint_name == "traslados_puntos_talonario_hoja_key"


# ---------------------------------------------------------------------------
# Anulacion
# ---------------------------------------------------------------------------


async def test_anular_avanza_la_numeracion_y_la_hoja_anulada_ya_no_se_puede_tomar(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    resultado = await anular(esc, "mal impresa")
    assert resultado["hoja_anulada"] == "A 6300"
    assert resultado["talonario"]["siguiente_hoja"] == "A 6301"
    with pytest.raises(tl.TalonarioConflicto, match="A 6301"):
        await crear_traslado(traslado(esc, "A 6300"))
    await crear_traslado(traslado(esc, "A 6301"))
    assert await eventos_en_logs(pg) == ["talonario_configurado", "talonario_hoja_anulada", "traslado_punto_creado"]


async def test_anular_varias_veces_consume_hojas_consecutivas_y_cuenta_como_gastadas(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    await crear_traslado(traslado(esc, "A 6300"))
    anuladas = [(await anular(esc))["hoja_anulada"] for _ in range(3)]
    assert anuladas == ["A 6301", "A 6302", "A 6303"]
    (activo,) = await tl.obtener_talonarios_activos(esc.origen)
    assert (activo["siguiente_hoja"], activo["quedan"], activo["usadas"], activo["anuladas"]) == ("A 6304", 46, 1, 3)
    filas = await pg.fetch("select numero, motivo from talonario_hojas_anuladas order by numero")
    assert [(f["numero"], f["motivo"]) for f in filas] == [(6301, "hoja danada"), (6302, "hoja danada"), (6303, "hoja danada")]


async def test_anular_deja_el_evento_con_la_hoja_y_las_que_quedan(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    await anular(esc, "se mojo")
    fila = await pg.fetchrow("select * from logs where evento = 'talonario_hoja_anulada'")
    assert fila["detalle"] == {"hoja": "A 6300", "motivo": "se mojo", "quedan": 49}
    assert (fila["actor_id"], fila["sede_id"], fila["resultado"]) == (esc.usuario_origen, esc.origen, "ok")


async def test_anular_con_varios_talonarios_exige_indicar_cual(pg):
    esc = await escenario(pg)
    a = await configurar(pg, esc.origen, esc.usuario_origen, "A", 6300)
    await configurar(pg, esc.origen, esc.usuario_origen, "V", 100)
    with pytest.raises(tl.TalonarioInvalido, match="de cuál talonario"):
        await anular(esc)
    assert await pg.fetchval("select count(*) from talonario_hojas_anuladas") == 0
    assert (await anular(esc, talonario_id=a["id"]))["hoja_anulada"] == "A 6300"


async def test_anular_la_hoja_de_otro_punto_se_rechaza(pg):
    esc = await escenario(pg)
    talonario = await configurar(pg, esc.origen, esc.usuario_origen)
    with pytest.raises(tl.TalonarioInvalido, match="pertenecer a este punto"):
        await anular(esc, usuario=esc.usuario_destino)  # usuario del destino sobre el punto origen
    with pytest.raises(tl.TalonarioInvalido, match="no tiene ese talonario activo"):
        await anular(esc, punto=esc.destino, usuario=esc.usuario_destino, talonario_id=talonario["id"])
    assert await pg.fetchval("select count(*) from talonario_hojas_anuladas") == 0


async def test_la_base_impide_anular_dos_veces_la_misma_hoja(pg):
    esc = await escenario(pg)
    talonario = await configurar(pg, esc.origen, esc.usuario_origen)
    await anular(esc)
    with pytest.raises(asyncpg.UniqueViolationError):
        await pg.execute(
            "insert into talonario_hojas_anuladas (talonario_id, numero, motivo, anulado_por) values ($1::uuid, 6300, 'x', $2::uuid)",
            talonario["id"], esc.usuario_origen,
        )


# ---------------------------------------------------------------------------
# Configuracion y cambio de talonario
# ---------------------------------------------------------------------------


async def test_cambiar_de_talonario_con_hojas_sin_usar_exige_motivo_y_cierra_el_anterior(pg):
    esc = await escenario(pg)
    viejo = await configurar(pg, esc.origen, esc.usuario_origen, inicial=6300)
    await crear_traslado(traslado(esc, "A 6300"))
    with pytest.raises(tl.TalonarioInvalido, match="motivo"):
        await configurar(pg, esc.origen, esc.usuario_origen, inicial=6400)
    assert (await pg.fetchval("select estado from talonarios_punto where id = $1::uuid", viejo["id"])) == "activo"

    nuevo = await configurar(pg, esc.origen, esc.usuario_origen, inicial=6400, motivo="se extravio")
    fila = await pg.fetchrow("select estado, motivo_cierre, cerrado_at from talonarios_punto where id = $1::uuid", viejo["id"])
    assert (fila["estado"], fila["motivo_cierre"]) == ("cerrado", "se extravio") and fila["cerrado_at"] is not None
    assert nuevo["siguiente_hoja"] == "A 6400"
    # El anterior ya no ofrece sus hojas.
    with pytest.raises(tl.TalonarioConflicto, match="A 6400"):
        await crear_traslado(traslado(esc, "A 6301"))
    assert await pg.fetchval("select count(*) from talonarios_punto where estado = 'activo'") == 1
    detalle = await pg.fetchval("select detalle from logs where evento = 'talonario_configurado' order by \"timestamp\" desc limit 1")
    assert detalle["desde"]["quedaban"] == 49 and detalle["motivo"] == "se extravio"


async def test_cambiar_un_talonario_agotado_no_pide_motivo(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen, inicial=6300)
    for n in range(6300, 6350):
        await crear_traslado(traslado(esc, f"A {n}", items=[{"producto": "sal", "cantidad": 1}]))
    nuevo = await configurar(pg, esc.origen, esc.usuario_origen, inicial=6350)
    assert nuevo["siguiente_hoja"] == "A 6350"
    assert await pg.fetchval("select motivo_cierre from talonarios_punto where estado = 'cerrado'") == "Talonario agotado"


async def test_solo_el_primer_talonario_de_la_letra_puede_registrarse_ya_en_uso(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen, inicial=6300, numero_siguiente=6310)
    with pytest.raises(tl.TalonarioInvalido, match="Solo el primer talonario"):
        await configurar(pg, esc.origen, esc.usuario_origen, inicial=6400, numero_siguiente=6410, motivo="cambio")
    # Una letra nueva en el mismo punto si puede entrar ya en uso.
    await configurar(pg, esc.origen, esc.usuario_origen, "V", 100, numero_siguiente=110)


async def test_configurar_con_usuario_de_otro_punto_o_inactivo_se_rechaza(pg):
    esc = await escenario(pg)
    with pytest.raises(tl.TalonarioInvalido, match="pertenecer a este punto"):
        await configurar(pg, esc.origen, esc.usuario_destino)
    inactivo = await pg.fetchval("insert into usuarios_punto (nombre, punto_id, estado) values ('X', $1::uuid, 'inactivo') returning id", esc.origen)
    with pytest.raises(tl.TalonarioInvalido, match="pertenecer a este punto"):
        await configurar(pg, esc.origen, str(inactivo))
    assert await pg.fetchval("select count(*) from talonarios_punto") == 0


async def test_la_base_impide_dos_talonarios_activos_de_la_misma_letra(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    with pytest.raises(asyncpg.UniqueViolationError) as exc:
        await pg.execute(
            "insert into talonarios_punto (punto_id, letra, numero_inicial, numero_final, creado_por) values ($1::uuid, 'A', 7000, 7049, $2::uuid)",
            esc.origen, esc.usuario_origen,
        )
    assert exc.value.constraint_name == "talonarios_punto_activo_letra_key"


async def test_resumen_lista_todos_los_puntos_con_o_sin_talonario(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    resumen = {r["punto_nombre"]: r for r in await tl.resumen_talonarios_puntos()}
    assert [t["siguiente_hoja"] for t in resumen["CFC — La Cumbre"]["talonarios"]] == ["A 6300"]
    assert resumen["BDG — Bodega Central"]["talonarios"] == []


# ---------------------------------------------------------------------------
# Concurrencia
# ---------------------------------------------------------------------------


async def test_dos_tomas_simultaneas_de_la_misma_hoja_dejan_exactamente_una(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    resultados = await asyncio.gather(
        crear_traslado(traslado(esc, "A 6300")), crear_traslado(traslado(esc, "A 6300")), return_exceptions=True
    )
    exitos = [r for r in resultados if not isinstance(r, BaseException)]
    fallos = [r for r in resultados if isinstance(r, BaseException)]
    assert len(exitos) == 1
    assert len(fallos) == 1 and isinstance(fallos[0], tl.TalonarioConflicto)
    assert "A 6301" in str(fallos[0])  # le dice a la persona cual hoja toca ahora
    assert await hojas_usadas(pg, esc.origen) == ["A 6300"]
    assert (await eventos_en_logs(pg)).count("traslado_punto_creado") == 1
    assert await pg.fetchval("select count(*) from traslado_punto_items") == 2  # solo los items del ganador


@pytest.mark.parametrize("repeticion", range(3))
async def test_siete_tomas_simultaneas_de_la_misma_hoja_dejan_exactamente_una(pg, repeticion):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    resultados = await asyncio.gather(*(crear_traslado(traslado(esc, "A 6300")) for _ in range(7)), return_exceptions=True)
    errores = [r for r in resultados if isinstance(r, BaseException)]
    assert len(resultados) - len(errores) == 1
    assert all(isinstance(e, tl.TalonarioConflicto) for e in errores)  # nunca un 500 crudo de la base
    assert await hojas_usadas(pg, esc.origen) == ["A 6300"]


async def test_tomas_simultaneas_de_hojas_distintas_nunca_se_saltan_ninguna(pg):
    """6300 y 6301 a la vez: el lock las ordena. Puede ganar solo 6300, o ambas
    (si 6300 entra primero), pero jamas solo 6301."""
    for ronda in range(4):
        esc = await escenario(pg, f"-{ronda}")
        await configurar(pg, esc.origen, esc.usuario_origen)
        resultados = await asyncio.gather(
            crear_traslado(traslado(esc, "A 6301")), crear_traslado(traslado(esc, "A 6300")), return_exceptions=True
        )
        assert all(not isinstance(r, BaseException) or isinstance(r, tl.TalonarioConflicto) for r in resultados)
        usadas = await hojas_usadas(pg, esc.origen)
        assert usadas in (["A 6300"], ["A 6300", "A 6301"])


async def test_traslado_y_llegada_directa_simultaneos_comparten_el_mismo_talonario_del_punto(pg):
    """Un punto despacha (usa su talonario) y a la vez registra una llegada directa
    (usa el mismo talonario): la misma hoja solo se la lleva uno."""
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    llegada_en_origen = llegada(esc, "A 6300", punto_id=esc.origen, creado_por=esc.usuario_origen)
    resultados = await asyncio.gather(
        crear_traslado(traslado(esc, "A 6300")), crear_llegada_directa(llegada_en_origen), return_exceptions=True
    )
    errores = [r for r in resultados if isinstance(r, BaseException)]
    assert len(errores) == 1 and isinstance(errores[0], tl.TalonarioConflicto)
    assert await hojas_usadas(pg, esc.origen) == ["A 6300"]


async def test_tomar_y_anular_a_la_vez_nunca_gastan_la_misma_hoja_dos_veces(pg):
    for ronda in range(3):
        esc = await escenario(pg, f"-{ronda}")
        await configurar(pg, esc.origen, esc.usuario_origen)
        resultados = await asyncio.gather(crear_traslado(traslado(esc, "A 6300")), anular(esc), return_exceptions=True)
        usadas = await hojas_usadas(pg, esc.origen)
        anuladas = [
            f["numero"]
            for f in await pg.fetch(
                "select a.numero from talonario_hojas_anuladas a join talonarios_punto t on t.id = a.talonario_id where t.punto_id = $1::uuid",
                esc.origen,
            )
        ]
        # Orden 1: toma 6300 y la anulacion cae sobre 6301. Orden 2: anula 6300 y la toma de 6300 conflictua.
        assert (usadas, anuladas) in ((["A 6300"], [6301]), ([], [6300]))
        if usadas == []:
            assert isinstance(resultados[0], tl.TalonarioConflicto)
        assert not any(isinstance(r, BaseException) and not isinstance(r, tl.TalonarioConflicto) for r in resultados)


async def test_dos_anulaciones_simultaneas_anulan_hojas_distintas(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen)
    resultados = await asyncio.gather(anular(esc), anular(esc), return_exceptions=True)
    assert all(not isinstance(r, BaseException) for r in resultados)
    assert sorted(r["hoja_anulada"] for r in resultados) == ["A 6300", "A 6301"]


async def test_dos_configuraciones_simultaneas_de_la_misma_letra_dejan_un_solo_talonario_activo(pg):
    esc = await escenario(pg)
    resultados = await asyncio.gather(
        configurar(pg, esc.origen, esc.usuario_origen, inicial=6300),
        configurar(pg, esc.origen, esc.usuario_origen, inicial=7000),
        return_exceptions=True,
    )
    errores = [r for r in resultados if isinstance(r, BaseException)]
    # La perdedora cae al indice unico (conflicto) o, si llega despues del commit
    # de la ganadora, ve un talonario activo con hojas y pide motivo (invalido).
    assert len(errores) == 1 and isinstance(errores[0], (tl.TalonarioConflicto, tl.TalonarioInvalido))
    assert await pg.fetchval("select count(*) from talonarios_punto where estado = 'activo'") == 1
    assert (await eventos_en_logs(pg)).count("talonario_configurado") == 1


async def test_dos_cambios_simultaneos_con_motivo_dejan_un_solo_talonario_activo(pg):
    esc = await escenario(pg)
    await configurar(pg, esc.origen, esc.usuario_origen, inicial=6300)
    resultados = await asyncio.gather(
        configurar(pg, esc.origen, esc.usuario_origen, inicial=7000, motivo="cambio uno"),
        configurar(pg, esc.origen, esc.usuario_origen, inicial=8000, motivo="cambio dos"),
        return_exceptions=True,
    )
    assert not any(isinstance(r, BaseException) and not isinstance(r, tl.TalonarioConflicto) for r in resultados)
    assert sum(not isinstance(r, BaseException) for r in resultados) >= 1
    assert await pg.fetchval("select count(*) from talonarios_punto where estado = 'activo'") == 1
    assert await pg.fetchval("select count(*) from talonarios_punto where estado = 'cerrado'") == (
        await pg.fetchval("select count(*) from talonarios_punto") - 1
    )
