"""Borrado administrativo contra Postgres real.

Lo que no puede comprobar la prueba unitaria: que cada subconsulta de historial
compile contra el esquema verdadero, que detecte de verdad su rastro (FK y
referencias blandas por texto) y que el delete respete el resto de la base.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.services import borrado_admin as borrado
from app.services.borrado_admin import ReglaBorrado, TieneHistorial
from app.services.permisos_dashboard import actor_actual
from app.services.usuarios import RegistroNoEncontrado
from tests.helpers import encabezado_bearer, fila_usuario_dashboard
from tests.integration.conftest import crear_entrega
from tests.integration.datos_traslados import crear_punto, crear_supervisor, crear_usuario_punto

pytestmark = pytest.mark.integration


# --------------------------------------------------------------------------
# Constructores de datos
# --------------------------------------------------------------------------


async def nueva_sede(pg, codigo: str | None = None) -> str:
    codigo = codigo or f"S-{uuid4().hex[:6]}"
    return str(await pg.fetchval("insert into sedes (nombre, codigo) values ($1, $1) returning id", codigo))


async def nuevo_empleado(pg, sede: str = "sede-x") -> str:
    return str(await pg.fetchval("insert into empleados (nombre, sede_id) values ('Luis', $1) returning id", sede))


async def nuevo_usuario_dashboard(pg, usuario: str = "luis", rol: str = "supervisor", activo: bool = True) -> str:
    fila = fila_usuario_dashboard(usuario=usuario, rol=rol, activo=activo)
    return str(
        await pg.fetchval(
            """
            insert into usuarios_dashboard (usuario, nombre, rol, pass_hash, pass_salt, activo)
            values ($1, 'Nombre', $2, $3, $4, $5) returning id
            """,
            usuario, rol, fila["pass_hash"], fila["pass_salt"], activo,
        )
    )


async def insertar_log(pg, **campos) -> None:
    valores = {
        "evento": "extraccion_ia", "entidad_tipo": "entrega", "entidad_id": "x",
        "actor_id": "nadie", "sede_id": "-", "resultado": "ok",
    }
    valores.update(campos)
    await pg.execute(
        "insert into logs (evento, entidad_tipo, entidad_id, actor_id, sede_id, resultado) values ($1,$2,$3,$4,$5,$6)",
        *valores.values(),
    )


async def entrega_con_item(pg, **campos_entrega) -> tuple[str, str]:
    entrega_id, (item_id,) = await crear_entrega(pg, numero=uuid4().hex[:8], pendientes=(5,))
    for col, valor in campos_entrega.items():
        await pg.execute(f"update entregas set {col} = $1 where id = $2::uuid", valor, entrega_id)
    return entrega_id, item_id


async def insertar_devolucion(pg, **campos) -> None:
    entrega_id, item_id = await entrega_con_item(pg)
    valores = {"operador_id": "op", "sede_id": "sede-x"}
    valores.update(campos)
    await pg.execute(
        """
        insert into devoluciones (entrega_id, item_id, cantidad, motivo, resolucion, operador_id, sede_id)
        values ($1::uuid, $2::uuid, 1, 'danado', 'reposicion', $3, $4)
        """,
        entrega_id, item_id, valores["operador_id"], valores["sede_id"],
    )


async def insertar_no_entregado(pg, **campos) -> None:
    entrega_id, item_id = await entrega_con_item(pg)
    valores = {"operador_id": "op", "sede_id": "sede-x"}
    valores.update(campos)
    await pg.execute(
        """
        insert into items_no_entregados (entrega_id, item_id, cantidad, motivo, operador_id, sede_id)
        values ($1::uuid, $2::uuid, 1, 'otro', $3, $4)
        """,
        entrega_id, item_id, valores["operador_id"], valores["sede_id"],
    )


async def insertar_factura_faltante(pg, **campos) -> None:
    valores = {
        "tipo": "FEI", "indicativo_numero": uuid4().hex[:6], "sede_id": "sede-x",
        "reportado_por": "op", "sede_reporta_id": None, "cerrada_por": None,
    }
    valores.update(campos)
    await pg.execute(
        """
        insert into facturas_faltantes (tipo, indicativo_numero, sede_id, reportado_por, sede_reporta_id, cerrada_por)
        values ($1, $2, $3, $4, $5, $6)
        """,
        *valores.values(),
    )


async def insertar_traslado(pg, origen: str, destino: str, creado_por: str, **campos) -> str:
    traslado_id = str(uuid4())
    await pg.execute(
        """
        insert into traslados_puntos (id, punto_origen_id, punto_destino_id, fecha, creado_por)
        values ($1::uuid, $2::uuid, $3::uuid, '2026-03-05', $4::uuid)
        """,
        traslado_id, origen, destino, creado_por,
    )
    for col, valor in campos.items():
        await pg.execute(f"update traslados_puntos set {col} = $1 where id = $2::uuid", valor, traslado_id)
    return traslado_id


async def nuevo_talonario(pg, punto: str, usuario: str) -> str:
    return str(
        await pg.fetchval(
            """
            insert into talonarios_punto (punto_id, letra, numero_inicial, numero_final, creado_por)
            values ($1::uuid, 'A', 100, 149, $2::uuid) returning id
            """,
            punto, usuario,
        )
    )


async def existe(pg, tabla: str, clave: str, valor: str) -> bool:
    return bool(await pg.fetchval(f"select exists (select 1 from {tabla} where {clave} = $1)", valor))


async def total_logs(pg) -> int:
    return await pg.fetchval("select count(*) from logs")


# --------------------------------------------------------------------------
# Por cada chequeo de cada entidad: el rastro correspondiente bloquea el borrado
# --------------------------------------------------------------------------
# Cada caso crea la entidad, le deja UN rastro y espera que se rechace citando
# justamente esa descripcion. Ejecutarlos todos tambien valida que cada
# subconsulta compile contra el esquema real.


async def _punto_y_usuario(pg) -> tuple[str, str, str]:
    punto = await crear_punto(pg, f"P-{uuid4().hex[:6]}", f"C{uuid4().hex[:5]}")
    otro = await crear_punto(pg, f"P-{uuid4().hex[:6]}", f"C{uuid4().hex[:5]}")
    usuario = await crear_usuario_punto(pg, otro)
    return punto, otro, usuario


async def _sede(pg):
    sede = await nueva_sede(pg)
    return sede, borrado.eliminar_sede, "sedes", "id"


async def _empleado(pg):
    emp = await nuevo_empleado(pg)
    return emp, borrado.eliminar_empleado, "empleados", "id"


async def _punto(pg):
    punto = await crear_punto(pg, f"P-{uuid4().hex[:6]}", f"C{uuid4().hex[:5]}")
    return punto, borrado.eliminar_punto, "puntos", "id"


async def _usuario_punto(pg):
    punto = await crear_punto(pg, f"P-{uuid4().hex[:6]}", f"C{uuid4().hex[:5]}")
    return await crear_usuario_punto(pg, punto), borrado.eliminar_usuario_punto, "usuarios_punto", "id"


async def _supervisor(pg):
    return await crear_supervisor(pg), borrado.eliminar_supervisor, "supervisores", "id"


async def _tipo(pg):
    # tipos_documento es tabla semilla: no se vacia entre tests, por eso el codigo es unico.
    codigo = f"Z{uuid4().hex[:6].upper()}"
    await pg.execute("insert into tipos_documento (codigo, descripcion) values ($1, 'prueba')", codigo)
    return codigo, borrado.eliminar_tipo_documento, "tipos_documento", "codigo"


async def _rastro_sede(pg, sede: str, descripcion: str) -> None:
    if descripcion == "entregas registradas":
        await entrega_con_item(pg, sede_origen_id=sede)
    elif descripcion == "empleados asignados":
        await nuevo_empleado(pg, sede)
    elif descripcion == "eventos en el historial":
        await insertar_log(pg, sede_id=sede)
    elif descripcion == "turnos programados":
        await pg.execute(
            "insert into turnos (empleado_id, sede_id, fecha, hora_inicio, hora_fin) values ('e', $1, '2026-03-05', '08:00', '12:00')",
            sede,
        )
    elif descripcion == "recomendaciones de turnos":
        await pg.execute("insert into shift_recommendations (sede_id, semana_iso) values ($1, '2026-W10')", sede)
    elif descripcion == "devoluciones registradas":
        await insertar_devolucion(pg, sede_id=sede)
    elif descripcion == "productos no entregados registrados":
        await insertar_no_entregado(pg, sede_id=sede)
    elif descripcion == "facturas faltantes reportadas":
        await insertar_factura_faltante(pg, sede_id=sede)
    else:  # pragma: no cover - una descripcion nueva exige un caso nuevo
        raise AssertionError(descripcion)


async def _rastro_empleado(pg, emp: str, descripcion: str) -> None:
    if descripcion == "entregas registradas":
        await entrega_con_item(pg, bodeguero_id=emp)
    elif descripcion == "productos entregados":
        _, item = await entrega_con_item(pg)
        await pg.execute("update entrega_items set entregado_por = $1 where id = $2::uuid", emp, item)
    elif descripcion == "devoluciones registradas":
        await insertar_devolucion(pg, operador_id=emp)
    elif descripcion == "productos no entregados registrados":
        await insertar_no_entregado(pg, operador_id=emp)
    elif descripcion == "facturas faltantes reportadas":
        await insertar_factura_faltante(pg, reportado_por=emp)
    elif descripcion == "turnos programados":
        await pg.execute(
            "insert into turnos (empleado_id, sede_id, fecha, hora_inicio, hora_fin) values ($1, 's', '2026-03-05', '08:00', '12:00')",
            emp,
        )
    elif descripcion == "eventos en el historial":
        await insertar_log(pg, actor_id=emp)
    else:  # pragma: no cover
        raise AssertionError(descripcion)


async def _rastro_punto(pg, punto: str, descripcion: str) -> None:
    otro = await crear_punto(pg, f"O-{uuid4().hex[:6]}", f"O{uuid4().hex[:5]}")
    usuario = await crear_usuario_punto(pg, otro)
    if descripcion == "traslados registrados":
        await insertar_traslado(pg, punto, otro, usuario)
    elif descripcion == "talonarios":
        await nuevo_talonario(pg, punto, usuario)
    elif descripcion == "eventos en el historial":
        await insertar_log(pg, sede_id=punto)
    elif descripcion == "usuarios asignados":
        await crear_usuario_punto(pg, punto)
    else:  # pragma: no cover
        raise AssertionError(descripcion)


async def _rastro_usuario_punto(pg, usuario: str, descripcion: str) -> None:
    punto, otro, _ = await _punto_y_usuario(pg)
    if descripcion == "traslados registrados":
        await insertar_traslado(pg, punto, otro, usuario)
    elif descripcion == "talonarios configurados":
        await nuevo_talonario(pg, punto, usuario)
    elif descripcion == "hojas de talonario anuladas":
        otro_usuario = await crear_usuario_punto(pg, punto)
        talonario = await nuevo_talonario(pg, punto, otro_usuario)
        await pg.execute(
            "insert into talonario_hojas_anuladas (talonario_id, numero, motivo, anulado_por) values ($1::uuid, 100, 'danada', $2::uuid)",
            talonario, usuario,
        )
    elif descripcion == "eventos en el historial":
        await insertar_log(pg, actor_id=usuario)
    else:  # pragma: no cover
        raise AssertionError(descripcion)


async def _rastro_supervisor(pg, supervisor: str, descripcion: str) -> None:
    punto, otro, usuario = await _punto_y_usuario(pg)
    if descripcion == "novedades resueltas":
        await insertar_traslado(pg, punto, otro, usuario, solucionado_por=supervisor)
    elif descripcion == "numeros Syscafe asignados":
        # Se guarda el NOMBRE de quien asigno el numero, no su id.
        nombre = await pg.fetchval("select nombre from supervisores where id = $1::uuid", supervisor)
        await insertar_traslado(pg, punto, otro, usuario, numero_syscafe="SYS-1", numero_syscafe_por=nombre)
    elif descripcion == "eventos en el historial":
        await insertar_log(pg, actor_id=supervisor)
    else:  # pragma: no cover
        raise AssertionError(descripcion)


async def _rastro_tipo(pg, codigo: str, descripcion: str) -> None:
    if descripcion == "entregas registradas":
        await entrega_con_item(pg, tipo=codigo.lower())  # distinta capitalizacion a proposito
    elif descripcion == "traslados de entregas registrados":
        await entrega_con_item(pg, traslado_tipo=codigo.lower())
    elif descripcion == "facturas faltantes reportadas":
        await insertar_factura_faltante(pg, tipo=codigo.lower())
    else:  # pragma: no cover
        raise AssertionError(descripcion)


ENTIDADES = {
    "sede": (_sede, _rastro_sede, borrado._CHEQUEOS_SEDE),
    "empleado": (_empleado, _rastro_empleado, borrado._CHEQUEOS_EMPLEADO),
    "punto": (_punto, _rastro_punto, borrado._CHEQUEOS_PUNTO),
    "usuario_punto": (_usuario_punto, _rastro_usuario_punto, borrado._CHEQUEOS_USUARIO_PUNTO),
    "supervisor": (_supervisor, _rastro_supervisor, borrado._CHEQUEOS_SUPERVISOR),
    "tipo": (_tipo, _rastro_tipo, borrado._CHEQUEOS_TIPO),
}

CASOS_RASTRO = [
    pytest.param(nombre, descripcion, id=f"{nombre}-{descripcion}")
    for nombre, (_c, _r, chequeos) in ENTIDADES.items()
    for descripcion, _sql in chequeos
]


@pytest.mark.parametrize("entidad, descripcion", CASOS_RASTRO)
async def test_cada_rastro_bloquea_el_borrado_y_la_fila_sigue_ahi(pg, entidad, descripcion):
    crear, rastro, _ = ENTIDADES[entidad]
    id_, funcion, tabla, clave = await crear(pg)
    await rastro(pg, id_, descripcion)
    antes = await total_logs(pg)

    with pytest.raises(TieneHistorial) as info:
        await funcion(id_)

    assert descripcion in str(info.value)
    assert await existe(pg, tabla, clave, id_) if clave == "codigo" else await pg.fetchval(
        f"select exists (select 1 from {tabla} where id = $1::uuid)", id_
    )
    assert await total_logs(pg) == antes  # ni evento de borrado ni nada


@pytest.mark.parametrize("entidad", list(ENTIDADES))
async def test_sin_rastro_se_borra_solo_esa_fila_y_queda_un_evento(pg, entidad):
    crear, _, _ = ENTIDADES[entidad]
    id_, funcion, tabla, clave = await crear(pg)
    # Una "hermana" que no debe tocarse.
    await crear(pg)
    filas_antes = await pg.fetchval(f"select count(*) from {tabla}")
    actor_actual.set("dashboard:ana")

    await funcion(id_)

    cast = "" if clave == "codigo" else "::uuid"
    assert not await pg.fetchval(f"select exists (select 1 from {tabla} where {clave} = $1{cast})", id_)
    assert await pg.fetchval(f"select count(*) from {tabla}") == filas_antes - 1
    evento = await pg.fetchrow("select * from logs where evento = 'admin_cambio' and resultado = 'eliminado'")
    assert evento["entidad_id"] == id_ and evento["actor_id"] == "dashboard:ana"
    assert await total_logs(pg) == 1


@pytest.mark.parametrize("entidad", list(ENTIDADES))
async def test_borrar_algo_inexistente_da_no_encontrado_sin_tocar_la_bitacora(pg, entidad):
    _, funcion, _, clave = await ENTIDADES[entidad][0](pg)
    inexistente = "NOEXISTE" if clave == "codigo" else str(uuid4())
    with pytest.raises(RegistroNoEncontrado):
        await funcion(inexistente)
    assert await total_logs(pg) == 0


async def test_los_admin_cambio_propios_no_cuentan_como_historial(pg):
    """Una sede creada desde el panel (alta + edicion) se puede borrar despues."""
    sede = await nueva_sede(pg)
    for accion in ("creado", "actualizado"):
        await insertar_log(pg, evento="admin_cambio", entidad_tipo="sede", entidad_id=sede, actor_id="dashboard:ana", sede_id=sede, resultado=accion)
    await borrado.eliminar_sede(sede)
    # La bitacora conserva TODO lo anterior mas el nuevo evento: nada se borro.
    resultados = [f["resultado"] for f in await pg.fetch('select resultado from logs order by "timestamp", id')]
    assert sorted(resultados) == ["actualizado", "creado", "eliminado"]


async def test_un_evento_que_no_es_admin_cambio_en_la_sede_si_cuenta(pg):
    sede = await nueva_sede(pg)
    await insertar_log(pg, evento="extraccion_ia", sede_id=sede)
    with pytest.raises(TieneHistorial):
        await borrado.eliminar_sede(sede)


async def test_el_tipo_se_compara_sin_distinguir_mayusculas(pg):
    codigo = f"Q{uuid4().hex[:6].upper()}"
    await pg.execute("insert into tipos_documento (codigo) values ($1)", codigo)
    await entrega_con_item(pg, tipo=codigo.lower())
    with pytest.raises(TieneHistorial):
        await borrado.eliminar_tipo_documento(codigo)


async def test_un_tipo_semilla_sin_uso_se_puede_borrar_y_uno_usado_no(pg):
    await entrega_con_item(pg, tipo="FEI")
    with pytest.raises(TieneHistorial):
        await borrado.eliminar_tipo_documento("FEI")
    await borrado.eliminar_tipo_documento("RSF")
    assert not await existe(pg, "tipos_documento", "codigo", "RSF")
    assert await existe(pg, "tipos_documento", "codigo", "FEI")


async def test_borrar_no_toca_las_entregas_ni_sus_items_de_otras_sedes(pg):
    sede = await nueva_sede(pg)
    entrega_id, _ = await entrega_con_item(pg, sede_origen_id="otra-sede")
    await borrado.eliminar_sede(sede)
    assert await pg.fetchval("select count(*) from entregas where id = $1::uuid", entrega_id) == 1
    assert await pg.fetchval("select count(*) from entrega_items where entrega_id = $1::uuid", entrega_id) == 1


async def test_la_fk_atrapa_lo_que_el_chequeo_no_vio(pg, monkeypatch):
    """Red de seguridad: si el chequeo manual no ve el rastro, la FK real
    rechaza el delete y se traduce igual a TieneHistorial."""
    punto, otro, usuario = await _punto_y_usuario(pg)
    await insertar_traslado(pg, punto, otro, usuario)
    monkeypatch.setattr(borrado, "_CHEQUEOS_PUNTO", [("nada", "select 1 from puntos where false and $1 is not null")])
    with pytest.raises(TieneHistorial) as info:
        await borrado.eliminar_punto(punto)
    assert "registros asociados" in str(info.value)
    assert await pg.fetchval("select exists (select 1 from puntos where id = $1::uuid)", punto)
    assert await total_logs(pg) == 0


async def test_dos_borrados_simultaneos_del_mismo_registro_borran_una_vez(pg):
    import asyncio

    sede = await nueva_sede(pg)
    resultados = await asyncio.gather(
        borrado.eliminar_sede(sede), borrado.eliminar_sede(sede), return_exceptions=True
    )
    exitos = [r for r in resultados if r is None]
    fallos = [r for r in resultados if isinstance(r, RegistroNoEncontrado)]
    assert len(exitos) == 1 and len(fallos) == 1
    assert await pg.fetchval("select count(*) from logs where resultado = 'eliminado'") == 1


# --------------------------------------------------------------------------
# Usuarios del dashboard
# --------------------------------------------------------------------------


async def _actor(pg, usuario: str = "ana") -> dict:
    id_ = await nuevo_usuario_dashboard(pg, usuario, rol="admin")
    return {"id": id_, "usuario": usuario, "nombre": "Nombre", "rol": "admin", "area": "todo"}


@pytest.mark.parametrize(
    "descripcion",
    [descripcion for descripcion, _ in borrado._CHEQUEOS_USUARIO_DASHBOARD],
)
async def test_usuario_dashboard_con_rastro_no_se_borra(pg, descripcion):
    actor = await _actor(pg)
    objetivo = await nuevo_usuario_dashboard(pg, "luis")
    actor_texto = "dashboard:luis"
    if descripcion == "eventos en el historial":
        await insertar_log(pg, actor_id=actor_texto)
    elif descripcion == "intentos de ingreso registrados":
        await insertar_log(pg, evento="dashboard_login", entidad_tipo="usuario_dashboard", entidad_id=objetivo, actor_id="x", resultado="fallido")
    elif descripcion == "entregas registradas":
        await entrega_con_item(pg, operador_id=actor_texto)
    elif descripcion == "productos entregados":
        _, item = await entrega_con_item(pg)
        await pg.execute("update entrega_items set entregado_por = $1 where id = $2::uuid", actor_texto, item)
    elif descripcion == "devoluciones registradas":
        await insertar_devolucion(pg, operador_id=actor_texto)
    elif descripcion == "productos no entregados registrados":
        await insertar_no_entregado(pg, operador_id=actor_texto)
    elif descripcion == "numeros Syscafe asignados":
        punto, otro, usuario = await _punto_y_usuario(pg)
        await insertar_traslado(pg, punto, otro, usuario, numero_syscafe="SYS-9", numero_syscafe_por="Nombre")
    else:  # pragma: no cover
        raise AssertionError(descripcion)

    with pytest.raises(TieneHistorial) as info:
        await borrado.eliminar_usuario_dashboard(actor, objetivo)
    assert descripcion in str(info.value)
    assert await existe(pg, "usuarios_dashboard", "id::text", objetivo)


async def test_usuario_dashboard_sin_rastro_se_borra_y_los_admin_cambio_ajenos_no_estorban(pg):
    actor = await _actor(pg)
    objetivo = await nuevo_usuario_dashboard(pg, "luis")
    # Que el admin lo creara/editara deja admin_cambio con actor = admin, no con actor = luis.
    await insertar_log(pg, evento="admin_cambio", entidad_tipo="usuario_dashboard", entidad_id=objetivo, actor_id="dashboard:ana", resultado="creado")
    await borrado.eliminar_usuario_dashboard(actor, objetivo)
    assert not await existe(pg, "usuarios_dashboard", "id::text", objetivo)
    eliminado = await pg.fetchrow("select * from logs where resultado = 'eliminado'")
    assert eliminado["actor_id"] == "dashboard:ana"
    assert await total_logs(pg) == 2


async def test_un_admin_no_se_borra_a_si_mismo_aunque_haya_otros(pg):
    actor = await _actor(pg)
    await nuevo_usuario_dashboard(pg, "otro-admin", rol="admin")
    with pytest.raises(ReglaBorrado, match="a ti mismo"):
        await borrado.eliminar_usuario_dashboard(actor, actor["id"])
    assert await existe(pg, "usuarios_dashboard", "id::text", actor["id"])


async def test_no_se_borra_al_ultimo_admin_activo_pero_si_a_un_admin_inactivo(pg):
    actor = await _actor(pg)
    inactivo = await nuevo_usuario_dashboard(pg, "viejo-admin", rol="admin", activo=False)
    # Hay otro admin (el actor) activo: el inactivo se puede borrar.
    await borrado.eliminar_usuario_dashboard(actor, inactivo)

    # Otro actor distinto intenta borrar al unico admin activo restante.
    otro_actor = {"id": str(uuid4()), "usuario": "intruso", "nombre": "I", "rol": "admin", "area": "todo"}
    with pytest.raises(ReglaBorrado, match="al menos un administrador"):
        await borrado.eliminar_usuario_dashboard(otro_actor, actor["id"])
    assert await existe(pg, "usuarios_dashboard", "id::text", actor["id"])


# --------------------------------------------------------------------------
# HTTP de extremo a extremo con sesion admin real
# --------------------------------------------------------------------------


async def _headers_admin(pg) -> dict[str, str]:
    id_ = await nuevo_usuario_dashboard(pg, "root", rol="admin")
    return encabezado_bearer({"id": id_})


async def test_http_borrar_sede_sin_uso_y_con_uso(cliente, pg):
    headers = await _headers_admin(pg)
    libre = await nueva_sede(pg)
    usada = await nueva_sede(pg)
    await entrega_con_item(pg, sede_origen_id=usada)

    ok = await cliente.delete(f"/sedes/{libre}", headers=headers)
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    conflicto = await cliente.delete(f"/sedes/{usada}", headers=headers)
    assert conflicto.status_code == 409 and "entregas registradas" in conflicto.json()["detail"]
    faltante = await cliente.delete(f"/sedes/{uuid4()}", headers=headers)
    assert faltante.status_code == 404

    evento = await pg.fetchrow("select * from logs where resultado = 'eliminado'")
    assert evento["actor_id"] == "dashboard:root" and evento["entidad_id"] == libre
    assert await pg.fetchval("select count(*) from logs where resultado = 'eliminado'") == 1


async def test_http_borrar_con_token_legacy(cliente, pg, admin_headers):
    sede = await nueva_sede(pg)
    res = await cliente.delete(f"/sedes/{sede}", headers=admin_headers)
    assert res.status_code == 200
    assert await pg.fetchval("select actor_id from logs where resultado = 'eliminado'") == "dashboard:token"


@pytest.mark.parametrize("rol", ["supervisor", "consulta"])
async def test_http_un_no_admin_no_borra_nada(cliente, pg, rol):
    id_ = await nuevo_usuario_dashboard(pg, "noadmin", rol=rol)
    sede = await nueva_sede(pg)
    res = await cliente.delete(f"/sedes/{sede}", headers=encabezado_bearer({"id": id_}))
    assert res.status_code == 403
    assert await pg.fetchval("select exists (select 1 from sedes where id = $1::uuid)", sede)


async def test_http_vaciar_todo_deja_una_sola_fila_de_auditoria_y_respeta_catalogos(cliente, pg, admin_headers):
    sede = await nueva_sede(pg)
    await nuevo_empleado(pg, sede)
    await entrega_con_item(pg)
    await insertar_log(pg)
    res = await cliente.delete("/entregas/todas", headers=admin_headers)
    assert res.status_code == 200
    assert res.json() == {"entregas_borradas": 1, "logs_borrados": 1}
    assert await pg.fetchval("select count(*) from entregas") == 0
    assert await pg.fetchval("select count(*) from entrega_items") == 0
    # El evento de auditoria es lo UNICO que queda en logs.
    assert [f["evento"] for f in await pg.fetch("select evento from logs")] == ["limpieza_total"]
    # Catalogos intactos.
    assert await pg.fetchval("select count(*) from sedes") == 1
    assert await pg.fetchval("select count(*) from empleados") == 1


async def test_http_borrado_definitivo_de_una_entrega_conserva_logs_y_borra_items(cliente, pg, admin_headers):
    entrega_id, item_id = await entrega_con_item(pg)
    otra, _ = await entrega_con_item(pg)
    await insertar_log(pg, entidad_id=entrega_id)
    res = await cliente.delete(f"/entregas/{entrega_id}/definitivo", headers=admin_headers)
    assert res.status_code == 200
    assert await pg.fetchval("select count(*) from entrega_items where id = $1::uuid", item_id) == 0
    assert await pg.fetchval("select count(*) from entregas where id = $1::uuid", otra) == 1
    eventos = [f["evento"] for f in await pg.fetch('select evento from logs order by "timestamp", id')]
    assert eventos == ["extraccion_ia", "entrega_eliminada"]  # logs sobrevive y suma el evento


async def test_http_borrar_producto_deja_evento(cliente, pg, admin_headers):
    producto = str(await pg.fetchval("insert into productos (codigo, nombre) values ('12345', 'SAL') returning id"))
    res = await cliente.delete(f"/productos/{producto}", headers=admin_headers)
    assert res.status_code == 200
    assert await pg.fetchval("select count(*) from productos") == 0
    evento = await pg.fetchrow("select * from logs")
    assert (evento["entidad_tipo"], evento["resultado"]) == ("producto", "eliminado")
    assert evento["detalle"] == {"codigo": "12345", "nombre": "SAL"}


# --------------------------------------------------------------------------
# Regresion: dos admins que se borran entre si a la vez
# --------------------------------------------------------------------------


async def test_dos_admins_que_se_borran_entre_si_a_la_vez_no_dejan_el_sistema_sin_admin(pg, monkeypatch):
    """Antes cada borrado contaba los admins sin bloquearlos: con exactamente
    dos admins activos, ana borrando a beto y beto borrando a ana en paralelo
    veian "queda otro" los dos, y la tabla quedaba sin ningun administrador.

    Para que la carrera sea determinista se frena a cada borrado justo despues
    de evaluar las guardas hasta que el otro llegue ahi (con un tope de tiempo:
    si el codigo serializa los borrados, el segundo espera el bloqueo y el
    primero sigue cuando vence el tope)."""
    import asyncio

    ana = await _actor(pg, "ana")
    beto_id = await nuevo_usuario_dashboard(pg, "beto", rol="admin")
    beto = {"id": beto_id, "usuario": "beto", "nombre": "B", "rol": "admin", "area": "todo"}

    llegaron = 0
    ambos = asyncio.Event()
    motivos_original = borrado._motivos

    async def motivos_con_barrera(conn, chequeos, valor):
        nonlocal llegaron
        llegaron += 1
        if llegaron >= 2:
            ambos.set()
        try:
            await asyncio.wait_for(ambos.wait(), timeout=1.5)
        except asyncio.TimeoutError:
            pass
        return await motivos_original(conn, chequeos, valor)

    monkeypatch.setattr(borrado, "_motivos", motivos_con_barrera)

    resultados = await asyncio.gather(
        borrado.eliminar_usuario_dashboard(ana, beto_id),
        borrado.eliminar_usuario_dashboard(beto, ana["id"]),
        return_exceptions=True,
    )

    admins_activos = await pg.fetchval("select count(*) from usuarios_dashboard where rol = 'admin' and activo")
    assert admins_activos == 1, f"el sistema quedo con {admins_activos} admins; resultados: {resultados!r}"
    reglas = [r for r in resultados if isinstance(r, ReglaBorrado)]
    assert len(reglas) == 1
    assert "al menos un administrador" in str(reglas[0])
