"""scripts/crear_receptores.py: carga masiva de receptores por punto desde un
CSV (nombre,cedula,punto), con la base simulada. Ninguna prueba abre una
conexion real ni usa un CSV del repo (el archivo real vive fuera)."""

from __future__ import annotations

import pytest

from scripts import crear_receptores as script
from tests.fakes import FakeConn

PUNTOS = [
    {"id": "p-nvl", "nombre": "NVL — Villa de Leyva", "codigo": "NVL", "alias": []},
    {"id": "p-tb", "nombre": "TB — Chiquinquirá", "codigo": "TB", "alias": ["Bodega Chiqui"]},
    {"id": "p-cfc", "nombre": "CFC — La Cumbre", "codigo": "CFC", "alias": []},
]


class ConexionFalsa(FakeConn):
    def __init__(self) -> None:
        super().__init__()
        self.cerrada = False

    async def close(self) -> None:
        self.cerrada = True


@pytest.fixture
def conexion(monkeypatch) -> ConexionFalsa:
    falsa = ConexionFalsa()
    urls: list[str] = []

    async def _conectar(url, *args, **kwargs):
        urls.append(url)
        return falsa

    monkeypatch.setattr(script.asyncpg, "connect", _conectar)
    falsa.urls = urls  # type: ignore[attr-defined]
    falsa.responder("fetch", "from puntos", PUNTOS)
    return falsa


def csv_en(tmp_path, texto: str):
    ruta = tmp_path / "receptores.csv"
    ruta.write_text(texto, encoding="utf-8")
    return str(ruta)


# --------------------------- lectura del CSV ---------------------------


def test_lee_el_csv_con_bom_comillas_y_espacios(tmp_path):
    ruta = tmp_path / "r.csv"
    ruta.write_bytes('﻿nombre,cedula,punto\n"Pérez, Luis", 1.234.567 ,Villa de Leyva\n'.encode("utf-8"))
    (fila,) = script.leer_csv(str(ruta))
    assert (fila.nombre, fila.cedula, fila.punto, fila.linea) == ("Pérez, Luis", "1.234.567", "Villa de Leyva", 2)


@pytest.mark.parametrize("encabezado", ["nombre,cedula", "nombre,documento,punto", "punto,nombre,cedula"])
def test_un_encabezado_distinto_se_rechaza(tmp_path, encabezado):
    with pytest.raises(script.ErrorCsv, match="nombre,cedula,punto"):
        script.leer_csv(csv_en(tmp_path, encabezado + "\nA,12345,X\n"))


def test_las_lineas_en_blanco_se_ignoran(tmp_path):
    filas = script.leer_csv(csv_en(tmp_path, "nombre,cedula,punto\n\nAna,12345,Villa de Leyva\n,,\n"))
    assert [f.nombre for f in filas] == ["Ana"]


# --------------------------- cruce con los puntos ---------------------------


def test_cruza_el_nombre_sin_codigo_ignorando_mayusculas_y_tildes(tmp_path):
    texto = "nombre,cedula,punto\nA,11111,villa de leyva\nB,22222,CHIQUINQUIRA\nC,33333,  La   Cumbre \n"
    plan = script.planificar(script.leer_csv(csv_en(tmp_path, texto)), PUNTOS)
    assert not plan.problemas
    assert {(k, v["nombre"]) for k, v in plan.receptores.items()} == {
        (("p-nvl", "11111"), "A"), (("p-tb", "22222"), "B"), (("p-cfc", "33333"), "C"),
    }


def test_tambien_acepta_codigo_alias_y_nombre_completo(tmp_path):
    texto = "nombre,cedula,punto\nA,11111,NVL\nB,22222,bodega chiqui\nC,33333,CFC — La Cumbre\n"
    plan = script.planificar(script.leer_csv(csv_en(tmp_path, texto)), PUNTOS)
    assert not plan.problemas and {k[0] for k in plan.receptores} == {"p-nvl", "p-tb", "p-cfc"}


def test_un_punto_sin_coincidencia_es_un_problema_y_se_lista(tmp_path):
    texto = "nombre,cedula,punto\nA,11111,Villa de Leyva\nB,22222,Atlantida\nC,33333,Atlantida\n"
    plan = script.planificar(script.leer_csv(csv_en(tmp_path, texto)), PUNTOS)
    assert plan.sin_punto == {"Atlantida": [3, 4]}
    assert plan.problemas


def test_un_punto_ambiguo_es_un_problema(tmp_path):
    puntos = PUNTOS + [{"id": "p-otro", "nombre": "XYZ — Villa de Leyva", "codigo": "XYZ", "alias": []}]
    plan = script.planificar(script.leer_csv(csv_en(tmp_path, "nombre,cedula,punto\nA,11111,Villa de Leyva\n")), puntos)
    assert plan.problemas and "Villa de Leyva" in plan.ambiguos


@pytest.mark.parametrize(
    "linea", ["Ana,12,Villa de Leyva", "Ana,abc123,Villa de Leyva", ",12345,Villa de Leyva", "Ana,12345,"]
)
def test_filas_con_datos_invalidos_son_problemas(tmp_path, linea):
    plan = script.planificar(script.leer_csv(csv_en(tmp_path, "nombre,cedula,punto\n" + linea + "\n")), PUNTOS)
    assert plan.errores and plan.problemas and plan.receptores == {}


def test_la_misma_persona_repetida_en_un_punto_queda_una_vez_con_el_ultimo_nombre(tmp_path):
    texto = "nombre,cedula,punto\nLuis P,1.234.567,Villa de Leyva\nLuis Pérez,1234567,NVL\nLuis Pérez,1234567,Paipa\n"
    plan = script.planificar(script.leer_csv(csv_en(tmp_path, texto)), PUNTOS + [{"id": "p-pfe", "nombre": "PFE — Paipa", "codigo": "PFE", "alias": []}])
    assert plan.repetidos == 1
    assert plan.receptores[("p-nvl", "1234567")]["nombre"] == "Luis Pérez"
    assert ("p-pfe", "1234567") in plan.receptores  # una persona puede estar en varios puntos


# --------------------------- ejecucion ---------------------------


async def test_sin_si_es_una_simulacion_que_no_escribe(conexion, monkeypatch, tmp_path, capsys):
    ruta = csv_en(tmp_path, "nombre,cedula,punto\nLuis Pérez,1.234.567,Villa de Leyva\n")
    monkeypatch.setattr("sys.argv", ["crear_receptores", ruta])
    await script.main()
    salida = capsys.readouterr().out
    assert "Luis Pérez" in salida and "NVL" in salida and "--si" in salida
    assert conexion.sql_ejecutado("insert into receptores_punto") == []
    assert conexion.cerrada


async def test_con_puntos_sin_coincidencia_aborta_aun_con_si(conexion, monkeypatch, tmp_path, capsys):
    ruta = csv_en(tmp_path, "nombre,cedula,punto\nLuis,1234567,Atlantida\nAna,7654321,Villa de Leyva\n")
    monkeypatch.setattr("sys.argv", ["crear_receptores", ruta, "--si"])
    with pytest.raises(SystemExit) as info:
        await script.main()
    assert info.value.code == 1
    assert "Atlantida" in capsys.readouterr().out
    assert conexion.sql_ejecutado("insert into receptores_punto") == []


async def test_con_si_hace_upsert_idempotente_por_punto_y_cedula(conexion, monkeypatch, tmp_path, capsys):
    ruta = csv_en(tmp_path, "nombre,cedula,punto\nLuis Pérez,1.234.567,Villa de Leyva\nAna Gil,7654321,Chiquinquira\n")
    conexion.responder("fetchval", "insert into receptores_punto", True, False)  # creado, ya existia
    monkeypatch.setattr("sys.argv", ["crear_receptores", ruta, "--si"])
    await script.main()
    inserts = conexion.sql_ejecutado("insert into receptores_punto")
    assert len(inserts) == 2
    sql = inserts[0][1]
    assert "on conflict (punto_id, cedula) do update" in sql and "nombre = excluded.nombre" in sql and "activo = true" in sql
    assert inserts[0][2] == ("p-nvl", "Luis Pérez", "1234567")
    assert "1 creados, 1 actualizados" in capsys.readouterr().out
    todo = " ".join(c[1].lower() for c in conexion.llamadas)
    assert "delete" not in todo and "truncate" not in todo
    assert conexion.cerrada


async def test_csv_inexistente_o_con_encabezado_malo_termina_sin_conectar(conexion, monkeypatch, tmp_path):
    for ruta in (str(tmp_path / "no-existe.csv"), csv_en(tmp_path, "a,b,c\n1,2,3\n")):
        monkeypatch.setattr("sys.argv", ["crear_receptores", ruta, "--si"])
        with pytest.raises(SystemExit) as info:
            await script.main()
        assert info.value.code == 1
    assert conexion.urls == []
