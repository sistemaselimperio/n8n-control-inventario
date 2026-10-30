"""Validacion de los modelos Pydantic de entrada y de los enums de dominio."""

import pytest
from pydantic import ValidationError

from app.models.empleado import EmpleadoActualizar, EmpleadoCreate, RolEmpleado
from app.models.entrega import (
    ActualizarItemsRequest,
    EntregaCreate,
    EntregaRevision,
    EstadoEntrega,
    SituacionEntrega,
    TIPOS_REMISION,
    TipoDocumento,
)
from app.models.log import EventoLog
from app.models.usuario_dashboard import (
    CambiarPasswordRequest,
    LoginRequest,
    PasswordNueva,
    UsuarioDashboardActualizar,
    UsuarioDashboardCrear,
)

BASE = dict(
    evidencia_url="https://x/y.webp",
    hash_evidencia="h",
    sede_origen_id="s",
    operador_id="o",
    capturado_at="2026-01-15T12:00:00Z",
)


# --------------------------------------------------------------------------
# Enums
# --------------------------------------------------------------------------


def test_valores_de_estado_entrega():
    assert {e.value for e in EstadoEntrega} == {"procesada", "pendiente_revision", "duplicado_bloqueado"}


def test_valores_de_situacion_entrega():
    assert {s.value for s in SituacionEntrega} == {"nueva", "actualizable", "necesita_traslado"}


def test_tipos_de_documento_conocidos_y_remisiones():
    assert {t.value for t in TipoDocumento} == {"FEI", "FV1", "EDP", "EDV", "TB9", "RM3", "RM2", "RSF"}
    assert TIPOS_REMISION == {"RM3", "RM2", "RSF"}


def test_eventos_de_log_son_unicos_y_en_minuscula():
    valores = [e.value for e in EventoLog]
    assert len(valores) == len(set(valores))
    assert all(v == v.lower() and " " not in v for v in valores)
    # Los que usa el flujo principal.
    for esperado in ("foto_capturada", "extraccion_ia", "chequeo_duplicado", "entrega_insertada",
                     "duplicado_bloqueado", "validacion", "sync_tiempo_real", "entrega_actualizada"):
        assert esperado in valores


# --------------------------------------------------------------------------
# EntregaCreate
# --------------------------------------------------------------------------


def test_entrega_create_valida_y_flujo_por_defecto():
    e = EntregaCreate(**BASE)
    assert e.flujo == "despacho"
    assert e.traslado_url is None


@pytest.mark.parametrize("campo", list(BASE))
def test_entrega_create_exige_cada_campo_obligatorio(campo):
    datos = {k: v for k, v in BASE.items() if k != campo}
    with pytest.raises(ValidationError):
        EntregaCreate(**datos)


@pytest.mark.parametrize("flujo", ["", "otro", "REMISION"])
def test_entrega_create_rechaza_flujo_desconocido(flujo):
    with pytest.raises(ValidationError):
        EntregaCreate(**BASE, flujo=flujo)


def test_entrega_create_rechaza_fecha_invalida():
    with pytest.raises(ValidationError):
        EntregaCreate(**{**BASE, "capturado_at": "ayer"})


# --------------------------------------------------------------------------
# EntregaRevision
# --------------------------------------------------------------------------


@pytest.mark.parametrize("tipo", ["", " ", "\t\n"])
def test_revision_rechaza_tipo_vacio(tipo):
    with pytest.raises(ValidationError, match="tipo no puede quedar vacio"):
        EntregaRevision(tipo=tipo)


def test_revision_acepta_cualquier_tipo_no_vacio_y_ausente():
    assert EntregaRevision(tipo="ZZ9").tipo == "ZZ9"  # no esta atado al enum TipoDocumento
    r = EntregaRevision()
    assert r.tipo is None and r.aprobar is True and r.revisado_por == "supervisor"


# --------------------------------------------------------------------------
# ActualizarItemsRequest
# --------------------------------------------------------------------------


def test_actualizar_items_requiere_operador_sede_e_items():
    with pytest.raises(ValidationError):
        ActualizarItemsRequest(items=[], operador_id="o")
    with pytest.raises(ValidationError):
        ActualizarItemsRequest(operador_id="o", sede_id="s")
    ok = ActualizarItemsRequest(items=[], operador_id="o", sede_id="s")
    assert ok.es_faia is None and ok.nota_general is None  # None significa "no tocar"


def test_retirado_por_exige_nombre_y_telefono():
    base = dict(items=[], operador_id="o", sede_id="s")
    with pytest.raises(ValidationError):
        ActualizarItemsRequest(**base, retirado_por={"nombre": "Luis"})
    assert ActualizarItemsRequest(**base, retirado_por={"nombre": "Luis", "telefono": "3"}).retirado_por.nombre == "Luis"


# --------------------------------------------------------------------------
# Empleados
# --------------------------------------------------------------------------


def test_roles_de_empleado():
    assert {r.value for r in RolEmpleado} == {"operador", "supervisor", "admin", "punto_venta", "faia_viewer"}


def test_empleado_create_rechaza_rol_desconocido_y_usa_operador_por_defecto():
    assert EmpleadoCreate(nombre="A", sede_id="s", pin="1234").rol is RolEmpleado.OPERADOR
    with pytest.raises(ValidationError):
        EmpleadoCreate(nombre="A", sede_id="s", pin="1234", rol="dios")


def test_empleado_actualizar_solo_estados_validos():
    assert EmpleadoActualizar(estado="inactivo").estado == "inactivo"
    with pytest.raises(ValidationError):
        EmpleadoActualizar(estado="borrado")


# --------------------------------------------------------------------------
# Usuarios del dashboard
# --------------------------------------------------------------------------


def crear(**extra):
    return UsuarioDashboardCrear(usuario="Ana.Lopez", nombre="Ana", rol="admin", password="12345678", **extra)


def test_usuario_dashboard_se_normaliza():
    u = crear()
    assert u.usuario == "ana.lopez" and u.area == "todo"
    assert UsuarioDashboardCrear(usuario="  ANA  ", nombre="  Ana  ", rol="consulta", password="12345678").nombre == "Ana"


@pytest.mark.parametrize("usuario", ["", "ab", "a" * 51, "con espacio", "ñandu", "a/b", "a;b"])
def test_usuario_dashboard_rechaza_nombres_de_usuario_invalidos(usuario):
    with pytest.raises(ValidationError):
        UsuarioDashboardCrear(usuario=usuario, nombre="Ana", rol="admin", password="12345678")


@pytest.mark.parametrize("password", ["", "1234567", "x" * 201])
def test_password_fuera_de_rango(password):
    with pytest.raises(ValidationError):
        UsuarioDashboardCrear(usuario="ana", nombre="Ana", rol="admin", password=password)
    with pytest.raises(ValidationError):
        PasswordNueva(password=password)


def test_limites_exactos_de_password():
    assert PasswordNueva(password="x" * 8).password == "x" * 8
    assert PasswordNueva(password="x" * 200)
    with pytest.raises(ValidationError):
        CambiarPasswordRequest(actual="x", nueva="corta")


@pytest.mark.parametrize("campo, valor", [("rol", "root"), ("area", "marte"), ("nombre", "   "), ("nombre", "")])
def test_usuario_dashboard_rechaza_rol_area_o_nombre_invalidos(campo, valor):
    datos = dict(usuario="ana", nombre="Ana", rol="admin", password="12345678")
    datos[campo] = valor
    with pytest.raises(ValidationError):
        UsuarioDashboardCrear(**datos)


def test_actualizar_usuario_dashboard_solo_valida_lo_que_viene():
    assert UsuarioDashboardActualizar().model_dump(exclude_none=True) == {}
    assert UsuarioDashboardActualizar(activo=False).model_dump(exclude_none=True) == {"activo": False}
    with pytest.raises(ValidationError):
        UsuarioDashboardActualizar(nombre="  ")


def test_login_request_limites():
    assert LoginRequest(usuario="a", password="b")
    with pytest.raises(ValidationError):
        LoginRequest(usuario="a" * 101, password="b")
