"""Cliente minimo de Supabase Storage para el bucket publico `evidencia`,
usado por el backend con la secret key (la app movil sube por su cuenta con la
publishable key; ver scripts/setup_storage.py).

Las subidas nunca usan upsert: si la ruta ya existe, Storage la rechaza y aqui
se traduce a ObjetoYaExiste.
"""

import httpx

from app.config import get_settings

BUCKET = "evidencia"
_TIMEOUT_SEGUNDOS = 30


class StorageNoDisponible(Exception):
    """Storage no esta configurado o respondio con error -- se traduce a 502."""


class ObjetoYaExiste(Exception):
    """Ya hay un objeto en esa ruta (la subida es sin upsert)."""


def _credenciales() -> tuple[str, str]:
    settings = get_settings()
    return settings.supabase_url.rstrip("/"), settings.supabase_secret_key


def _cliente() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_TIMEOUT_SEGUNDOS)


def _headers(clave: str) -> dict[str, str]:
    return {"apikey": clave, "Authorization": f"Bearer {clave}"}


def url_publica(ruta: str) -> str:
    base, _ = _credenciales()
    return f"{base}/storage/v1/object/public/{BUCKET}/{ruta}"


def _es_duplicado(resp: httpx.Response) -> bool:
    if resp.status_code == 409:
        return True
    # Storage suele contestar 400 con {"statusCode": "409", "error": "Duplicate"}.
    return resp.status_code == 400 and "duplicate" in resp.text.lower()


async def subir(ruta: str, contenido: bytes, content_type: str) -> None:
    base, clave = _credenciales()
    if not base or not clave:
        raise StorageNoDisponible("Storage no está configurado")
    try:
        async with _cliente() as cliente:
            resp = await cliente.post(
                f"{base}/storage/v1/object/{BUCKET}/{ruta}",
                headers={**_headers(clave), "Content-Type": content_type, "x-upsert": "false"},
                content=contenido,
            )
    except httpx.HTTPError as exc:
        raise StorageNoDisponible("No se pudo contactar a Storage") from exc
    if _es_duplicado(resp):
        raise ObjetoYaExiste(ruta)
    if resp.status_code >= 400:
        raise StorageNoDisponible(f"Storage respondió {resp.status_code}")


async def borrar(ruta: str) -> None:
    """Best-effort: nunca lanza, solo limpia un objeto recien subido."""
    base, clave = _credenciales()
    if not base or not clave:
        return
    try:
        async with _cliente() as cliente:
            await cliente.delete(f"{base}/storage/v1/object/{BUCKET}/{ruta}", headers=_headers(clave))
    except httpx.HTTPError:
        pass
