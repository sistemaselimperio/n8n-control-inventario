"""Vacia las entregas/logs de prueba y las fotos del bucket de evidencia,
dejando el sistema como recien instalado (no toca sedes/empleados/turnos).
Util durante pruebas, para no ir arrastrando datos de prueba a produccion.

Uso:
    python -m scripts.limpiar_datos          # pide confirmacion
    python -m scripts.limpiar_datos --si      # sin confirmacion (CI/automatizacion)
"""

import asyncio
import sys

import asyncpg
import httpx

from app.config import get_settings

BUCKET = "evidencia"


async def vaciar_tablas(database_url: str) -> None:
    conn = await asyncpg.connect(database_url)
    try:
        antes = await conn.fetchrow(
            "select (select count(*) from entregas) as entregas, (select count(*) from logs) as logs"
        )
        # NO se usa `truncate table entregas`: Postgres lo rechaza porque
        # entrega_items, devoluciones e items_no_entregados la referencian por
        # FK (y facturas_faltantes tambien). `delete from entregas` respeta
        # esas reglas (borra los hijos en cascada y deja la factura faltante
        # con entrega_id en null); logs no tiene FK, se vacia entera. Todo en
        # una transaccion: o se limpia todo o no se toca nada.
        async with conn.transaction():
            await conn.execute("delete from entregas")
            await conn.execute("truncate table logs")
        print(f"[db] borradas {antes['entregas']} entregas y {antes['logs']} logs")
    finally:
        await conn.close()


async def vaciar_storage(supabase_url: str, secret_key: str) -> None:
    headers = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{supabase_url}/storage/v1/object/list/{BUCKET}",
            headers=headers,
            json={"prefix": "", "limit": 1000},
        )
        resp.raise_for_status()
        carpetas = [item["name"] for item in resp.json() if item.get("id") is None]

        paths: list[str] = []
        for carpeta in carpetas:
            r = await client.post(
                f"{supabase_url}/storage/v1/object/list/{BUCKET}",
                headers=headers,
                json={"prefix": carpeta, "limit": 1000},
            )
            r.raise_for_status()
            paths += [f"{carpeta}/{item['name']}" for item in r.json() if item.get("id") is not None]

        if not paths:
            print("[storage] no habia fotos para borrar")
            return

        d = await client.request(
            "DELETE", f"{supabase_url}/storage/v1/object/{BUCKET}", headers=headers, json={"prefixes": paths}
        )
        d.raise_for_status()
        print(f"[storage] borradas {len(paths)} fotos del bucket '{BUCKET}'")


async def main() -> None:
    settings = get_settings()

    if "--si" not in sys.argv:
        respuesta = input(
            "Esto borra TODAS las entregas, logs y fotos de evidencia. Escribe 'si' para continuar: "
        )
        if respuesta.strip().lower() != "si":
            print("Cancelado.")
            return

    await vaciar_tablas(settings.database_url)
    if settings.supabase_url and settings.supabase_secret_key:
        await vaciar_storage(settings.supabase_url, settings.supabase_secret_key)
    print("Listo — base y storage vacios.")


if __name__ == "__main__":
    asyncio.run(main())
