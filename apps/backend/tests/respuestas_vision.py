"""Respuestas de ejemplo del modelo de vision (OpenAI), ya validadas contra
_EXTRACTION_SCHEMA. Se usan para guionar el cliente falso: la API real nunca
se llama desde los tests."""

ALTA_CONFIANZA = {
    "tipo": "FEI",
    "indicativo_numero": "10254",
    "concepto": "",
    "items": [{"descripcion": "75936  SAL BLANCA * 40 KILOS", "cantidad": 3}],
    "confianza": {"tipo": 0.98, "indicativo_numero": 0.97, "items": 0.95},
}

# Entre min_confidence_rechazo (0.35) y min_confidence (0.75): se persiste,
# pero queda en pendiente_revision.
BAJA_CONFIANZA = {
    "tipo": "XYZ",
    "indicativo_numero": "881",
    "concepto": "",
    "items": [{"descripcion": "ARROZ", "cantidad": 2}],
    "confianza": {"tipo": 0.9, "indicativo_numero": 0.5, "items": 0.8},
}

# Por debajo de min_confidence_rechazo: la foto se rechaza sin crear registro.
ILEGIBLE = {
    "tipo": "",
    "indicativo_numero": "",
    "concepto": "",
    "items": [],
    "confianza": {"tipo": 0.1, "indicativo_numero": 0.1, "items": 0.1},
}

VARIOS_ITEMS = {
    "tipo": "XYZ",
    "indicativo_numero": "5501",
    "concepto": "",
    "items": [
        {"descripcion": "10001  AZUCAR * 50", "cantidad": 4},
        {"descripcion": "10002  SAL * 25", "cantidad": 10},
        {"descripcion": "ACEITE 1L", "cantidad": 6},
    ],
    "confianza": {"tipo": 0.95, "indicativo_numero": 0.95, "items": 0.9},
}

# Contenido que no es JSON valido (respuesta truncada del modelo).
MALFORMADA = '{"tipo": "FEI", "indicativo_numero": "10254", "items": ['
