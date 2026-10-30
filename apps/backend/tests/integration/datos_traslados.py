"""Datos de partida para las pruebas de integracion de traslados y talonarios
(Postgres real). Se insertan filas minimas y el talonario se configura con el
servicio verdadero, para probar el mismo camino que usa la app."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from app.models.talonario import TalonarioConfigurar
from app.models.traslado_punto import LlegadaDirectaCrear, RecepcionTraslado, TrasladoPuntoCrear
from app.services.talonarios import configurar_talonario


@dataclass
class Escenario:
    """Dos puntos con un usuario cada uno y un supervisor activo."""

    origen: str
    destino: str
    usuario_origen: str
    usuario_destino: str
    supervisor: str


async def crear_punto(pool, nombre: str, codigo: str) -> str:
    return str(await pool.fetchval("insert into puntos (nombre, codigo) values ($1, $2) returning id", nombre, codigo))


async def crear_usuario_punto(pool, punto_id: str, nombre: str = "Operario", estado: str = "activo") -> str:
    return str(
        await pool.fetchval(
            "insert into usuarios_punto (nombre, punto_id, estado) values ($1, $2::uuid, $3) returning id",
            nombre, punto_id, estado,
        )
    )


async def crear_supervisor(pool, nombre: str = "Erika", estado: str = "activo") -> str:
    return str(await pool.fetchval("insert into supervisores (nombre, estado) values ($1, $2) returning id", nombre, estado))


async def escenario(pool, sufijo: str = "") -> Escenario:
    """`sufijo` permite crear varios escenarios en un mismo test (nombre y codigo de punto son unicos)."""
    origen = await crear_punto(pool, f"CFC — La Cumbre{sufijo}", f"CFC{sufijo}")
    destino = await crear_punto(pool, f"BDG — Bodega Central{sufijo}", f"BDG{sufijo}")
    return Escenario(
        origen=origen,
        destino=destino,
        usuario_origen=await crear_usuario_punto(pool, origen, "Despachador"),
        usuario_destino=await crear_usuario_punto(pool, destino, "Receptor"),
        supervisor=await crear_supervisor(pool),
    )


async def configurar(pool, punto_id: str, usuario_id: str, letra: str = "A", inicial: int = 6300, **extra) -> dict:
    return await configurar_talonario(
        TalonarioConfigurar(punto_id=punto_id, usuario_id=usuario_id, letra=letra, numero_inicial=inicial, **extra)
    )


def traslado(esc: Escenario, hoja: str, **extra) -> TrasladoPuntoCrear:
    cuerpo = {
        "id": str(uuid4()),
        "punto_origen_id": esc.origen,
        "punto_destino_id": esc.destino,
        "transportador_nombre": "Pedro Perez",
        "fecha": "2026-03-05",
        "items": [
            {"producto": "sal blanca", "cantidad": 10},
            {"producto": "azucar", "cantidad": 5},
        ],
        "firma_despacha_url": "https://storage.prueba/despacha.webp",
        "firma_transporta_url": "https://storage.prueba/transporta.webp",
        "creado_por": esc.usuario_origen,
        "numero_talonario": hoja,
        "foto_talonario_url": "https://storage.prueba/talonario.webp",
    }
    cuerpo.update(extra)
    return TrasladoPuntoCrear(**cuerpo)


def llegada(esc: Escenario, hoja: str, **extra) -> LlegadaDirectaCrear:
    cuerpo = {
        "id": str(uuid4()),
        "punto_id": esc.destino,
        "creado_por": esc.usuario_destino,
        "numero_talonario": hoja,
        "foto_talonario_url": "https://storage.prueba/talonario.webp",
        "items": [{"producto": "arroz", "cantidad": 8}],
        "firma_recibe_url": "https://storage.prueba/recibe.webp",
        "declaracion_aceptada": True,
    }
    cuerpo.update(extra)
    return LlegadaDirectaCrear(**cuerpo)


def recepcion(esc: Escenario, items: list[tuple[str, int]], **extra) -> RecepcionTraslado:
    cuerpo = {
        "items": [{"id": item_id, "cantidad_recibida": cantidad} for item_id, cantidad in items],
        "firma_recibe_url": "https://storage.prueba/recibe.webp",
        "recibido_por": esc.usuario_destino,
        "declaracion_aceptada": True,
    }
    cuerpo.update(extra)
    return RecepcionTraslado(**cuerpo)


async def hojas_usadas(pool, punto_id: str, letra: str = "A") -> list[str]:
    """Referencias de hoja consumidas por traslados (como origen) o llegadas (como destino)."""
    filas = await pool.fetch(
        """
        select t.numero_talonario from traslados_puntos t
        join talonarios_punto tp on tp.id = t.talonario_id
        where tp.punto_id = $1::uuid and tp.letra = $2
        order by t.numero_talonario
        """,
        punto_id, letra,
    )
    return [f["numero_talonario"] for f in filas]


async def fila_traslado(pool, traslado_id: str):
    return await pool.fetchrow("select * from traslados_puntos where id = $1::uuid", traslado_id)
