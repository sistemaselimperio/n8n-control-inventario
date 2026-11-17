# Flujos de n8n

Referencia de los workflows de orquestación descritos en la
[arquitectura](../../docs/architecture.md) (Workflows 1 y 2) más el de
monitoreo (Workflow 3, no está en el diagrama). n8n no reimplementa la
lógica de negocio (eso vive en `apps/backend`) — orquesta el trigger, las
llamadas externas y las notificaciones alrededor de ella.

**`pipeline-despacho.json`** y **`monitoreo-salud.json`** en esta misma
carpeta son exports reales e importables (Workflows → Import from File en la
UI de n8n) de los Workflows 1 y 3 descritos abajo — el primero sin
credenciales de Slack/Email reales (esos nodos vienen como `NoOp`, listos
para reemplazar). El Workflow 2 (cron de turnos) no se versiona como JSON
porque es un `Schedule Trigger` + `Execute Command` directo, más simple de
armar a mano siguiendo la tabla de abajo.

## Workflow 1 — Pipeline de despacho

Corresponde a la Figura 1 del diagrama de arquitectura. Se dispara cuando un
operador sube una foto desde la app móvil.

| # | Nodo | Tipo | Qué hace |
|---|---|---|---|
| 1 | `Webhook: foto subida` | Webhook Trigger | Recibe `{ evidencia_url, hash_evidencia, sede_origen_id, operador_id, capturado_at }` una vez que la app móvil confirma la subida a Storage. |
| 2 | `HTTP: procesar entrega` | HTTP Request | `POST` al backend: `{{$env.API_BASE_URL}}/entregas/procesar` con el body del webhook — **paso 1** del flujo de dos pasos (ver abajo). El backend ejecuta extracción por IA, identifica el documento y responde `{ id, situacion, estado, items }` sin pedir cantidades todavía. |
| 3 | `IF: estado` | IF | Rama según la respuesta: `$json.detail` existe → hubo error (409 nada pendiente / 422 falló la IA); si no, `$json.estado === 'pendiente_revision'` → notificar supervisor; si no, seguir. |
| 4a | `Notificar: revisión manual` | Slack / Email / WhatsApp Business | Aviso al supervisor de la sede con el link a la entrega en el dashboard. |
| 4b | `Notificar: duplicado o error` | Slack / Email | Aviso si `/procesar` devolvió error — ej. el documento ya estaba entregado por completo (nada pendiente que actualizar). |
| 5 | `Respond to Webhook` | Respond to Webhook | Devuelve el resultado (id/situacion/estado/items) a quien haya llamado al webhook. |

**Ojo — este workflow solo cubre el paso 1.** El **paso 2** (confirmar
cantidades por producto: `PATCH /entregas/{id}/items`, ver
`apps/backend/app/routers/entregas.py`) lo llama la app móvil directo contra
el backend, no a través de n8n — no hay notificación ni nodo para eso acá.
Si en el futuro se quiere que n8n también medie el paso 2, hace falta un
segundo webhook + nodo HTTP apuntando a `/entregas/{id}/items`.

**Reintentos:**
- `HTTP: procesar entrega` tiene `retryOnFail` (3 intentos, 2s entre cada uno)
  configurado en `pipeline-despacho.json` — absorbe caídas transitorias de
  red/conexión contra el backend (ej. el VPS reiniciando a mitad de un
  deploy). El nodo usa `neverError: true` para poder ramificar sobre
  respuestas de negocio (409 duplicado, 422 validación) sin que n8n las trate
  como fallo, así que estos reintentos solo se disparan ante errores reales
  de conexión, no ante esos códigos de estado — reintentarlos no tendría
  sentido, van a fallar siempre igual.
- La IA de visión (`apps/backend/app/services/vision.py`) **no necesita**
  reintento acá: el cliente de OpenAI (`openai==1.59.6`) ya reintenta solo,
  con backoff exponencial + jitter, ante 408/409/429/5xx y errores de
  conexión/timeout (`max_retries=2` por defecto = 3 intentos totales). Si
  `/entregas/procesar` devuelve 422 con detail de extracción, es porque ya se
  agotaron esos intentos del lado del backend (o el modelo rechazó la imagen).
  Ojo: el backend usa 422 a propósito acá y no 502/503/504 -- en EasyPanel el
  proxy (Traefik) interceptaba esos tres códigos y los reemplazaba por su
  propia página de "Service is not reachable", tapando el `detail` real. En
  Dokploy (VPS actual) no está confirmado si Traefik se comporta igual --
  verificar antes de asumir que este workaround sigue haciendo falta.

## Workflow 2 — Analítica semanal de turnos

Corresponde a la Figura 2. Se dispara por cron, no por evento.

| # | Nodo | Tipo | Qué hace |
|---|---|---|---|
| 1 | `Cron: semanal` | Schedule Trigger | Ej. todos los lunes 03:00, zona horaria de la sede. |
| 2 | `Execute Command` | Execute Command | Corre `python -m scripts.generar_turnos` dentro del entorno del backend (ver `apps/backend/scripts/generar_turnos.py`), que agrega `entregas`, calcula percentiles y escribe en `shift_recommendations`. |
| 3 | `HTTP: obtener recomendaciones` | HTTP Request | `GET {{$env.API_BASE_URL}}/turnos/recomendaciones` para armar el mensaje de notificación. |
| 4 | `Notificar: RRHH/supervisores` | Slack / Email | Envía el resumen de bloques sugeridos por sede. |

## Workflow 3 — Monitoreo de salud

`monitoreo-salud.json` en esta misma carpeta es un export real e importable.
No forma parte del pipeline de despacho — corre en paralelo, cada 5 minutos,
para detectar si el backend se cayó.

| # | Nodo | Tipo | Qué hace |
|---|---|---|---|
| 1 | `Cron: cada 5 minutos` | Schedule Trigger | Dispara el chequeo periódicamente. |
| 2 | `HTTP: chequear salud` | HTTP Request | `GET {{$env.API_BASE_URL}}/health`, timeout 10s. Usa `onError: continueErrorOutput` — cualquier falla (timeout, conexión rechazada, backend caído) sale por la rama de error en vez de cortar el workflow. |
| 3 | `HTTP: registrar caida en logs` | HTTP Request | Solo corre si el paso 2 falló. Inserta un evento `health_check_fallido` directo contra la REST API de Supabase (`POST {{$env.SUPABASE_URL}}/rest/v1/logs`) — **no** le pide al backend que se loguee a sí mismo, porque si está caído no puede. Queda visible en la sección de auditoría del dashboard como cualquier otro evento. |

**Por qué REST de Supabase y no un nodo Postgres:** mismo tipo de nodo
(`httpRequest`) que ya usa el resto de los workflows — nada de credenciales
nuevas que configurar en n8n aparte de las dos variables de entorno de abajo.

**Por qué no hay notificación push (email/Slack/etc.):** decisión explícita
para no depender de un canal nuevo a configurar. Si más adelante querés que
además avise en vivo (Telegram es gratis y rápido de armar), se agrega un
nodo más después de `HTTP: registrar caida en logs`.

## Variables de entorno de n8n

| Variable | Ejemplo | Usada por |
|---|---|---|
| `API_BASE_URL` | `https://backend-1bs8jn-dbe94c-169-58-200-185.sslip.io` | Workflows 1, 2, 3 |
| `SUPABASE_URL` | `https://hfxhhkbgwxutcxpxpfxu.supabase.co` | Workflow 3 |
| `SUPABASE_SECRET_KEY` | (secreto — `apps/backend/.env`) | Workflow 3 |
| `SLACK_WEBHOOK_URL` / credencial Slack | — | Workflow 1 (pendiente) |
