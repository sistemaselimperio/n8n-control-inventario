"""Reglas puras de talonarios, traslados, tipos de documento, productos y turnos.

Son las validaciones de negocio que no necesitan base de datos; el resto de
cada servicio (transacciones, locks) queda cubierto por la integracion."""

import pytest
from pydantic import ValidationError

from app.models.talonario import HojaAnular, TalonarioConfigurar
from app.models.tipo_documento import TipoDocumentoActualizar, TipoDocumentoCrear, normalizar_codigo
from app.models.traslado_punto import (
    ItemRecepcion,
    ItemTrasladoCrear,
    LlegadaDirectaCrear,
    RecepcionTraslado,
    SolucionNovedad,
    TrasladoPuntoCrear,
    normalizar_numero_syscafe,
)
from app.services.productos import extraer_codigo_nombre
from app.services.talonarios import (
    _estado,
    elegir_por_letra,
    formatear_hoja,
    parsear_referencia,
    unir_hojas_esperadas,
)
from app.services.turnos import Celda, calcular_bloques, umbral_pico
from tests.fakes import FakeConn

PUNTO = "77777777-7777-7777-7777-777777777777"
USUARIO = "88888888-8888-8888-8888-888888888888"


# --------------------------------------------------------------------------
# Talonarios
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("A6305", ("A", 6305)),
        ("a-6305", ("A", 6305)),
        ("A 6305", ("A", 6305)),
        ("  ab - 12 ", ("AB", 12)),
        ("ABC0001", ("ABC", 1)),
        ("A1234567", ("A", 1234567)),
        (None, None),
        ("", None),
        ("6305", None),
        ("ABCD1", None),
        ("A-", None),
        ("A12345678", None),  # mas de 7 digitos
        ("A 63 05", None),
        ("A/6305", None),
    ],
)
def test_parsear_referencia(texto, esperado):
    assert parsear_referencia(texto) == esperado


def test_formato_y_union_de_hojas():
    assert formatear_hoja("A", 6305) == "A 6305"
    talonarios = [{"letra": "A", "siguiente_hoja": "A 6305"}, {"letra": "V", "siguiente_hoja": None},
                  {"letra": "W", "siguiente_hoja": "W 7"}]
    assert unir_hojas_esperadas(talonarios) == "A 6305 o W 7"
    assert elegir_por_letra(talonarios, "a")["letra"] == "A"
    assert elegir_por_letra(talonarios, "Z") is None
    assert elegir_por_letra(talonarios, None) is None


def talonario(**extra):
    fila = {"id": "t1", "punto_id": PUNTO, "letra": "A", "numero_inicial": 6300, "numero_final": 6349,
            "numero_desde": None, "estado": "activo"}
    fila.update(extra)
    return fila


async def test_estado_del_talonario_salta_usadas_y_anuladas_de_su_letra():
    conn = FakeConn()
    conn.responder("fetch", "from traslados_puntos where talonario_id",
                   [{"numero_talonario": "A 6300"}, {"numero_talonario": "a-6301"},
                    {"numero_talonario": "V 6303"}, {"numero_talonario": None}, {"numero_talonario": "basura"}])
    conn.responder("fetch", "from talonario_hojas_anuladas", [{"numero": 6302}])
    estado = await _estado(conn, talonario())
    assert estado["siguiente_hoja"] == "A 6303"  # la V6303 es de otra letra: no cuenta
    assert (estado["usadas"], estado["anuladas"], estado["quedan"]) == (2, 1, 47)
    assert estado["agotado"] is False
    assert estado["rango"] == "A 6300 – A 6349"


async def test_estado_respeta_numero_desde_y_detecta_agotado():
    conn = FakeConn()
    conn.responder("fetch", "from traslados_puntos where talonario_id", [{"numero_talonario": "A 6349"}])
    conn.responder("fetch", "from talonario_hojas_anuladas", [])
    estado = await _estado(conn, talonario(numero_desde=6349))
    assert estado["agotado"] is True and estado["siguiente_numero"] is None and estado["quedan"] == 0


@pytest.mark.parametrize("letra, esperada", [("a", "A"), (" bc ", "BC"), ("ABC", "ABC")])
def test_talonario_normaliza_la_letra(letra, esperada):
    assert TalonarioConfigurar(punto_id=PUNTO, usuario_id=USUARIO, letra=letra, numero_inicial=1).letra == esperada


@pytest.mark.parametrize("letra", ["", "ABCD", "1", "A1", "Ñ", "A B"])
def test_talonario_rechaza_letras_invalidas(letra):
    with pytest.raises(ValidationError):
        TalonarioConfigurar(punto_id=PUNTO, usuario_id=USUARIO, letra=letra, numero_inicial=1)


@pytest.mark.parametrize("numero, valido", [(0, False), (-5, False), (1, True), (9_999_950, True), (9_999_951, False)])
def test_talonario_limites_del_primer_numero(numero, valido):
    """50 hojas fijas: la ultima (numero + 49) no puede pasar de 7 digitos."""
    if valido:
        assert TalonarioConfigurar(punto_id=PUNTO, usuario_id=USUARIO, letra="A", numero_inicial=numero)
    else:
        with pytest.raises(ValidationError):
            TalonarioConfigurar(punto_id=PUNTO, usuario_id=USUARIO, letra="A", numero_inicial=numero)


def test_talonario_motivo_vacio_pasa_a_none_y_anular_exige_motivo():
    assert TalonarioConfigurar(punto_id=PUNTO, usuario_id=USUARIO, letra="A", numero_inicial=1, motivo="  ").motivo is None
    with pytest.raises(ValidationError, match="obligatorio"):
        HojaAnular(punto_id=PUNTO, usuario_id=USUARIO, motivo="   ")
    with pytest.raises(ValidationError, match="demasiado largo"):
        HojaAnular(punto_id=PUNTO, usuario_id=USUARIO, motivo="x" * 501)
    assert HojaAnular(punto_id=PUNTO, usuario_id=USUARIO, motivo="x" * 500)


def test_ids_de_talonario_deben_ser_uuid():
    with pytest.raises(ValidationError):
        TalonarioConfigurar(punto_id="no-uuid", usuario_id=USUARIO, letra="A", numero_inicial=1)


# --------------------------------------------------------------------------
# Traslados
# --------------------------------------------------------------------------


def traslado(**extra):
    datos = dict(
        id="t1", punto_origen_id="o", punto_destino_id="d", transportador_nombre="Luis", fecha="2026-01-15",
        items=[{"producto": " sal ", "cantidad": 2}], firma_despacha_url="f1", firma_transporta_url="f2",
        creado_por="u", numero_talonario="A-00231", foto_talonario_url="foto",
    )
    datos.update(extra)
    return TrasladoPuntoCrear(**datos)


def test_traslado_valido_pone_el_producto_en_mayusculas():
    assert traslado().items[0].producto == "SAL"


@pytest.mark.parametrize("cantidad", [0, -1])
def test_item_de_traslado_exige_cantidad_positiva(cantidad):
    with pytest.raises(ValidationError):
        ItemTrasladoCrear(producto="x", cantidad=cantidad)


def test_traslado_exige_al_menos_un_item():
    with pytest.raises(ValidationError):
        traslado(items=[])


@pytest.mark.parametrize("numero", ["", "   ", "A#1", "A_1", "x" * 31, "A\n1", "ñ1"])
def test_numero_de_talonario_invalido(numero):
    with pytest.raises(ValidationError):
        traslado(numero_talonario=numero)


@pytest.mark.parametrize("numero", ["00231", "A-00231", "A 231", "A/231", "x" * 30])
def test_numero_de_talonario_valido(numero):
    assert traslado(numero_talonario=numero).numero_talonario == numero


def test_llegada_directa_acepta_items_vacios_pero_exige_firma_y_declaracion():
    base = dict(id="i", punto_id="p", creado_por="u", numero_talonario="A 1", foto_talonario_url="f",
                firma_recibe_url="firma", declaracion_aceptada=True)
    assert LlegadaDirectaCrear(**base).items == []
    with pytest.raises(ValidationError):
        LlegadaDirectaCrear(**{k: v for k, v in base.items() if k != "declaracion_aceptada"})
    with pytest.raises(ValidationError):
        LlegadaDirectaCrear(**{k: v for k, v in base.items() if k != "firma_recibe_url"})


def test_recepcion_no_acepta_cantidades_negativas_ni_vacia():
    assert ItemRecepcion(id="i", cantidad_recibida=0).cantidad_recibida == 0
    with pytest.raises(ValidationError):
        ItemRecepcion(id="i", cantidad_recibida=-1)
    with pytest.raises(ValidationError):
        RecepcionTraslado(items=[], firma_recibe_url="f", recibido_por="u")


def test_solucion_de_novedad():
    ok = SolucionNovedad(supervisor_id="s", solucion="  se repuso  ", consecutivo_codigo=" npt ", consecutivo_numero="0012")
    assert (ok.solucion, ok.consecutivo_codigo, ok.consecutivo_numero) == ("se repuso", "NPT", "0012")
    for cambio in ({"solucion": "  "}, {"solucion": "x" * 2001}, {"consecutivo_codigo": "n-pt"},
                   {"consecutivo_codigo": ""}, {"consecutivo_numero": "12a"}, {"consecutivo_numero": "12345678901"}):
        datos = dict(supervisor_id="s", solucion="ok", consecutivo_codigo="NPT", consecutivo_numero="1")
        datos.update(cambio)
        with pytest.raises(ValidationError):
            SolucionNovedad(**datos)


@pytest.mark.parametrize(
    "valor, esperado",
    [
        ("NBR-945", "NBR-945"),
        ("nbr 945", "NBR-945"),
        ("NBR945", "NBR-945"),
        ("  nbr   -  945 ", "NBR-945"),
        ("TF1-5832", "TF1-5832"),
        ("AB 1", "AB-1"),
        (None, None),
        ("", None),
        ("   ", None),
    ],
)
def test_normalizar_numero_syscafe(valor, esperado):
    assert normalizar_numero_syscafe(valor) == esperado


@pytest.mark.parametrize("valor", ["TF15832", "N-1", "NBR-12345678", "NBR-", "945", "NBR--945x", "1BR-945", "NBRAB945"])
def test_numero_syscafe_invalido(valor):
    with pytest.raises(ValueError, match="CÓDIGO-NÚMERO"):
        normalizar_numero_syscafe(valor)


# --------------------------------------------------------------------------
# Tipos de documento y productos
# --------------------------------------------------------------------------


@pytest.mark.parametrize("valor, esperado", [(" fei ", "FEI"), ("tb9", "TB9"), ("A", "A"), ("x" * 12, "X" * 12)])
def test_codigo_de_tipo_valido(valor, esperado):
    assert normalizar_codigo(valor) == esperado
    assert TipoDocumentoCrear(codigo=valor).codigo == esperado


@pytest.mark.parametrize("valor", ["", "   ", "x" * 13, "FE-1", "FE 1", "ñ!"])
def test_codigo_de_tipo_invalido(valor):
    with pytest.raises(ValidationError):
        TipoDocumentoCrear(codigo=valor)


def test_descripcion_de_tipo_se_recorta():
    assert TipoDocumentoCrear(codigo="A", descripcion="  hola ").descripcion == "hola"
    assert TipoDocumentoActualizar(descripcion=" x ").descripcion == "x"
    assert TipoDocumentoActualizar().descripcion is None


@pytest.mark.parametrize(
    "descripcion, esperado",
    [
        ("75936  SAL BLANCA * 40 KILOS", ("75936", "SAL BLANCA * 40 KILOS")),
        ("  75936 - SAL  ", ("75936", "SAL")),
        ("123: AZUCAR", ("123", "AZUCAR")),
        ("2 CAJAS DE SAL", None),  # menos de 3 digitos: es una cantidad, no un codigo
        ("SAL BLANCA", None),
        ("75936", None),
        ("75936   ", None),
        ("", None),
    ],
)
def test_extraer_codigo_y_nombre_del_producto(descripcion, esperado):
    assert extraer_codigo_nombre(descripcion) == esperado


# --------------------------------------------------------------------------
# Turnos sugeridos
# --------------------------------------------------------------------------


def test_umbral_pico():
    assert umbral_pico([]) is None
    assert umbral_pico([Celda(0, 8, 0.0)]) is None  # sin carga no hay pico
    assert umbral_pico([Celda(0, 8, 3.0)]) == 3.0
    celdas = [Celda(0, h, float(h)) for h in range(1, 11)]
    assert umbral_pico(celdas) == pytest.approx(9.9)


def test_bloques_sin_umbral_no_hay_nada():
    assert calcular_bloques([Celda(0, 8, 5)], None) == []


def test_bloques_separan_tramos_contiguos_y_no_cubren_huecos():
    celdas = [Celda(0, 8, 5), Celda(0, 9, 6), Celda(0, 10, 5), Celda(0, 14, 7), Celda(0, 12, 1), Celda(2, 23, 9)]
    bloques = calcular_bloques(celdas, umbral=5)
    assert [(b["dia"], b["hora_inicio"], b["hora_fin"]) for b in bloques] == [
        ("lunes", "08:00:00", "11:00:00"),
        ("lunes", "14:00:00", "15:00:00"),
        ("miercoles", "23:00:00", "00:00:00"),  # la hora fin da la vuelta a medianoche
    ]
    assert bloques[0]["carga_maxima"] == 6.0
    assert [b["personal_sugerido"] for b in bloques] == [2, 1, 1]  # max(1, round(horas / 2))
