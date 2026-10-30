"""Constructores de filas para las pruebas de integracion de administracion,
borrado y scripts (Postgres real). Insertan filas minimas con SQL directo."""

from __future__ import annotations

from uuid import uuid4

from tests.helpers import fila_usuario_dashboard
from tests.integration.conftest import crear_entrega


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
