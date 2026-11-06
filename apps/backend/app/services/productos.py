import re

import asyncpg

from app.db import get_pool
from app.services.usuarios import RegistroNoEncontrado, registrar_cambio

# Las descripciones de item vienen tal como las lee la IA de vision del
# documento (columna DETALLE) -- por convencion del negocio suelen arrancar
# con el codigo interno del producto seguido del nombre (ej.
# "75936  SAL BLANCA * 40 KILOS"), pero no hay ningun separador garantizado
# ni campo estructurado en el pipeline (ver vision.py). 3+ digitos evita
# confundir una cantidad suelta al inicio del texto ("2 CAJAS...") con un
# codigo real.
_PATRON_CODIGO_NOMBRE = re.compile(r"^(\d{3,})[\s\-:]+(.+)$")


def extraer_codigo_nombre(descripcion: str) -> tuple[str, str] | None:
    match = _PATRON_CODIGO_NOMBRE.match(descripcion.strip())
    if not match:
        return None
    codigo, nombre = match.groups()
    nombre = nombre.strip()
    if not nombre:
        return None
    return codigo, nombre


async def sincronizar_producto(conn: asyncpg.Connection, descripcion: str) -> None:
    """Completa el catalogo de productos a partir de una descripcion de item ya
    escrita en entrega_items -- se llama con la misma conexion/transaccion que
    ya esta insertando o corrigiendo esa fila (ver duplicates.py). No hace
    nada si la descripcion no trae un codigo reconocible. `on conflict do
    nothing` es lo que garantiza que el codigo no se repita: la primera
    descripcion que lo trajo gana, no se pisa despues.
    """
    resultado = extraer_codigo_nombre(descripcion)
    if resultado is None:
        return
    codigo, nombre = resultado
    await conn.execute(
        "insert into productos (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing",
        codigo,
        nombre,
    )


async def sincronizar_producto_con_codigo(conn: asyncpg.Connection, codigo: str, nombre: str) -> None:
    """Variante de `sincronizar_producto` para cuando el codigo ya viene
    separado del nombre (ej. el PDF de traslado desde bodega trae la referencia
    en su propia columna). Misma regla: la primera descripcion que trajo el
    codigo gana, no se pisa despues."""
    codigo, nombre = codigo.strip(), nombre.strip()
    if not codigo or not nombre:
        return
    await conn.execute(
        "insert into productos (codigo, nombre) values ($1, $2) on conflict (codigo) do nothing",
        codigo,
        nombre,
    )


async def eliminar_producto(producto_id: str) -> None:
    """Borra un producto del catalogo. No hay FKs hacia `productos` (entrega_items
    guarda la descripcion tal cual), asi que el historial no se afecta. OJO: el
    catalogo se autocompleta (`sincronizar_producto`), por lo que si una entrega
    futura trae el mismo codigo el producto se vuelve a crear solo. Deja el
    evento `admin_cambio` ("eliminado") con codigo y nombre; `logs` no se toca.
    """
    pool = await get_pool()
    fila = await pool.fetchrow("delete from productos where id = $1::uuid returning codigo, nombre", producto_id)
    if fila is None:
        raise RegistroNoEncontrado()
    await registrar_cambio("productos", producto_id, "eliminado", {"codigo": fila["codigo"], "nombre": fila["nombre"]})
