"""Compuerta de confianza: marcar_estado_por_confianza()."""

import pytest

from app.config import get_settings
from app.models.entrega import EstadoEntrega
from app.services.duplicates import marcar_estado_por_confianza

P, R = EstadoEntrega.PROCESADA, EstadoEntrega.PENDIENTE_REVISION


@pytest.mark.parametrize(
    "confianza, minimo, esperado",
    [
        ({"tipo": 0.9, "indicativo_numero": 0.9}, 0.75, P),
        # Limite: igual al minimo aprueba (la comparacion es estrictamente "menor").
        ({"tipo": 0.75, "indicativo_numero": 0.75}, 0.75, P),
        ({"tipo": 0.7499, "indicativo_numero": 0.9}, 0.75, R),
        ({"tipo": 0.9, "indicativo_numero": 0.7499}, 0.75, R),
        # Un campo critico ausente cuenta como confianza 0.
        ({"tipo": 0.99}, 0.75, R),
        ({"indicativo_numero": 0.99}, 0.75, R),
        ({}, 0.75, R),
        # El minimo configurable manda.
        ({"tipo": 0.8, "indicativo_numero": 0.8}, 0.9, R),
        ({"tipo": 0.8, "indicativo_numero": 0.8}, 0.8, P),
        ({"tipo": 0.0, "indicativo_numero": 0.0}, 0.0, P),
        # Las cantidades (items) quedan fuera de la compuerta.
        ({"tipo": 0.95, "indicativo_numero": 0.95, "items": 0.01}, 0.75, P),
    ],
)
def test_umbrales(confianza, minimo, esperado):
    assert marcar_estado_por_confianza(confianza, minimo) is esperado


def test_usa_el_minimo_configurado_en_settings():
    s = get_settings()
    assert s.min_confidence == 0.75
    assert s.min_confidence_rechazo == 0.35
    assert s.min_confidence_rechazo < s.min_confidence
    justo = {"tipo": s.min_confidence, "indicativo_numero": s.min_confidence}
    assert marcar_estado_por_confianza(justo, s.min_confidence) is P
