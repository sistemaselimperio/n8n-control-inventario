"""Regresion: el concepto de un traslado solo destraba la factura cuya
referencia completa menciona, no una cuyo numero sea prefijo de otro mayor."""

from app.services.duplicates import _concepto_referencia_factura


def test_numero_que_es_prefijo_de_otro_no_coincide():
    # La factura FEI 215 no es la FEI 21542 (ni la FEI 2150).
    assert _concepto_referencia_factura("FEI", "215", "Factura FEI-21542") is False
    assert _concepto_referencia_factura("FEI", "215", "FEI 2150") is False


def test_numero_exacto_sigue_coincidiendo_con_cualquier_separador_posterior():
    assert _concepto_referencia_factura("FEI", "215", "Factura FEI-215") is True
    assert _concepto_referencia_factura("FEI", "215", "Factura FEI-215, bodega 2") is True
    assert _concepto_referencia_factura("FEI", "215", "FEI 215 y FEI 216") is True
    assert _concepto_referencia_factura("FEI", "215", "FEI-215.") is True


def test_si_el_concepto_menciona_las_dos_basta_con_la_exacta():
    assert _concepto_referencia_factura("FEI", "215", "FEI-21542 / FEI-215") is True
