"""Modelos del flujo de traslados entre puntos: bodega origen carga el
traslado y firma como quien despacha, el conductor firma aparte, y bodega
destino confirma que recibio (con o sin novedad). Ver
app/services/traslados_puntos.py y el plan "traslados-entre-puntos". Tablas
aditivas -- no comparten nada con el modelo de entregas (app/models/entrega.py).
"""

import re
from datetime import date
from enum import StrEnum

from pydantic import BaseModel, Field, field_validator


class EstadoTrasladoPunto(StrEnum):
    EN_TRANSITO = "en_transito"
    RECIBIDO = "recibido"
    # Alguna linea llego con menos cantidad de la enviada, o se cargo una
    # novedad (general o por item) -- ver registrar_recepcion.
    RECIBIDO_CON_NOVEDAD = "recibido_con_novedad"


class ItemTrasladoCrear(BaseModel):
    producto: str
    marca: str = ""
    presentacion: str = ""
    cantidad: int = Field(gt=0)
    # Opcional: no todos los productos del talonario traen vencimiento.
    fecha_vencimiento: date | None = None

    @field_validator("producto")
    @classmethod
    def _producto_en_mayusculas(cls, valor: str) -> str:
        # Los nombres de producto se guardan siempre en mayusculas, vengan de
        # la lectura de la foto o de una edicion a mano.
        return valor.strip().upper()


class ExtraerTalonario(BaseModel):
    """Payload de POST /traslados-puntos/extraer -- foto del talonario ya
    subida a Storage y punto de origen (el logueado, se excluye como destino)."""

    foto_url: str
    punto_origen_id: str
    # Letra del talonario que el operador eligio antes de la foto ("A", "V").
    # Opcional para la app vieja: sin ella se acepta cualquier talonario activo.
    letra: str | None = None
    # True si el operador ya eligio "Llega directo" antes de la foto: no se
    # exigen destino ni transportador. Sin el, solo cuenta lo que lea la IA.
    directo: bool | None = None


def _validar_numero_talonario(v: str) -> str:
    texto = v.strip()
    if not texto:
        raise ValueError("El número de talonario es obligatorio")
    if not re.fullmatch(r"[A-Za-z0-9 /-]{1,30}", texto):
        raise ValueError(
            "El número de talonario solo puede tener letras, números, espacios, guiones y barras (máximo 30 caracteres)"
        )
    return texto


class TrasladoPuntoCrear(BaseModel):
    """Payload de POST /traslados-puntos -- lo arma la app movil en
    FirmaTransportador, despues de subir las 2 firmas (despacha/transporta).

    `id` lo genera el celular (expo-crypto randomUUID()) ANTES de crear el
    traslado: el path de esas firmas en Storage
    (firmas-traslados/{id}-{rol}.png) depende de este id, asi que tiene que
    conocerse de antemano -- ver subirFirmaTraslado en apps/mobile/api.ts."""

    id: str
    punto_origen_id: str
    punto_destino_id: str
    transportador_nombre: str
    fecha: date
    observaciones: str | None = None
    items: list[ItemTrasladoCrear] = Field(min_length=1)
    firma_despacha_url: str
    firma_transporta_url: str
    # usuario_punto de quien despacha (bodega origen) -- debe pertenecer al
    # punto_origen_id (ver crear_traslado en app/services/traslados_puntos.py).
    creado_por: str
    # Numero impreso en el talonario fisico (ej. "00231", "A-00231") -- lo
    # tipea quien despacha, es lo primero que copia del papel. Obligatorio
    # solo al crear -- los traslados existentes antes de este campo quedan
    # con numero_talonario null (ver app/db.py) y siguen funcionando igual.
    numero_talonario: str
    # Foto del talonario de la que se leyeron los datos (ver extraer_talonario).
    foto_talonario_url: str

    @field_validator("numero_talonario")
    @classmethod
    def _numero_talonario_valido(cls, v: str) -> str:
        return _validar_numero_talonario(v)


class LlegadaDirectaCrear(BaseModel):
    """Payload de POST /traslados-puntos/llegada-directa -- mercancia que llega
    directo del proveedor al punto (sin origen, sin transportador ni quien
    despacha). La registra el propio punto que recibe: consume una hoja de SU
    talonario y firma solo quien recibe. Nace ya recibida (ver
    crear_llegada_directa en app/services/traslados_puntos.py).

    `id` lo genera el celular, igual que en TrasladoPuntoCrear: el path de la
    firma en Storage (firmas-traslados/{id}-recibe.webp) se arma antes de crear."""

    id: str
    # Punto que recibe (el logueado); el talonario que se consume es el suyo.
    punto_id: str
    # usuario_punto de quien registra y firma; debe pertenecer a punto_id.
    creado_por: str
    # Fecha de la hoja; sin ella se usa la de hoy.
    fecha: date | None = None
    numero_talonario: str
    foto_talonario_url: str
    # Puede venir vacia si la hoja trae solo texto libre (contenido_texto);
    # crear_llegada_directa rechaza el caso en que ambos esten vacios.
    items: list[ItemTrasladoCrear] = Field(default_factory=list)
    # Texto libre de la hoja, tal como lo leyo la IA o lo corrigio el operador.
    contenido_texto: str | None = None
    firma_recibe_url: str
    # Debe viajar en true: quien recibe acepto la declaracion antes de firmar.
    declaracion_aceptada: bool
    # Opcional: si trae texto la llegada queda 'recibido_con_novedad' y entra al
    # flujo de Supervision.
    novedad: str | None = None

    @field_validator("numero_talonario")
    @classmethod
    def _numero_talonario_valido(cls, v: str) -> str:
        return _validar_numero_talonario(v)


class ItemRecepcion(BaseModel):
    """Linea confirmada en la recepcion -- si 'Llego completo' quedo tildado
    en el movil, cantidad_recibida viaja igual a la cantidad enviada (no hay
    un modo implicito de 'no tocar'), asi el backend siempre valida contra un
    numero explicito."""

    id: str
    cantidad_recibida: int = Field(ge=0)
    novedad: str | None = None


class RecepcionTraslado(BaseModel):
    """Payload de POST /traslados-puntos/{id}/recepcion."""

    items: list[ItemRecepcion] = Field(min_length=1)
    novedad: str | None = None
    firma_recibe_url: str
    # usuario_punto de quien recibe (bodega destino).
    recibido_por: str
    # El movil la manda en true al firmar tras revisar cada producto. Opcional
    # para no romper builds viejos de la app (que no la envian).
    declaracion_aceptada: bool = False


class SolucionNovedad(BaseModel):
    """Payload de POST /traslados-puntos/{id}/solucion -- Supervision marca
    una novedad como resuelta (ver resolver_novedad en
    app/services/traslados_puntos.py). `solucion` es obligatoria (no tiene
    sentido resolver sin explicar que se hizo); se recorta y se limita para
    no guardar un texto gigante por error.

    El consecutivo (codigo de punto + numero, ej. "NPT-1234") es bajo que
    numero queda archivada la solucion -- Erika lo busca despues para volver
    a esa novedad sin tener que recordar el traslado. Solo el formato se
    valida aca (mayusculas, digitos); que el codigo exista y este activo se
    valida contra la tabla puntos en resolver_novedad, que necesita el pool
    async."""

    supervisor_id: str
    solucion: str
    consecutivo_codigo: str
    # Solo digitos -- se guarda tal cual se escribio (sin sacar ceros a la
    # izquierda), para que el numero que Erika anoto a mano coincida siempre
    # con el que queda buscable.
    consecutivo_numero: str

    @field_validator("solucion")
    @classmethod
    def _solucion_valida(cls, v: str) -> str:
        texto = v.strip()
        if not texto:
            raise ValueError("La solución no puede estar vacía")
        if len(texto) > 2000:
            raise ValueError("La solución es demasiado larga (máximo 2000 caracteres)")
        return texto

    @field_validator("consecutivo_codigo")
    @classmethod
    def _consecutivo_codigo_valido(cls, v: str) -> str:
        texto = v.strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{1,10}", texto):
            raise ValueError("El código de punto del consecutivo no es válido")
        return texto

    @field_validator("consecutivo_numero")
    @classmethod
    def _consecutivo_numero_valido(cls, v: str) -> str:
        texto = v.strip()
        if not re.fullmatch(r"\d{1,10}", texto):
            raise ValueError("El número del consecutivo debe tener solo dígitos (1 a 10)")
        return texto


_MSG_SYSCAFE = (
    "El número Syscafe debe tener el formato CÓDIGO-NÚMERO (ej. NBR-945): "
    "2 a 4 letras o números empezando por letra, un guion y de 1 a 7 dígitos"
)
_SYSCAFE_CON_SEPARADOR = re.compile(r"([A-Z][A-Z0-9]{1,3})[\s\-]+(\d{1,7})")
# Sin separador solo se acepta un codigo de 3 a 4 letras ("NBR945"): con 2 letras
# o con digitos en el codigo ("TF15832") no se sabe donde termina el codigo
# ("TF1-5832" o "TF-15832"), asi que se pide el guion.
_SYSCAFE_SIN_SEPARADOR = re.compile(r"([A-Z]{3,4})(\d{1,7})")


def normalizar_numero_syscafe(valor: str | None) -> str | None:
    """Normaliza el numero Syscafe a "CODIGO-NUMERO" (mayusculas, sin espacios
    sobrantes). Acepta "NBR-945", "nbr 945" y "NBR945"; None o vacio devuelve
    None (borra el valor). Cualquier otra cosa lanza ValueError."""
    texto = re.sub(r"\s+", " ", (valor or "").strip().upper())
    if not texto:
        return None
    coincidencia = _SYSCAFE_CON_SEPARADOR.fullmatch(texto) or _SYSCAFE_SIN_SEPARADOR.fullmatch(texto)
    if coincidencia is None:
        raise ValueError(_MSG_SYSCAFE)
    return f"{coincidencia.group(1)}-{coincidencia.group(2)}"


class AsignarSyscafeDashboard(BaseModel):
    """Payload de PATCH /traslados-puntos/{id}/syscafe/dashboard -- el actor
    sale de la sesion del dashboard. numero_syscafe vacio o null borra el valor."""

    # Se normaliza y valida en el router (ver _asignar_syscafe), no con un
    # validador de pydantic: un ValueError ahi responderia el 422 con `detail`
    # como lista y el movil necesita un texto.
    numero_syscafe: str | None = None


class AsignarSyscafe(AsignarSyscafeDashboard):
    """Payload de PATCH /traslados-puntos/{id}/syscafe (movil) -- Supervision
    manda su id, mismo modelo de confianza que SolucionNovedad (el PIN se
    verifico en el login)."""

    supervisor_id: str
