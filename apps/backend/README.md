# Backend — Control Logístico Multi-Sede

API en FastAPI que implementa el pipeline de la [Figura 1 del diagrama de arquitectura](../../docs/architecture.md): captura → extracción por IA de visión → validación por confianza → chequeo de duplicados entre sedes → persistencia en Postgres (Supabase) → registro de auditoría.

## Setup

```bash
cd apps/backend
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
copy .env.example .env        # y completar DATABASE_URL, OPENAI_API_KEY, etc.
```

`DATABASE_URL` es la conexión **directa** (no el pooler transaccional de PgBouncer) de un proyecto Supabase — `POSTGRES_URL_NON_POOLING` en las variables que Supabase/Vercel inyectan. El backend mantiene su propio pool de `asyncpg` de larga duración, así que no necesita pasar por PgBouncer.

## Correr en desarrollo

```bash
uvicorn app.main:app --reload --port 8000
```

El schema (tablas + índice único anti-duplicado) se crea automáticamente al arrancar (`ensure_schema()` en `app/db.py`) — no hace falta correr migraciones a mano.

Docs interactivas: http://localhost:8000/docs

## Tests

```bash
pip install -r requirements-dev.txt          # pytest + pytest-asyncio, sobre requirements.txt
python -m pytest -m "not integration"        # unitarios: sin base de datos, OpenAI simulado
python -m pytest                             # todo; las de integración se omiten sin TEST_DATABASE_URL
```

- **Unitarios** (`tests/unit`): simulan el pool de `asyncpg` (`tests/fakes.py`) y el cliente de OpenAI; no leen el `.env` ni abren conexiones. Cubren la compuerta de confianza, `procesar_extraccion()`, `aplicar_actualizacion_items()`, el login por PIN, la guardia `X-Admin-Token`, las sesiones Bearer del dashboard, los modelos Pydantic y la bitácora `logs`.
- **Integración** (`tests/integration`, marcadas `@pytest.mark.integration`): corren el `ensure_schema()` real contra el Postgres de `TEST_DATABASE_URL` (carrera entre sedes, deltas concurrentes, restricciones de la base). **Truncan todas las tablas**: usa un Postgres desechable, nunca Supabase. Ej.: `docker run --rm -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:17` y `TEST_DATABASE_URL=postgresql://postgres:pg@localhost:5433/postgres`.
- CI: `.github/workflows/backend-tests.yml` (informativo, no bloquea merges).

## Endpoints principales

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/entregas/procesar` | Recibe `evidencia_url` + metadata de la app móvil, ejecuta el pipeline completo |
| `GET` | `/entregas?sede_id=...` | Lista entregas (para el dashboard) |
| `GET` | `/logs?entidad_id=...` | Consulta de auditoría |
| `POST` / `GET` | `/sedes` | CRUD básico de sedes |
| `POST` / `GET` | `/turnos` | CRUD de turnos |
| `GET` | `/turnos/recomendaciones` | Sugerencias generadas por el job semanal |

## Job de analítica de turnos

Corresponde a la Figura 2 del diagrama. Ejecutar semanalmente (cron de n8n, Task Scheduler, `crontab`):

```bash
python -m scripts.generar_turnos
```

## Vaciar los datos de prueba

```bash
python -m scripts.limpiar_datos       # pide confirmar ("si")
python -m scripts.limpiar_datos --si  # sin confirmar
```

Borra todas las `entregas`, `logs` y las fotos del bucket `evidencia` — deja el sistema como recién instalado. No toca `sedes`/`empleados`/`turnos`.

## Notas de arquitectura

- El **bloqueo de duplicados** no depende solo de la lógica de la app: `app/db.py` define un `unique (numero_guia, remitente)` en la tabla `entregas`, que es la barrera real (ver `services/duplicates.py`, que captura `asyncpg.UniqueViolationError`).
- La **sincronización en tiempo real** hacia los dashboards de cada sede se resuelve con **Supabase Realtime** (replicación lógica de Postgres) — `ensure_schema()` agrega `entregas`/`logs` a la publicación `supabase_realtime`, y el dashboard se suscribe directo a esas tablas (`apps/dashboard/src/lib/supabase.ts`) sin un relay propio que mantener. El polling de 5s sigue activo como red de seguridad si el socket se corta.
- La **IA de visión** (`services/vision.py`) usa salida estructurada (`response_format` `json_schema`, modo `strict`) de la API de OpenAI (`VISION_MODEL`, por defecto `gpt-5.6-luna` — ~$0.0003 por foto), no parsing de texto libre.
- Conexión provisionada vía Marketplace de Vercel (`vercel integration add supabase`), que generó el proyecto Supabase y los env vars automáticamente.
