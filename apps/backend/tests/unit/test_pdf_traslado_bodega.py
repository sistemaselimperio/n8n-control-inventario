"""Parser del PDF "TRASLADO ENTRE BODEGAS" del sistema contable: funciones
puras sobre el texto extraido (fixture real en tests/fixtures) y la extraccion
de texto con pypdf. Nada de red ni de base de datos."""

from pathlib import Path

import pytest

from app.services import pdf_traslado_bodega as pdf

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "npt_1839_layout.txt"


@pytest.fixture(scope="module")
def texto() -> str:
    return FIXTURE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def borrador(texto) -> dict:
    return pdf.parsear_traslado_bodega(texto)


def test_encabezado(borrador):
    assert borrador["numero"] == "NPT-1839"
    assert borrador["fecha"] == "2026-11-02"
    assert borrador["concepto"] == "SUGERIDO PUENTE 29 OCTUBRE"
    assert borrador["origen"] == "BODEGA VENTAS"
    assert borrador["destino_texto"] == "BODEGA PUENTE DE TIERRA"
    assert borrador["elaboro"] == "YOHANA"


def test_27_items_y_suma_igual_a_totales(borrador):
    assert len(borrador["items"]) == 27
    assert sum(i["cantidad"] for i in borrador["items"]) == 439
    assert borrador["total_documento"] == 439
    assert borrador["advertencias"] == []


def test_conserva_ceros_a_la_izquierda_en_la_referencia(borrador):
    por_ref = {i["referencia"]: i for i in borrador["items"]}
    assert "02058" in por_ref and "2058" not in por_ref
    assert "1476" in por_ref


def test_separa_empaque_como_ultima_palabra_aunque_el_detalle_la_repita(borrador):
    por_ref = {i["referencia"]: i for i in borrador["items"]}
    assert por_ref["57882"] == {
        "referencia": "57882",
        "detalle": "MIRRINGO ORIGINAL ADULTO X LIBRA",
        "empaque": "LIBRA",
        "cantidad": 20,
        "precio": 4850.0,
    }
    assert por_ref["16164"]["detalle"] == "C. CONEJOS P X K"
    assert por_ref["16164"]["empaque"] == "KILO"
    assert por_ref["16164"]["cantidad"] == 100
    assert por_ref["1476"]["detalle"] == "25-4-24 NUTRIMON"
    assert por_ref["1476"]["precio"] == 140000.0
    assert por_ref["52546"]["empaque"] == "ABOB"


def test_cantidades_son_enteros(borrador):
    assert all(isinstance(i["cantidad"], int) for i in borrador["items"])


def test_totales_distintos_generan_advertencia(texto):
    alterado = texto.replace("439.00", "440.00")
    res = pdf.parsear_traslado_bodega(alterado)
    assert len(res["items"]) == 27
    assert any("440" in a and "439" in a for a in res["advertencias"])


def test_linea_de_la_tabla_ilegible_genera_advertencia(texto):
    alterado = texto.replace("140,000.00", "ciento cuarenta mil")
    res = pdf.parsear_traslado_bodega(alterado)
    assert len(res["items"]) == 26
    assert any("1476" in a for a in res["advertencias"])


def test_sin_totales_advierte_que_no_se_pudo_validar(texto):
    alterado = texto.replace("Totales", "Tot")
    res = pdf.parsear_traslado_bodega(alterado)
    assert res["total_documento"] is None
    assert any("total" in a.lower() for a in res["advertencias"])


def test_sin_items_lanza_error(texto):
    solo_encabezado = texto.split("Referencia")[0]
    with pytest.raises(pdf.PdfTrasladoInvalido):
        pdf.parsear_traslado_bodega(solo_encabezado)


def test_sin_numero_lanza_error(texto):
    with pytest.raises(pdf.PdfTrasladoInvalido):
        pdf.parsear_traslado_bodega(texto.replace("N PT - 1839", ""))


def test_texto_vacio_lanza_error():
    with pytest.raises(pdf.PdfTrasladoInvalido):
        pdf.parsear_traslado_bodega("   \n  ")


def test_varias_paginas_acumulan_items_y_toman_totales_del_final(texto):
    # Una segunda pagina repite el encabezado de la tabla y trae mas lineas.
    pagina_2 = (
        "  Referencia         Detalle         Emb.           Cant             Precio\n"
        " 00012             PRODUCTO EXTRA BULTO                                    1.00        1,000.00\n"
    )
    cuerpo, pie = texto.split("  Bodega:", 1)
    unido = cuerpo + "\n" + pagina_2 + "\n  Bodega:" + pie.replace("439.00", "440.00")
    res = pdf.parsear_traslado_bodega(unido)
    assert len(res["items"]) == 28
    assert res["items"][-1]["referencia"] == "00012"
    assert res["advertencias"] == []


def test_extraer_texto_rechaza_archivo_que_no_es_pdf():
    with pytest.raises(pdf.PdfTrasladoInvalido):
        pdf.extraer_texto_pdf(b"no soy un pdf")


def test_extraer_texto_rechaza_pdf_sin_texto():
    from pypdf import PdfWriter
    import io

    escritor = PdfWriter()
    escritor.add_blank_page(width=200, height=200)
    salida = io.BytesIO()
    escritor.write(salida)
    with pytest.raises(pdf.PdfTrasladoInvalido) as exc:
        pdf.extraer_texto_pdf(salida.getvalue())
    assert "texto" in str(exc.value).lower()


def test_pdf_real_de_ejemplo_se_parsea_de_punta_a_punta():
    ruta = Path(__file__).resolve().parent.parent / "fixtures" / "npt_1839.pdf"
    if not ruta.exists():
        pytest.skip("PDF de ejemplo no disponible")
    res = pdf.parsear_traslado_bodega(pdf.extraer_texto_pdf(ruta.read_bytes()))
    assert res["numero"] == "NPT-1839" and len(res["items"]) == 27 and res["advertencias"] == []


def test_sugerir_punto_por_nombre_ignora_prefijo_bodega_y_codigo():
    puntos = [
        {"id": "p1", "nombre": "CFC — La Cumbre", "codigo": "CFC"},
        {"id": "p2", "nombre": "PT — Puente de Tierra", "codigo": "PT"},
    ]
    assert pdf.sugerir_punto("BODEGA PUENTE DE TIERRA", puntos)["id"] == "p2"
    assert pdf.sugerir_punto("BODEGA OTRA", puntos) is None
    assert pdf.sugerir_punto("", puntos) is None
