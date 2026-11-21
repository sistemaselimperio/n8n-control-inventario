"""Reglas puras del modulo Traslados: perfiles, autorizacion por accion y
estado, resolucion de puntos, plan de comprobantes e imagen de firma. Sin base
de datos ni red."""

import pytest

from app.models.traslado import DevolverRequest, TrasladoEditar
from app.services.permisos_traslados import PerfilTraslados, perfil_de
from app.services import traslados_reglas as r

SFC = "11111111-1111-1111-1111-111111111111"
CFC = "22222222-2222-2222-2222-222222222222"
TB9 = "33333333-3333-3333-3333-333333333333"

PUNTOS = [
    {"id": SFC, "nombre": "SFC — Samacá", "codigo": "SFC", "es_interna": False},
    {"id": CFC, "nombre": "CFC — La Cumbre", "codigo": "CFC", "es_interna": False},
    {"id": TB9, "nombre": "TB9 — Bodega Puente de Tierra", "codigo": "TB9", "es_interna": True},
]


def usuario(rol="supervisor", area="traslados", punto_id=None, cedula="1234567") -> dict:
    return {"id": "u-1", "usuario": "ana", "nombre": "Ana", "rol": rol, "area": area, "punto_id": punto_id, "cedula": cedula}


# --------------------------- perfiles ---------------------------


@pytest.mark.parametrize(
    "rol, area, punto_id, tipo, alcance",
    [
        ("admin", "todo", None, "admin", None),
        ("admin", "bodega", SFC, "admin", None),  # el admin ignora punto/area guardados
        ("supervisor", "traslados", None, "encargada", None),
        ("supervisor", "traslados", SFC, "punto", SFC),
        ("consulta", "traslados", None, "lectura", None),
        ("consulta", "traslados", SFC, "lectura", SFC),
        ("supervisor", "todo", None, "lectura", None),
        ("consulta", "todo", None, "lectura", None),
        ("supervisor", "todo", SFC, "lectura", None),  # punto huérfano en area todo no limita ni da escritura
    ],
)
def test_perfil_de_cada_rol_y_area(rol, area, punto_id, tipo, alcance):
    perfil = perfil_de(usuario(rol, area, punto_id))
    assert perfil is not None and perfil.tipo == tipo and perfil.punto_id == alcance


@pytest.mark.parametrize("rol", ["supervisor", "consulta"])
def test_area_bodega_no_tiene_acceso_al_modulo(rol):
    assert perfil_de(usuario(rol, "bodega")) is None


def test_actor_para_logs_usa_el_usuario_de_la_sesion():
    assert perfil_de(usuario()).actor == "dashboard:ana"


def test_gestiona_solo_admin_y_encargada():
    assert perfil_de(usuario("admin", "todo")).gestiona
    assert perfil_de(usuario()).gestiona
    assert not perfil_de(usuario(punto_id=SFC)).gestiona
    assert not perfil_de(usuario("consulta")).gestiona


def test_ve_punto_segun_alcance():
    todos = perfil_de(usuario())
    assert todos.ve(SFC) and todos.ve(CFC)
    solo_sfc = perfil_de(usuario(punto_id=SFC))
    assert solo_sfc.ve(SFC) and not solo_sfc.ve(CFC)


# --------------------------- autorizar_accion ---------------------------


def comprobante(estado="pendiente", punto_id=SFC, tipo="salida") -> dict:
    return {"id": "c-1", "estado": estado, "punto_id": punto_id, "tipo": tipo}


ADMIN = perfil_de(usuario("admin", "todo"))
ENCARGADA = perfil_de(usuario())
PUNTO_SFC = perfil_de(usuario(punto_id=SFC))
PUNTO_CFC = perfil_de(usuario(punto_id=CFC))
LECTURA = perfil_de(usuario("consulta"))


@pytest.mark.parametrize(
    "perfil, accion, estado, resultado",
    [
        # confirmar: solo el punto dueno (o admin) y solo pendiente
        (PUNTO_SFC, "confirmar", "pendiente", None),
        (ADMIN, "confirmar", "pendiente", None),
        (ENCARGADA, "confirmar", "pendiente", r.SinPermiso),
        (LECTURA, "confirmar", "pendiente", r.SinPermiso),
        (PUNTO_CFC, "confirmar", "pendiente", r.TrasladoNoEncontrado),  # no ve ese punto: ni se entera
        (PUNTO_SFC, "confirmar", "confirmado", r.EstadoNoPermitido),
        (PUNTO_SFC, "confirmar", "devuelto", r.EstadoNoPermitido),
        # devolver un pendiente: punto dueno o admin
        (PUNTO_SFC, "devolver", "pendiente", None),
        (ADMIN, "devolver", "pendiente", None),
        (ENCARGADA, "devolver", "pendiente", r.SinPermiso),
        (PUNTO_CFC, "devolver", "pendiente", r.TrasladoNoEncontrado),
        # devolver un confirmado: solo encargada/admin; el punto no puede revertir
        (ENCARGADA, "devolver", "confirmado", None),
        (ADMIN, "devolver", "confirmado", None),
        (PUNTO_SFC, "devolver", "confirmado", r.SinPermiso),
        (LECTURA, "devolver", "confirmado", r.SinPermiso),
        (ENCARGADA, "devolver", "devuelto", r.EstadoNoPermitido),
        # reenviar: solo devuelto y solo encargada/admin
        (ENCARGADA, "reenviar", "devuelto", None),
        (ADMIN, "reenviar", "devuelto", None),
        (PUNTO_SFC, "reenviar", "devuelto", r.SinPermiso),
        (LECTURA, "reenviar", "devuelto", r.SinPermiso),
        (ENCARGADA, "reenviar", "pendiente", r.EstadoNoPermitido),
        (ENCARGADA, "reenviar", "confirmado", r.EstadoNoPermitido),
    ],
)
def test_autorizar_accion(perfil, accion, estado, resultado):
    if resultado is None:
        assert r.autorizar_accion(perfil, accion, comprobante(estado)) is None
    else:
        with pytest.raises(resultado):
            r.autorizar_accion(perfil, accion, comprobante(estado))


def test_el_permiso_se_evalua_antes_que_el_estado():
    """Quien no puede actuar recibe 403 aunque el estado tampoco sirva: no se
    le revela el estado de un comprobante que no le toca resolver."""
    with pytest.raises(r.SinPermiso):
        r.autorizar_accion(PUNTO_SFC, "reenviar", comprobante("confirmado"))


def test_accion_desconocida_se_rechaza():
    with pytest.raises(ValueError):
        r.autorizar_accion(ADMIN, "borrar", comprobante())


# --------------------------- resolver_punto ---------------------------


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("SAMACÁ", SFC),
        ("BODEGA SAMACA", SFC),
        ("SFC — Samacá", SFC),
        ("SFC", SFC),  # por codigo
        ("sfc", SFC),
        ("TB9", TB9),
        ("BODEGA PUENTE DE TIERRA", TB9),
        ("TB9 - ALGO RARO", TB9),  # codigo seguido de descripcion
        ("OTRA BODEGA", None),
        ("", None),
        (None, None),
    ],
)
def test_resolver_punto_por_codigo_o_nombre(texto, esperado):
    punto = r.resolver_punto(texto, PUNTOS)
    assert (punto["id"] if punto else None) == esperado


def test_resolver_punto_no_adivina_si_el_codigo_es_ambiguo():
    repetidos = [*PUNTOS, {"id": "x", "nombre": "SFC — Otro", "codigo": "SFC", "es_interna": False}]
    assert r.resolver_punto("SFC", repetidos) is None


BV = "44444444-4444-4444-4444-444444444444"
PUNTOS_CON_ALIAS = [
    *PUNTOS,
    {
        "id": BV,
        "nombre": "BV — Bodega Ventas",
        "codigo": "BV",
        "es_interna": True,
        "alias": ["Bodega Ventas Principal", "Bodega Principal", "Principal", "Bodega Agroquímicos Estación"],
    },
]


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("BODEGA PRINCIPAL", BV),
        ("BODEGA AGROQUIMICOS ESTACION", BV),
        ("BODEGA VENTAS PRINCIPAL", BV),
        ("BV", BV),
        ("BODEGA SAMACA PRINCIPAL", SFC),  # el alias no vale en coincidencia parcial
        ("BODEGA DESCONOCIDA", None),
    ],
)
def test_resolver_punto_usa_los_alias(texto, esperado):
    punto = r.resolver_punto(texto, PUNTOS_CON_ALIAS)
    assert (punto["id"] if punto else None) == esperado


def test_resolver_punto_con_alias_compartido_no_adivina():
    otro = {"id": "x", "nombre": "XX — Otra", "codigo": "XX", "es_interna": False, "alias": ["Principal"]}
    assert r.resolver_punto("BODEGA PRINCIPAL", [*PUNTOS_CON_ALIAS, otro]) is None


# --------------------------- evaluar_traslado ---------------------------

SFC_P, CFC_P, TB9_P = PUNTOS


def test_ambos_externos_generan_salida_e_ingreso():
    ev = r.evaluar_traslado("NPT-1839", SFC_P, CFC_P)
    assert ev.bloqueantes == []
    assert [(c.tipo, c.punto_id) for c in ev.comprobantes] == [("salida", SFC), ("ingreso", CFC)]


def test_origen_interno_no_genera_salida():
    ev = r.evaluar_traslado("NPT-1839", TB9_P, CFC_P)
    assert ev.bloqueantes == []
    assert [(c.tipo, c.punto_id) for c in ev.comprobantes] == [("ingreso", CFC)]


def test_destino_interno_no_genera_ingreso():
    ev = r.evaluar_traslado("NPT-1839", SFC_P, TB9_P)
    assert [(c.tipo, c.punto_id) for c in ev.comprobantes] == [("salida", SFC)]


def test_sin_numero_origen_o_destino_queda_bloqueado_sin_adivinar():
    assert r.evaluar_traslado(None, SFC_P, CFC_P).bloqueantes == [r.MSG_SIN_NUMERO]
    assert r.evaluar_traslado("NPT-1", None, CFC_P).bloqueantes == [r.MSG_SIN_ORIGEN]
    assert r.evaluar_traslado("NPT-1", SFC_P, None).bloqueantes == [r.MSG_SIN_DESTINO]
    todo = r.evaluar_traslado(None, None, None)
    assert todo.bloqueantes == [r.MSG_SIN_NUMERO, r.MSG_SIN_ORIGEN, r.MSG_SIN_DESTINO]
    assert todo.comprobantes == []


def test_mismo_punto_en_ambos_lados_es_bloqueante():
    assert r.evaluar_traslado("NPT-1", SFC_P, SFC_P).bloqueantes == [r.MSG_MISMO_PUNTO]


def test_ambos_lados_internos_no_tiene_comprobantes_y_es_bloqueante():
    ev = r.evaluar_traslado("NPT-1", TB9_P, {**TB9_P, "id": "otro-interno"})
    assert ev.bloqueantes == [r.MSG_AMBOS_INTERNOS] and ev.comprobantes == []


def test_con_bloqueantes_no_se_planifican_comprobantes():
    assert r.evaluar_traslado(None, SFC_P, CFC_P).comprobantes == []


def test_fusionar_advertencias_reemplaza_solo_las_bloqueantes():
    previas = ["La suma no coincide", r.MSG_SIN_ORIGEN, r.MSG_SIN_NUMERO]
    assert r.fusionar_advertencias(previas, [r.MSG_SIN_DESTINO]) == ["La suma no coincide", r.MSG_SIN_DESTINO]
    assert r.fusionar_advertencias(previas, []) == ["La suma no coincide"]


# --------------------------- numero ---------------------------


def test_normalizar_numero_usa_el_formato_syscafe():
    assert r.normalizar_numero(" npt 1839 ") == "NPT-1839"
    assert r.normalizar_numero("") is None and r.normalizar_numero(None) is None


def test_numero_invalido_es_dato_invalido():
    with pytest.raises(r.DatoInvalido):
        r.normalizar_numero("???")


# --------------------------- imagen de firma ---------------------------

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20
JPG = b"\xff\xd8\xff\xe0" + b"0" * 20
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"0" * 20


@pytest.mark.parametrize(
    "contenido, esperado",
    [(PNG, ("png", "image/png")), (JPG, ("jpg", "image/jpeg")), (WEBP, ("webp", "image/webp")), (b"%PDF-1.4", None), (b"", None), (b"GIF89a", None)],
)
def test_detectar_imagen_por_firma_de_bytes(contenido, esperado):
    assert r.detectar_imagen(contenido) == esperado


def test_limites():
    assert r.MAX_BYTES_FIRMA == 2 * 1024 * 1024
    from app.services.traslados_bodega import MAX_BYTES_PDF

    assert r.MAX_BYTES_PDF == MAX_BYTES_PDF
    assert r.MAX_ARCHIVOS_POR_PETICION >= 10


# --------------------------- modelos de entrada ---------------------------


def test_devolver_exige_motivo_no_vacio():
    assert DevolverRequest(motivo="  Número equivocado ").motivo == "Número equivocado"
    for malo in ("", "   ", "x" * 501):
        with pytest.raises(ValueError):
            DevolverRequest(motivo=malo)


def test_editar_distingue_no_enviado_de_null():
    assert TrasladoEditar().model_fields_set == set()
    cambios = TrasladoEditar(origen_punto_id=None, numero="npt-1")
    assert cambios.model_fields_set == {"origen_punto_id", "numero"}


def test_editar_valida_uuid_de_puntos():
    with pytest.raises(ValueError):
        TrasladoEditar(origen_punto_id="no-uuid")
