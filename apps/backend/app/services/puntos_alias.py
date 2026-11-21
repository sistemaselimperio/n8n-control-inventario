"""Otros nombres (`puntos.alias`) con los que el sistema contable escribe un
punto en los PDF de traslado ("BODEGA PRINCIPAL" para BV, por ejemplo). Aca
vive la normalizacion y la validacion al crear o editar desde /creador; la
resolucion contra el texto del PDF esta en pdf_traslado_bodega.sugerir_punto.

Un alias vale solo en coincidencia exacta, asi que dos puntos activos nunca
pueden compartir una misma clave (ni un alias igual al nombre de otro punto):
si pasara, el PDF quedaria como borrador por ambiguo.
"""

import re

from app.db import get_pool
from app.services.pdf_traslado_bodega import _clave, _variantes_punto, claves_alias_punto
from app.services.usuarios import DatoInvalido

MAX_ALIAS = 20
MAX_LARGO_ALIAS = 80


def normalizar_alias(alias: list[str]) -> list[str]:
    """Recorta y colapsa espacios, descarta vacios y repetidos (comparando por
    clave: sin tildes, mayusculas ni "bodega" inicial) y conserva el primer
    texto y el orden. Un alias que no deja ninguna clave utilizable se rechaza."""
    resultado: list[str] = []
    vistas: set[str] = set()
    for crudo in alias:
        texto = re.sub(r"\s+", " ", crudo or "").strip()
        if not texto:
            continue
        clave = _clave(texto)
        if not clave:
            raise DatoInvalido(f"El nombre alterno «{texto}» no es válido")
        if clave not in vistas:
            vistas.add(clave)
            resultado.append(texto)
    return resultado


async def validar_alias(alias: list[str], punto_id: str | None) -> list[str]:
    """Devuelve el alias normalizado o lanza DatoInvalido (el router responde
    409) si alguno coincide con el nombre o con otro alias de OTRO punto
    activo. `punto_id` None es un punto que aun no existe."""
    limpio = normalizar_alias(alias)
    if not limpio:
        return limpio
    pool = await get_pool()
    otros = await pool.fetch(
        "select nombre, codigo, alias from puntos where activo = true and ($1::uuid is null or id <> $1::uuid)",
        punto_id,
    )
    for texto in limpio:
        clave = _clave(texto)
        for otro in otros:
            punto = {"nombre": otro["nombre"], "codigo": otro["codigo"], "alias": otro["alias"]}
            if clave in _variantes_punto(punto) or clave in claves_alias_punto(punto):
                raise DatoInvalido(
                    f"El nombre alterno «{texto}» ya lo usa el punto {otro['nombre']}: "
                    "cada nombre debe identificar un solo punto"
                )
    return limpio
