"""Constructores de filas y tokens compartidos por los tests unitarios."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.services.auth_pin import generar_sal, hashear_password
from app.services.sesion_dashboard import crear_token, obtener_secreto

UTC = timezone.utc
AHORA = datetime(2026, 1, 15, 12, 0, tzinfo=UTC)


def fila_item(
    id: str = "item-1",
    descripcion: str = "PRODUCTO",
    pendiente: int = 0,
    entregada: int = 0,
    **extra,
) -> dict:
    """Fila tal como la devuelve el select de _items_de_entrega."""
    fila = {
        "id": id,
        "descripcion": descripcion,
        "cantidad_entregada": entregada,
        "cantidad_pendiente": pendiente,
        "cantidad_no_entregada": 0,
        "nota": None,
        "confirmado": False,
        "entregado_en_punto_venta": False,
        "entregado_en_otra_bodega": False,
        "entregado_por_nombre": None,
    }
    fila.update(extra)
    return fila


def fila_usuario_dashboard(
    password: str = "clave-segura-1",
    *,
    rol: str = "admin",
    area: str = "todo",
    activo: bool = True,
    bloqueado: bool = False,
    segundos_bloqueo: float | None = None,
    usuario: str = "ana",
) -> dict:
    sal = generar_sal()
    return {
        "id": str(uuid4()),
        "usuario": usuario,
        "nombre": "Ana Prueba",
        "rol": rol,
        "area": area,
        "pass_salt": sal,
        "pass_hash": hashear_password(password, sal),
        "activo": activo,
        "bloqueado": bloqueado,
        "segundos_bloqueo": segundos_bloqueo,
        "creado_at": AHORA,
        "ultimo_login_at": None,
        "bloqueado_hasta": None,
    }


def encabezado_bearer(fila_usuario: dict) -> dict[str, str]:
    token, _ = crear_token(fila_usuario["id"], obtener_secreto())
    return {"Authorization": f"Bearer {token}"}


def payload_entrega(**extra) -> dict:
    cuerpo = {
        "evidencia_url": "https://storage.prueba/evidencia/foto.webp",
        "hash_evidencia": "hash-prueba-1",
        "sede_origen_id": "sede-1",
        "operador_id": "operador-1",
        "capturado_at": "2026-01-15T12:00:00Z",
    }
    cuerpo.update(extra)
    return cuerpo
