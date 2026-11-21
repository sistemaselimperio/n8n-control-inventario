# Arquitectura: Sistema de Control Logístico Multi-Sede con IA

> Diagrama de referencia (flujo de despacho + job de turnos): https://claude.ai/code/artifact/b0d0b9f0-a91b-419f-aebb-42e927af3e4f

## Contexto

Sistema de control logístico y gestión de entregas multi-sede que:

- Elimina digitación manual capturando datos de guías/remisiones por foto + IA.
- Evita despachos duplicados entre sedes mediante una base de datos centralizada en tiempo real con trazabilidad.
- Sugiere turnos óptimos del personal a partir de analítica predictiva sobre el histórico de entregas.
- Registra logs de cada evento (captura, extracción, cruce de sedes).

Parámetros de diseño:

- **IA de visión:** LLM multimodal (OpenAI GPT-4o, vision) — no OCR de plantilla fija, porque las guías varían de formato entre sedes/proveedores.
- **App de operadores:** Móvil nativa (React Native + Expo).
- **Escala inicial:** 2 a 5 sedes, <500 entregas/día. Arquitectura simple y barata de operar, sin bloquear crecimiento futuro.
- **Base de datos:** Supabase (Postgres) — un solo proveedor cubre base de datos, storage, auth y tiempo real (Realtime), en vez de estar armando esas cuatro piezas por separado.

## 1. Arquitectura de la solución (stack)

**App móvil (operadores)** — `apps/mobile`
- React Native + Expo: cámara nativa, un solo código base, EAS Build/OTA updates.
- Offline-first ligero: cola local para fotos capturadas sin señal (pendiente de implementar — ver TODO en `apps/mobile/api.ts`).

**Backend / API** — `apps/backend`
- FastAPI (Python): orquesta la subida, la llamada a IA, la validación/normalización, la escritura en DB y el logging.

**IA de extracción (Data Entry por Visión)**
- OpenAI (`VISION_MODEL`, por defecto `gpt-5.6-luna`) vía API, con salida estructurada (`response_format` de tipo `json_schema`, modo `strict`) forzando un JSON schema fijo.
- Score de confianza por campo; si es bajo o faltan campos críticos → estado `pendiente_revision`.

**Base de datos (multi-sede, tiempo real)** — provisionada vía Marketplace de Vercel (`vercel integration add supabase`)
- Supabase (Postgres): `unique (tipo, indicativo_numero)` que bloquea duplicados a nivel de base de datos (ej. no puede haber dos "FEI 10254"), y Supabase Realtime (replicación lógica de Postgres) para notificar en tiempo real a todas las sedes sin un relay propio.

**Almacenamiento de evidencia**
- Object storage — la DB solo guarda URL + hash SHA-256. Candidato natural: Supabase Storage (mismo proyecto, sin un proveedor aparte), o S3/R2/GCS si se prefiere separar responsabilidades.

**Orquestación** — `n8n/workflows`
- n8n: recibe el webhook "foto subida", llama al backend (que a su vez llama a la IA, valida, escribe en Supabase), dispara notificaciones y corre el job semanal de turnos.

**Dashboard administrativo** — `apps/dashboard`
- Next.js: entregas en tiempo real (Supabase Realtime), alertas de duplicado, logs.

## 2. Flujo de automatización (paso a paso)

Un documento puede traer varios productos, y un mismo documento puede pasar por más de una
visita (se entrega una parte, después el resto) — por eso el flujo es de **dos pasos**:

1. **Captura**: operador en Sede A fotografía la guía; la app adjunta `sede_id`, `operador_id`, timestamp.
2. **Subida**: imagen a object storage; se genera hash SHA-256.
3. **Trigger**: evento "imagen subida" dispara webhook a n8n (o la app móvil llama directo al backend).
4. **Extracción IA**: se llama al LLM de visión con la imagen + schema JSON; se recibe el tipo de documento (FEI/TB/RM3/RM2/RSF), indicativo/número, y la lista de productos (descripción + cantidad), + confianza por campo.
5. **Identificación (paso 1, `POST /entregas/procesar`)**: se busca el documento por tipo+indicativo/número.
   - No existía → se inserta atómicamente con sus productos (nada pendiente confirmado todavía).
   - Existía y algún producto tiene pendiente > 0 → se devuelve para actualizar (situación `actualizable`), sin escribir nada nuevo.
   - Existía y todo está en pendiente = 0 → bloqueado (409), se registra en `logs`, se notifica.
6. **Confirmación (paso 2, `PATCH /entregas/{id}/items`)**: el bodeguero ve los productos en la app y confirma cuánto quedó pendiente (documento nuevo) o cuánto entregó hoy (actualización — se suma/resta atómicamente en SQL para no perder una actualización si dos sedes confirman casi al mismo tiempo). Cualquier sede puede confirmar una actualización, no solo la que registró el documento originalmente.
7. **Validación automática**: confianza alta en tipo/indicativo → `procesada`; confianza baja → `pendiente_revision` + notificación (independiente de si es un documento nuevo o una actualización).
8. **Propagación en tiempo real**: Supabase Realtime en `entregas`/`entrega_items` actualiza dashboards/apps.
9. **Logging**: cada paso anterior escribe un evento inmutable en `logs`.
10. **Job de turnos**: semanalmente, `apps/backend/scripts/generar_turnos.py` corre la analítica predictiva y genera `shift_recommendations`.

Ver el diagrama enlazado arriba para el flujo visual completo, incluyendo las ramas de confianza baja y duplicado bloqueado.

## 3. Modelo de datos (tablas Postgres)

```
sedes            (id uuid pk, nombre, codigo unique, direccion, timezone, activa, created_at)
empleados        (id uuid pk, nombre, sede_id, rol, estado, created_at)
usuarios_dashboard (id uuid pk, usuario unique, nombre, rol admin|supervisor|consulta, pass_hash, pass_salt,
                   activo, intentos_fallidos, bloqueado_hasta, ultimo_login_at)  -- login del dashboard, fuera de realtime
entregas         (id uuid pk, tipo, indicativo_numero, hash_evidencia unique, sede_origen_id,
                   estado, confianza_ia jsonb, evidencia_url, operador_id, capturado_at,
                   procesado_at, actualizado_at)
                  -- identidad del documento -- un producto puede traer varios items, ver abajo
                  -- evidencia_url/hash_evidencia son los de la visita mas reciente
                  -- tipo in ('FEI', 'TB', 'RM3', 'RM2', 'RSF'): factura, traslado o remision
                  -- unique (tipo, indicativo_numero)  ← barrera anti-duplicado real (ej. "FEI 10254")
entrega_items    (id uuid pk, entrega_id fk -> entregas, descripcion,
                   cantidad_entregada, cantidad_pendiente, creado_at, actualizado_at)
                  -- un documento puede traer varios productos; cada visita que confirma
                  -- cantidades actualiza estos items (PATCH /entregas/{id}/items)
turnos                (id uuid pk, empleado_id, sede_id, fecha, hora_inicio, hora_fin, origen)
shift_recommendations (id uuid pk, sede_id, semana_iso, bloques_sugeridos jsonb, generado_at, modelo_usado)
                       -- unique (sede_id, semana_iso)
facturas_faltantes    (id uuid pk, tipo, indicativo_numero, sede_id, reportado_por, reportado_at, estado, entrega_id fk -> entregas, cerrada_at, cerrada_por)
                       -- bodega reporta una factura que el mostrador aun no subio; se resuelve sola al insertarse en entregas
                       -- unique parcial (tipo, indicativo_numero) where estado = 'pendiente'
logs (append-only)    (id uuid pk, evento, entidad_tipo, entidad_id, actor_id, sede_id, resultado, detalle jsonb, timestamp)
puntos                (… + es_interna bool, alias text[])  -- bodega propia (TB8, TB9, TBE, TB): su lado de un traslado no genera comprobante;
                                                           -- alias: otros nombres con que el PDF escribe el punto (solo coincidencia exacta)
usuarios_dashboard    (… + punto_id fk -> puntos, cedula)  -- punto: solo ve/firma lo de ese punto; cedula: la que firma
traslados             (id uuid pk, numero, archivo_nombre, pdf_ruta, estado borrador|enviado, advertencias jsonb,
                       origen_punto_id, destino_punto_id, origen_texto, destino_texto, items jsonb, archivos jsonb, creado_por, …)
                       -- un PDF "TRASLADO ENTRE BODEGAS"; borrador = falta numero/origen/destino (advertencias), no se adivina
traslado_comprobantes (id uuid pk, traslado_id fk on delete cascade, numero, tipo salida|ingreso, punto_id fk, estado pendiente|confirmado|devuelto,
                       responsable_usuario_id/nombre/cedula, firma_ruta, observacion, motivo_devolucion, resuelto_at, …)
                       -- unique (numero, punto_id, tipo) = barrera anti-duplicado; unique (traslado_id, tipo)
```

DDL exacto: `apps/backend/app/db.py` (`_SCHEMA`, aplicado automáticamente al arrancar). Modelos de request/response (Pydantic): `apps/backend/app/models/`.

### Módulo Traslados (comprobantes de salida e ingreso)

Reemplaza al módulo retirado de traslados entre puntos (que sigue en el backend por la app móvil oculta).
Código: `app/routers/traslados.py` (`/traslados/...`), `app/services/traslados.py` (base y Storage),
`app/services/traslados_reglas.py` (reglas puras) y `app/services/permisos_traslados.py` (perfiles).

1. La encargada sube uno o varios PDFs "TRASLADO ENTRE BODEGAS" (`POST /traslados/subir`). El parser de
   `pdf_traslado_bodega.py` (texto, sin IA) lee número, "Bodega:" (origen) y "Destino:" (destino); cada una se
   busca entre los `puntos` por código o nombre. Un alias (`puntos.alias`, editable en `/creador`) cuenta como el
   nombre del punto solo en coincidencia exacta, nunca parcial; si dos puntos coinciden, queda `borrador`. El
   alias no puede repetir el nombre ni el alias de otro punto activo (409). `ensure_schema()` siembra una sola vez
   el alias, BV (interna), VET como interna y GUA.
2. Cada PDF es un `traslado` con hasta dos `traslado_comprobantes`: SALIDA para el origen e INGRESO para el
   destino. Un lado cuyo punto es `es_interna` no genera comprobante. Si falta número, origen o destino queda en
   `borrador` con `advertencias`; la encargada lo completa (`PATCH`) y lo envía (`POST .../enviar`).
3. Duplicados: `unique (numero, punto_id, tipo)`; un archivo repetido se reporta `duplicado` y no crea nada
   (la carrera entre dos cargas cae en `UniqueViolationError`, igual que `duplicates.py`).
4. Estados de un comprobante: `pendiente -> confirmado | devuelto`; `devuelto -> pendiente` (reenviar);
   `confirmado -> devuelto` (solo encargada/admin). Salida e ingreso son independientes.
5. Perfiles (rol + área + punto del usuario del dashboard): admin (todo); encargada = supervisor área `traslados`
   sin punto (sube, completa, envía, devuelve confirmados, corrige/reenvía, borra); usuario de punto = supervisor
   área `traslados` con punto (solo su punto: confirma con firma obligatoria o devuelve con motivo, firmando con su
   cédula); lectura = consulta de `traslados` y supervisor/consulta de `todo`; área `bodega` no entra. Solo sesión
   Bearer, no se acepta el token legacy.
6. Cada acción escribe un evento inmutable en `logs` (`traslado_*`, `traslado_comprobante_*`); el historial de un
   comprobante se lee de ahí. El borrado definitivo elimina filas y archivos de Storage (PDFs y firmas, listados en
   `traslados.archivos`) pero no toca `logs`.

## 4. Viabilidad y riesgos

| Riesgo | Mitigación |
|---|---|
| Calidad de imagen (borrosa, mal iluminada) | Validación de nitidez en el cliente antes de subir, guía visual de encuadre |
| Latencia de la IA de visión | Subida asíncrona: confirmación instantánea + notificación push con el resultado |
| Falsos positivos/negativos en duplicados | Restricción `unique` a nivel de DB (`tipo` + `indicativo_numero`) + `hash_evidencia` único como respaldo |
| Condición de carrera entre 2 sedes casi simultáneas | `INSERT` atómico contra el `unique` constraint como barrera final; Postgres rechaza el segundo insert con `UniqueViolationError` (`app/services/duplicates.py`) |
| Costo/rate limits del proveedor de IA | El cliente de OpenAI reintenta solo con backoff exponencial ante 429/5xx/timeouts (`max_retries` del SDK); `HTTP: procesar entrega` en n8n reintenta ante caídas de conexión contra el backend (`retryOnFail` en `pipeline-despacho.json`). Cachear por hash de imagen sigue pendiente |
| Conectividad intermitente en sede | Cola offline con idempotency key por captura (pendiente en `apps/mobile`) |
| Poco histórico para el modelo de turnos | Empezar con percentiles simples (implementado), avanzar a forecasting estacional con ≥2-3 meses de datos |

## Estructura del repositorio

```
apps/
  mobile/      React Native + Expo — captura del operador
  backend/     FastAPI — pipeline, API, job de turnos
  dashboard/   Next.js — panel en tiempo (casi) real
n8n/
  workflows/   Documentación de los flujos de orquestación
docs/
  architecture.md  Este documento
```
