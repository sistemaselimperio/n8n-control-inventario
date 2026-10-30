"""Constructores de filas y payloads del flujo de traslados y talonarios,
compartidos por los tests unitarios y de integracion."""

from __future__ import annotations

from uuid import uuid4

PUNTO_ORIGEN = "11111111-1111-1111-1111-111111111111"
PUNTO_DESTINO = "22222222-2222-2222-2222-222222222222"
USUARIO_ORIGEN = "33333333-3333-3333-3333-333333333333"
USUARIO_DESTINO = "44444444-4444-4444-4444-444444444444"
SUPERVISOR = "55555555-5555-5555-5555-555555555555"
TALONARIO_ID = "66666666-6666-6666-6666-666666666666"


def nuevo_id() -> str:
    return str(uuid4())


def estado_talonario(
    letra: str = "A",
    siguiente: int | None = 6305,
    *,
    inicial: int = 6300,
    talonario_id: str = TALONARIO_ID,
    punto_id: str = PUNTO_ORIGEN,
) -> dict:
    """Vista de un talonario tal como la devuelve talonarios._estado."""
    return {
        "id": talonario_id,
        "punto_id": punto_id,
        "letra": letra,
        "numero_inicial": inicial,
        "numero_final": inicial + 49,
        "numero_desde": inicial,
        "rango": f"{letra} {inicial} – {letra} {inicial + 49}",
        "estado": "activo",
        "siguiente_numero": siguiente,
        "siguiente_hoja": f"{letra} {siguiente}" if siguiente is not None else None,
        "quedan": 0 if siguiente is None else 50 - (siguiente - inicial),
        "agotado": siguiente is None,
        "usadas": 0,
        "anuladas": 0,
        "umbral_aviso": 5,
    }


def fila_talonario(
    letra: str = "A",
    inicial: int = 6300,
    *,
    talonario_id: str = TALONARIO_ID,
    punto_id: str = PUNTO_ORIGEN,
    desde: int | None = None,
) -> dict:
    """Fila de talonarios_punto (la que lee _estado)."""
    return {
        "id": talonario_id,
        "punto_id": punto_id,
        "letra": letra,
        "numero_inicial": inicial,
        "numero_final": inicial + 49,
        "numero_desde": desde,
        "estado": "activo",
    }


def cuerpo_traslado(**extra) -> dict:
    cuerpo = {
        "id": nuevo_id(),
        "punto_origen_id": PUNTO_ORIGEN,
        "punto_destino_id": PUNTO_DESTINO,
        "transportador_nombre": "Pedro Perez",
        "fecha": "2026-03-05",
        "items": [{"producto": "sal blanca", "cantidad": 10, "marca": "X", "presentacion": "40 KG"}],
        "firma_despacha_url": "https://storage.prueba/firma-despacha.webp",
        "firma_transporta_url": "https://storage.prueba/firma-transporta.webp",
        "creado_por": USUARIO_ORIGEN,
        "numero_talonario": "A 6300",
        "foto_talonario_url": "https://storage.prueba/talonario.webp",
    }
    cuerpo.update(extra)
    return cuerpo


def cuerpo_llegada_directa(**extra) -> dict:
    cuerpo = {
        "id": nuevo_id(),
        "punto_id": PUNTO_DESTINO,
        "creado_por": USUARIO_DESTINO,
        "numero_talonario": "A 100",
        "foto_talonario_url": "https://storage.prueba/talonario.webp",
        "items": [{"producto": "azucar", "cantidad": 4}],
        "firma_recibe_url": "https://storage.prueba/firma-recibe.webp",
        "declaracion_aceptada": True,
    }
    cuerpo.update(extra)
    return cuerpo


def cuerpo_recepcion(items: list[dict], **extra) -> dict:
    cuerpo = {
        "items": items,
        "firma_recibe_url": "https://storage.prueba/firma-recibe.webp",
        "recibido_por": USUARIO_DESTINO,
        "declaracion_aceptada": True,
    }
    cuerpo.update(extra)
    return cuerpo


def cuerpo_solucion(**extra) -> dict:
    cuerpo = {
        "supervisor_id": SUPERVISOR,
        "solucion": "Se repuso la mercancia faltante",
        "consecutivo_codigo": "npt",
        "consecutivo_numero": "0012",
    }
    cuerpo.update(extra)
    return cuerpo
