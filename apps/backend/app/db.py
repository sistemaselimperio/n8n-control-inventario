import json

import asyncpg

from app.config import get_settings

_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    # Codec para que json/jsonb viajen como dict/list de Python en vez de
    # texto crudo — evita json.dumps/loads repetido en cada query.
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )
    await conn.set_type_codec(
        "json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )

# El indice unico sobre (tipo, indicativo_numero) es la barrera real contra
# duplicados entre sedes: la validacion en la app es UX, esta es la que no
# se puede saltar (ver app/services/duplicates.py).
_SCHEMA = """
create extension if not exists pgcrypto;

create table if not exists sedes (
    id uuid primary key default gen_random_uuid(),
    nombre text not null,
    codigo text not null unique,
    direccion text not null default '',
    timezone text not null default 'America/Bogota',
    activa boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists empleados (
    id uuid primary key default gen_random_uuid(),
    nombre text not null,
    sede_id text not null,
    rol text not null default 'operador' check (rol in ('operador', 'supervisor', 'admin')),
    estado text not null default 'activo',
    pin_hash text,
    pin_salt text,
    created_at timestamptz not null default now()
);

-- Columnas agregadas despues del primer deploy: CREATE TABLE IF NOT EXISTS
-- no altera una tabla que ya existe, asi que las agregamos aparte (idempotente).
alter table empleados add column if not exists pin_hash text;
alter table empleados add column if not exists pin_salt text;

-- Roles agregados despues del primer deploy: 'punto_venta' factura primero
-- (crea la entrega como "nueva"), el bodeguero ('operador') solo puede
-- re-fotografiar un documento que punto_venta ya facturo -- ver
-- FacturacionRequerida en duplicates.py. 'faia_viewer' es de solo lectura,
-- ve las fotos marcadas es_faia (GET /entregas/faia), no crea ni confirma
-- nada. El check constraint no es CREATE TABLE IF NOT EXISTS, asi que para
-- ampliar la lista de valores permitidos sobre una base ya existente se
-- dropea y se recrea con el nombre por default de Postgres para un check
-- inline (<tabla>_<columna>_check) -- mismo tipo de ajuste que el drop del
-- check de "tipo" en entregas, pero aca hace falta reponerlo con la lista
-- ampliada en vez de sacarlo del todo.
alter table empleados drop constraint if exists empleados_rol_check;
alter table empleados add constraint empleados_rol_check
    check (rol in ('operador', 'supervisor', 'admin', 'punto_venta', 'faia_viewer'));

create table if not exists entregas (
    id uuid primary key default gen_random_uuid(),
    tipo text not null default 'FEI',
    indicativo_numero text not null default '',
    hash_evidencia text not null unique,
    sede_origen_id text not null,
    estado text not null default 'pendiente_revision'
        check (estado in ('procesada', 'pendiente_revision', 'duplicado_bloqueado')),
    confianza_ia jsonb not null default '{}',
    evidencia_url text not null,
    operador_id text not null,
    capturado_at timestamptz not null,
    procesado_at timestamptz,
    actualizado_at timestamptz not null default now()
);

create index if not exists idx_entregas_sede_capturado
    on entregas (sede_origen_id, capturado_at desc);

-- Rango de fechas sin filtro de sede (ver GET /ranking/productos) -- el
-- indice de arriba no sirve solo cuando no hay sede_origen_id en el where.
create index if not exists idx_entregas_capturado_at on entregas (capturado_at);

-- Un documento puede traer varios productos, cada uno con su propia cantidad
-- (ver app/services/duplicates.py). Reemplaza los campos unicos
-- cantidad_entregada/cantidad_pendiente/detalle que tenia "entregas" antes.
create table if not exists entrega_items (
    id uuid primary key default gen_random_uuid(),
    entrega_id uuid not null references entregas(id) on delete cascade,
    descripcion text not null default '',
    cantidad_entregada integer not null default 0,
    cantidad_pendiente integer not null default 0,
    creado_at timestamptz not null default now(),
    actualizado_at timestamptz not null default now()
);

create index if not exists idx_entrega_items_entrega on entrega_items (entrega_id);

-- Nota manual por producto (una sola, se sobreescribe) -- info adicional que
-- carga el bodeguero (ej. "llego danado", "faltan 2 cajas"), no viene de la IA.
alter table entrega_items add column if not exists nota text;

-- Quien cerro el item (pendiente 0): entregado_por es el id del actor, mismo
-- formato que operador_id (puede ser "dashboard:<usuario>"); el flag marca que
-- lo entrego el punto de venta y no bodega. Se reescriben en cada confirmacion
-- (si el item se reabre quedan en null/false).
alter table entrega_items add column if not exists entregado_por text;
alter table entrega_items add column if not exists entregado_en_punto_venta boolean not null default false;
alter table entrega_items add column if not exists entregado_en_otra_bodega boolean not null default false;

-- Migracion desde el modelo anterior (numero_guia/remitente/destinatario/items,
-- duplicado por numero_guia+remitente) al modelo de documentos (tipo +
-- indicativo/numero, cantidad entregada/pendiente). Idempotente: corre igual
-- de bien contra una DB nueva que contra una que ya tenia el esquema viejo.
alter table entregas add column if not exists tipo text not null default 'FEI';
alter table entregas add column if not exists indicativo_numero text not null default '';
-- Foto de respaldo cuando el tipo pertenece a otra sede (ej. FEI escaneado
-- desde Polo Sur) -- ver _TIPO_SEDE_DUENA en app/services/duplicates.py.
alter table entregas add column if not exists traslado_url text;
-- Tipo/indicativo_numero PROPIOS del traslado (ej. TB 9-7980), distintos de
-- los de la factura (tipo/indicativo_numero de arriba) -- se persisten para
-- que buscar_entrega() encuentre la misma entrega buscando por el codigo del
-- traslado, no solo por el de la factura (ver app/routers/entregas.py).
alter table entregas add column if not exists traslado_tipo text;
alter table entregas add column if not exists traslado_indicativo_numero text;
-- Firma del cliente al confirmar la entrega (paso 2, PATCH /entregas/{id}/items)
-- -- foto en si vive en Storage (bucket evidencia, subpath firmas/), aca solo
-- la URL publica. Null si el guardado fue "Guardar nota" (sin cambio de
-- cantidades, no es un evento de entrega -- ver aplicar_actualizacion_items).
alter table entregas add column if not exists firma_url text;
-- Marca a nivel documento (no por item) para el flujo FAIA -- ver rol
-- 'faia_viewer' y GET /entregas/faia. Se carga en el paso 2
-- (PATCH /entregas/{id}/items, ver ActualizarItemsRequest.es_faia), no la
-- pone la IA.
alter table entregas add column if not exists es_faia boolean not null default false;
-- Nota a nivel documento (no por item -- esa ya existe en entrega_items.nota)
-- -- la escribe el bodeguero en PantallaConfirmando (ver
-- ActualizarItemsRequest.nota_general), separada visualmente de las notas
-- por producto. Nullable (a diferencia de es_faia, no tiene "default"
-- razonable -- ausencia de nota no es lo mismo que nota vacia a proposito).
alter table entregas add column if not exists nota_general text;
-- Foto tal como quedo en el insert original (ver procesar_extraccion) --
-- nunca se pisa despues, a diferencia de evidencia_url (que aplicar_actualizacion_items
-- SI actualiza cuando bodega vuelve a fotografiar al confirmar). Mismo
-- criterio de inmutabilidad que operador_id: permite mostrar por separado
-- "la foto de quien facturo" (ej. punto_venta) de "la foto de quien
-- confirmo" (ej. bodega) sin perder ninguna de las dos. Null en filas
-- existentes de antes de esta columna -- esas fotos originales ya se
-- perdieron (se pisaron), no hay forma de recuperarlas retroactivamente.
alter table entregas add column if not exists evidencia_creacion_url text;
-- Quien de bodega confirmo cantidades reales por ultima vez (ver
-- aplicar_actualizacion_items) -- a diferencia de operador_id (el creador,
-- inmutable), esta SI se actualiza en cada confirmacion con items reales, asi
-- refleja quien esta con la factura ahora. Null hasta que alguien confirme
-- algo de verdad (ej. punto_venta factura y todavia nadie de bodega la toco)
-- -- el dashboard muestra "NE" en ese caso.
alter table entregas add column if not exists bodeguero_id text;
-- Migracion a items por entrega (un documento puede traer varios productos):
-- cantidad_entregada/cantidad_pendiente/detalle (si existian de una version
-- anterior) se mudan a entrega_items.
alter table entregas drop column if exists cantidad_entregada;
alter table entregas drop column if exists cantidad_pendiente;
alter table entregas drop column if exists detalle;
alter table entregas drop column if exists numero_guia;
alter table entregas drop column if exists remitente;
alter table entregas drop column if exists destinatario;
alter table entregas drop column if exists items;
alter table entregas drop column if exists sede_destino_id;

do $$
begin
    alter table entregas drop constraint if exists entregas_numero_guia_remitente_key;
exception when undefined_object then null;
end $$;

-- "tipo" dejo de estar atado a los 4 valores conocidos (FEI/TB/RM3/RM2/RSF): en
-- la practica el documento real no siempre es uno de esos, hace falta poder
-- escribir uno nuevo (ver vision.py, EntregaRevision, buscar_entrega). Se
-- saca el check -- drop es idempotente sin necesidad de chequear pg_constraint
-- primero (a diferencia del unique de mas abajo, un check no deja indice atras).
alter table entregas drop constraint if exists entregas_tipo_check;

-- OJO: un unique constraint crea un indice con el mismo nombre por debajo;
-- si ya existe, Postgres tira duplicate_table (42P07) en vez de
-- duplicate_object (42710) al intentar recrearlo, asi que la constraint por
-- excepcion (como la del publication de mas abajo) no alcanza aca — hay que
-- chequear existencia antes en pg_constraint.

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'entregas_tipo_indicativo_numero_key' and conrelid = 'entregas'::regclass
    ) then
        alter table entregas add constraint entregas_tipo_indicativo_numero_key unique (tipo, indicativo_numero);
    end if;
end $$;

create table if not exists turnos (
    id uuid primary key default gen_random_uuid(),
    empleado_id text not null,
    sede_id text not null,
    fecha date not null,
    hora_inicio time not null,
    hora_fin time not null,
    origen text not null default 'manual' check (origen in ('manual', 'sugerido_ia')),
    created_at timestamptz not null default now()
);

create index if not exists idx_turnos_sede_fecha on turnos (sede_id, fecha);

create table if not exists shift_recommendations (
    id uuid primary key default gen_random_uuid(),
    sede_id text not null,
    semana_iso text not null,
    bloques_sugeridos jsonb not null default '[]',
    generado_at timestamptz not null default now(),
    modelo_usado text not null default 'percentiles_p50_p90',
    unique (sede_id, semana_iso)
);

-- Append-only: solo se inserta, nunca se actualiza ni se borra.
create table if not exists logs (
    id uuid primary key default gen_random_uuid(),
    evento text not null,
    entidad_tipo text not null,
    entidad_id text not null,
    actor_id text not null,
    sede_id text not null,
    resultado text not null,
    detalle jsonb not null default '{}',
    "timestamp" timestamptz not null default now()
);

create index if not exists idx_logs_timestamp on logs ("timestamp" desc);
create index if not exists idx_logs_entidad on logs (entidad_tipo, entidad_id);

-- Devolucion de un producto ya entregado (ver app/services/devoluciones.py).
-- 'reposicion' hace que esa cantidad vuelva a quedar pendiente (se debe
-- re-entregar); 'reembolso' la finaliza -- no vuelve a pendiente, esas
-- unidades salen del total (se devolvio el dinero, no un reemplazo).
-- 'no_lo_lleva' tiene el mismo efecto que 'reembolso'.
create table if not exists devoluciones (
    id uuid primary key default gen_random_uuid(),
    entrega_id uuid not null references entregas(id) on delete cascade,
    item_id uuid not null references entrega_items(id) on delete cascade,
    cantidad integer not null check (cantidad > 0),
    motivo text not null,
    resolucion text not null,
    operador_id text not null,
    sede_id text not null,
    creado_at timestamptz not null default now()
);

create index if not exists idx_devoluciones_entrega on devoluciones (entrega_id);

-- Texto que escribe el operador cuando el motivo es 'otro'.
alter table devoluciones add column if not exists motivo_detalle text;

-- "No se entrega": unidades facturadas de mas o equivocadas que nunca se
-- entregaron (ver app/services/no_entregados.py). Se cierran sin entregarse:
-- salen de cantidad_pendiente y suman en cantidad_no_entregada. Registro
-- aparte de las devoluciones (esas exigen que ya se hayan entregado).
alter table entrega_items add column if not exists cantidad_no_entregada integer not null default 0;

create table if not exists items_no_entregados (
    id uuid primary key default gen_random_uuid(),
    entrega_id uuid not null references entregas(id) on delete cascade,
    item_id uuid not null references entrega_items(id) on delete cascade,
    cantidad integer not null check (cantidad > 0),
    motivo text not null,
    operador_id text not null,
    sede_id text not null,
    creado_at timestamptz not null default now()
);

create index if not exists idx_items_no_entregados_entrega on items_no_entregados (entrega_id);

-- Texto que escribe el operador cuando el motivo es 'otro'.
alter table items_no_entregados add column if not exists motivo_detalle text;

-- Catalogo codigo -> nombre de producto, deducido de entrega_items.descripcion (ver
-- app/services/productos.py) -- se auto-completa a medida que se procesan/corrigen
-- facturas, sin backfill de lo historico. unique(codigo) es lo que garantiza "sin que
-- se repitan" (el insert usa on conflict do nothing).
create table if not exists productos (
    id uuid primary key default gen_random_uuid(),
    codigo text not null unique,
    nombre text not null,
    creado_at timestamptz not null default now()
);

-- Traslados entre puntos (bodega origen -> conductor -> bodega destino, ver
-- plan "traslados-entre-puntos"): puntos es una lista de lugares DISTINTA de
-- sedes (despachos), con sus propios usuarios. Tablas aditivas, no tocan
-- entregas/sedes/empleados.
create table if not exists puntos (
    id uuid primary key default gen_random_uuid(),
    nombre text not null unique,
    activo boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists usuarios_punto (
    id uuid primary key default gen_random_uuid(),
    nombre text not null,
    punto_id uuid not null references puntos(id),
    pin_hash text,
    pin_salt text,
    estado text not null default 'activo',
    created_at timestamptz not null default now()
);

create index if not exists idx_usuarios_punto_punto on usuarios_punto (punto_id);

-- Codigo corto del punto (ej. "CFC") -- el nombre guarda la etiqueta completa
-- tal como la usan en bodega ("CFC — La Cumbre"); el codigo queda aparte para
-- ordenar y buscar sin parsear el nombre (ver scripts/cargar_puntos.py).
alter table puntos add column if not exists codigo text;
create unique index if not exists puntos_codigo_key on puntos (codigo);

-- El id lo genera el celular (expo-crypto randomUUID()), no gen_random_uuid()
-- del lado del servidor: el path de las firmas en Storage
-- (firmas-traslados/{id}-{rol}.webp) se arma ANTES de crear el traslado, asi
-- que hace falta conocer el id de antemano (ver subirFirmaTraslado en
-- apps/mobile/api.ts y FirmaTransportador).
create table if not exists traslados_puntos (
    id uuid primary key,
    consecutivo bigserial unique,
    -- Null solo en las llegadas directas del proveedor (tipo = 'directo'); la
    -- regla origen/tipo vive en el check traslados_puntos_origen_tipo_check
    -- (mas abajo), que tambien sustituye al viejo origen <> destino.
    punto_origen_id uuid references puntos(id),
    punto_destino_id uuid not null references puntos(id),
    transportador_nombre text not null default '',
    fecha date not null,
    observaciones text,
    estado text not null default 'en_transito'
        check (estado in ('en_transito', 'recibido', 'recibido_con_novedad')),
    firma_despacha_url text,
    firma_transporta_url text,
    firma_recibe_url text,
    creado_por uuid not null references usuarios_punto(id),
    recibido_por uuid references usuarios_punto(id),
    recibido_at timestamptz,
    novedad text,
    created_at timestamptz not null default now()
);

-- Momento en que quien recibio acepto la declaracion de revision producto
-- por producto (movil). Null en recepciones anteriores a esa revision obligatoria.
alter table traslados_puntos add column if not exists declaracion_aceptada_at timestamptz;

create index if not exists idx_traslados_puntos_destino_estado
    on traslados_puntos (punto_destino_id, estado);
create index if not exists idx_traslados_puntos_origen
    on traslados_puntos (punto_origen_id, created_at desc);

-- Numero impreso en el talonario fisico de traslados (ej. "00231",
-- "A-00231") -- lo tipea el punto que despacha, es lo primero que copia del
-- papel (ver TrasladoPuntoCrear en app/models/traslado_punto.py). Null en
-- los traslados creados antes de este campo -- quedan sin valor para
-- siempre, no hay forma de reconstruirlo despues.
alter table traslados_puntos add column if not exists numero_talonario text;

-- Un traslado puede llevar varios productos, cada uno con su propia cantidad
-- enviada/recibida (mismo criterio que entrega_items para entregas).
create table if not exists traslado_punto_items (
    id uuid primary key default gen_random_uuid(),
    traslado_id uuid not null references traslados_puntos(id) on delete cascade,
    cantidad integer not null check (cantidad > 0),
    producto text not null,
    marca text not null default '',
    presentacion text not null default '',
    -- null hasta que el punto destino confirma la recepcion (ver
    -- registrar_recepcion en app/services/traslados_puntos.py).
    cantidad_recibida integer,
    novedad text
);

create index if not exists idx_traslado_punto_items_traslado on traslado_punto_items (traslado_id);

-- Fecha de vencimiento del producto, leida de la foto del talonario (opcional:
-- no todos los productos la traen). Null en los items anteriores a este campo.
alter table traslado_punto_items add column if not exists fecha_vencimiento date;

-- Foto del talonario fisico, de la que la IA lee el encabezado y los
-- productos al crear el traslado (ver extraer_talonario en
-- app/services/traslados_puntos.py). Null en los traslados anteriores.
alter table traslados_puntos add column if not exists foto_talonario_url text;

-- Texto libre de la hoja de una llegada directa (cuando no trae renglones de
-- productos o ademas de ellos). Null en los demas traslados.
alter table traslados_puntos add column if not exists contenido_texto text;

-- Supervision de novedades (ver el plan "supervision-novedades"): quien
-- resuelve un traslado que llego a un punto con diferencia de cantidad o con
-- una novedad cargada. Cuenta propia -- no es un usuario_punto (no pertenece
-- a un punto) ni un empleado (no pertenece a una sede), solo revisa y
-- resuelve novedades de cualquier traslado.
create table if not exists supervisores (
    id uuid primary key default gen_random_uuid(),
    nombre text not null,
    pin_hash text,
    pin_salt text,
    estado text not null default 'activo',
    created_at timestamptz not null default now()
);

-- Estado de la novedad de un traslado ya recibido: 'pendiente' apenas
-- registrar_recepcion lo deja en 'recibido_con_novedad', 'resuelta' cuando
-- Supervision carga una solucion (ver resolver_novedad en
-- app/services/traslados_puntos.py). Null en un traslado sin novedad
-- (en_transito o recibido completo) -- no aplica, no se muestra en la
-- bandeja de Supervision.
alter table traslados_puntos add column if not exists novedad_estado text;
alter table traslados_puntos drop constraint if exists traslados_puntos_novedad_estado_check;
alter table traslados_puntos add constraint traslados_puntos_novedad_estado_check
    check (novedad_estado is null or novedad_estado in ('pendiente', 'resuelta'));
alter table traslados_puntos add column if not exists solucion text;
alter table traslados_puntos add column if not exists solucionado_por uuid references supervisores(id);
alter table traslados_puntos add column if not exists solucionado_at timestamptz;

-- Backfill idempotente: traslados que ya habian quedado con novedad antes de
-- que existiera esta columna arrancan en 'pendiente' -- todavia nadie los
-- reviso via Supervision. No pisa una fila que ya tenga novedad_estado
-- seteado (por eso el "is null" -- correr esto de nuevo no revierte una
-- novedad ya resuelta).
update traslados_puntos set novedad_estado = 'pendiente'
    where estado = 'recibido_con_novedad' and novedad_estado is null;

create index if not exists idx_traslados_puntos_novedad_estado
    on traslados_puntos (novedad_estado);

-- Consecutivo bajo el que Supervision guarda la solucion de una novedad
-- (codigo de punto + numero, ej. "NPT-1234", ver resolver_novedad en
-- app/services/traslados_puntos.py). Unico solo entre los que tienen valor
-- (indice parcial) -- una novedad sin resolver no tiene consecutivo todavia,
-- eso no puede chocar con nada.
alter table traslados_puntos add column if not exists consecutivo_solucion text;
create unique index if not exists traslados_puntos_consecutivo_solucion_key
    on traslados_puntos (consecutivo_solucion) where consecutivo_solucion is not null;

-- Talonario por punto (ver app/services/talonarios.py): cada punto trabaja con
-- UN talonario activo a la vez, de 50 hojas fijas (letra + numero_inicial ..
-- numero_final), y cada traslado consume la siguiente hoja en orden. Un
-- talonario cerrado conserva su historial; las hojas que quedaron sin usar
-- simplemente se dejan de usar.
create table if not exists talonarios_punto (
    id uuid primary key default gen_random_uuid(),
    punto_id uuid not null references puntos(id),
    letra text not null check (length(letra) between 1 and 3),
    numero_inicial integer not null check (numero_inicial > 0),
    numero_final integer not null,
    estado text not null default 'activo' check (estado in ('activo', 'cerrado')),
    creado_por uuid not null references usuarios_punto(id),
    created_at timestamptz not null default now(),
    cerrado_at timestamptz,
    motivo_cierre text,
    check (numero_final = numero_inicial + 49)
);

-- Primera hoja que ofrece el sistema cuando el talonario ya venia en uso al
-- registrarlo (las anteriores se gastaron fuera del sistema). Null = desde
-- numero_inicial, como los talonarios registrados antes de esta columna.
alter table talonarios_punto add column if not exists numero_desde integer;

-- Un solo talonario activo por punto y letra (indice parcial): es el seguro de
-- base de datos contra dos configuraciones simultaneas de la misma letra. Un
-- punto puede llevar a la vez, p. ej., el general "A" y el de veterinaria "V".
drop index if exists talonarios_punto_activo_key;
create unique index if not exists talonarios_punto_activo_letra_key
    on talonarios_punto (punto_id, letra) where estado = 'activo';
create index if not exists idx_talonarios_punto_punto
    on talonarios_punto (punto_id, created_at desc);

-- Hojas anuladas (danadas, mal impresas, etc.). Solo se anula la siguiente
-- hoja pendiente; el motivo es obligatorio.
create table if not exists talonario_hojas_anuladas (
    id uuid primary key default gen_random_uuid(),
    talonario_id uuid not null references talonarios_punto(id),
    numero integer not null,
    motivo text not null,
    anulado_por uuid not null references usuarios_punto(id),
    created_at timestamptz not null default now(),
    unique (talonario_id, numero)
);

-- Talonario del que salio el traslado. Null en los traslados anteriores a esta
-- funcion (su numero_talonario era libre y puede estar repetido), por eso el
-- indice unico es parcial: solo vigila los traslados que si traen talonario_id.
alter table traslados_puntos add column if not exists talonario_id uuid references talonarios_punto(id);
-- La hoja se vigila por talonario y no por punto origen: en una llegada directa
-- no hay origen y la hoja es del talonario del punto que recibe. Un talonario
-- pertenece a un solo punto, asi que para los traslados entre puntos es
-- equivalente al indice anterior (punto_origen_id, numero_talonario).
create unique index if not exists traslados_puntos_talonario_hoja_key
    on traslados_puntos (talonario_id, numero_talonario) where talonario_id is not null;
drop index if exists traslados_puntos_talonario_numero_key;
create index if not exists idx_traslados_puntos_talonario
    on traslados_puntos (talonario_id) where talonario_id is not null;

-- Llegada directa del proveedor a un punto: tipo 'directo', sin punto de origen
-- ni firmas de quien despacha/transporta; solo firma quien recibe. Se crea ya en
-- 'recibido' (o 'recibido_con_novedad'). Los traslados existentes quedan como
-- 'entre_puntos'.
alter table traslados_puntos add column if not exists tipo text not null default 'entre_puntos';
alter table traslados_puntos drop constraint if exists traslados_puntos_tipo_check;
alter table traslados_puntos add constraint traslados_puntos_tipo_check
    check (tipo in ('entre_puntos', 'directo'));
alter table traslados_puntos alter column punto_origen_id drop not null;
-- Sustituye el check inline original (origen <> destino), que Postgres nombro
-- automaticamente (traslados_puntos_check); se busca por definicion para no
-- depender del nombre.
do $$
declare
    r record;
begin
    for r in
        select conname from pg_constraint
        where conrelid = 'traslados_puntos'::regclass and contype = 'c'
          and conname <> 'traslados_puntos_origen_tipo_check'
          and pg_get_constraintdef(oid) like '%punto_origen_id <> punto_destino_id%'
    loop
        execute format('alter table traslados_puntos drop constraint %I', r.conname);
    end loop;
end $$;
alter table traslados_puntos drop constraint if exists traslados_puntos_origen_tipo_check;
alter table traslados_puntos add constraint traslados_puntos_origen_tipo_check
    check (
        (tipo = 'entre_puntos' and punto_origen_id is not null and punto_origen_id <> punto_destino_id)
        or (tipo = 'directo' and punto_origen_id is null)
    );

-- Numero del traslado en Syscafe (sistema contable, ej. "NBR-945"): lo registra
-- Supervision para cruzarlo con la hoja del talonario (ver
-- asignar_numero_syscafe en app/services/traslados_puntos.py). Unico solo entre
-- los que tienen valor (indice parcial) -- un traslado sin numero todavia no
-- puede chocar con nada.
alter table traslados_puntos add column if not exists numero_syscafe text;
create unique index if not exists traslados_puntos_numero_syscafe_key
    on traslados_puntos (numero_syscafe) where numero_syscafe is not null;

-- Quien y cuando asigno (o quito) el numero Syscafe, para el feed de
-- actividad del panel de traslados (GET /traslados-puntos/actividad).
-- `por` es el nombre para mostrar: supervisor en el movil, usuario del
-- dashboard en la sesion web ("Administración" con el token legacy).
alter table traslados_puntos add column if not exists numero_syscafe_at timestamptz;
alter table traslados_puntos add column if not exists numero_syscafe_por text;

-- Tipos de documento que la IA de vision recibe como guia en el prompt (ver
-- app/services/tipos_documento.py y vision.py) -- se administran desde
-- /creador en el dashboard. No restringen entregas.tipo (sin check ahi): son
-- referencia, no una lista cerrada. El seed es idempotente.
create table if not exists tipos_documento (
    codigo text primary key,
    descripcion text not null default '',
    activo boolean not null default true,
    created_at timestamptz not null default now()
);

insert into tipos_documento (codigo, descripcion) values
    ('FEI', 'factura'),
    ('FV1', 'factura'),
    ('EDP', ''),
    ('EDV', ''),
    ('TB9', 'traslado entre bodegas'),
    ('RM3', 'remision'),
    ('RM2', 'remision'),
    ('RSF', 'remision')
on conflict (codigo) do nothing;

-- Facturas que bodega (operador) reporta como "todavia no subidas" por el
-- mostrador (punto_venta) de la sede DUENA del tipo de documento (o de la sede
-- de quien reporta si el tipo no tiene duena) -- ver app/services/facturas_faltantes.py.
-- sede_id = sede destino (cuyo mostrador debe subirla); sede_reporta_id = sede
-- de quien reporto (null en filas viejas: se lee como coalesce(sede_reporta_id, sede_id)).
-- Pasa a 'resuelta' sola cuando punto_venta sube esa factura (insert en
-- entregas, ver procesar_extraccion); 'descartada' es el cierre manual. El
-- unique parcial garantiza un solo reporte pendiente por documento aunque dos
-- bodegueros lo reporten a la vez. entrega_id queda en null si la entrega se borra.
create table if not exists facturas_faltantes (
    id uuid primary key default gen_random_uuid(),
    tipo text not null,
    indicativo_numero text not null,
    sede_id text not null,
    reportado_por text not null,
    reportado_at timestamptz not null default now(),
    estado text not null default 'pendiente',
    entrega_id uuid references entregas(id) on delete set null,
    cerrada_at timestamptz,
    cerrada_por text
);

alter table facturas_faltantes add column if not exists sede_reporta_id text;

alter table facturas_faltantes drop constraint if exists facturas_faltantes_estado_check;
alter table facturas_faltantes add constraint facturas_faltantes_estado_check
    check (estado in ('pendiente', 'resuelta', 'descartada'));

create unique index if not exists facturas_faltantes_pendiente_key
    on facturas_faltantes (tipo, indicativo_numero) where estado = 'pendiente';
create index if not exists idx_facturas_faltantes_sede_estado
    on facturas_faltantes (sede_id, estado);
create index if not exists idx_facturas_faltantes_sede_reporta_estado
    on facturas_faltantes (sede_reporta_id, estado);

-- Usuarios del dashboard (login con usuario y contrasena, roles admin /
-- supervisor / consulta -- ver app/services/usuarios_dashboard.py). Distinta de
-- empleados/supervisores (esos entran a la app movil con PIN). NO se agrega a
-- la publicacion de realtime: guarda hashes de contrasena.
create table if not exists usuarios_dashboard (
    id uuid primary key default gen_random_uuid(),
    usuario text not null unique,
    nombre text not null,
    rol text not null,
    pass_hash text not null,
    pass_salt text not null,
    activo boolean not null default true,
    intentos_fallidos integer not null default 0,
    bloqueado_hasta timestamptz,
    creado_at timestamptz not null default now(),
    ultimo_login_at timestamptz
);

alter table usuarios_dashboard drop constraint if exists usuarios_dashboard_rol_check;
alter table usuarios_dashboard add constraint usuarios_dashboard_rol_check
    check (rol in ('admin', 'supervisor', 'consulta'));

-- Area del usuario del dashboard: que secciones ve y en cuales puede escribir
-- (ortogonal al rol). El admin siempre actua como 'todo' (ver
-- app/services/permisos_dashboard.py).
alter table usuarios_dashboard add column if not exists area text not null default 'todo';
alter table usuarios_dashboard drop constraint if exists usuarios_dashboard_area_check;
alter table usuarios_dashboard add constraint usuarios_dashboard_area_check
    check (area in ('todo', 'bodega', 'traslados'));

-- Realtime de Supabase: sin esto el dashboard no recibe push de cambios,
-- solo podria hacer polling. Falla silenciosamente (DO block) si ya estaban
-- agregadas o si la publicacion no existe (p.ej. Postgres self-hosted sin
-- la extension de Supabase) para no romper el arranque del backend.
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        begin
            alter publication supabase_realtime add table entregas;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table entrega_items;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table logs;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table devoluciones;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table items_no_entregados;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table productos;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table traslados_puntos;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table traslado_punto_items;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table facturas_faltantes;
        exception when duplicate_object then null;
        end;
    end if;
end $$;

-- Reparacion de datos: antes, una correccion desde el dashboard pisaba
-- bodeguero_id y entrega_items.entregado_por con el actor del dashboard
-- ("dashboard:<usuario>" o "supervisor"). Ahora las correcciones del dashboard
-- ya no tocan esas columnas (ver aplicar_actualizacion_items); esto devuelve
-- las filas viejas al ultimo bodeguero real segun logs. Idempotente: despues
-- de correr, esas columnas solo tienen ids de empleados o null.
update entregas e
set bodeguero_id = (
    select l.actor_id
    from logs l
    join empleados emp on emp.id::text = l.actor_id
    where l.entidad_id = e.id::text
      and l.evento = 'entrega_actualizada'
      and emp.rol <> 'punto_venta'
    order by l."timestamp" desc
    limit 1
)
where e.bodeguero_id is not null
  and not exists (select 1 from empleados emp where emp.id::text = e.bodeguero_id);

update entrega_items i
set entregado_por = e.bodeguero_id
from entregas e
where e.id = i.entrega_id
  and i.entregado_por is not null
  and i.entregado_por is distinct from e.bodeguero_id
  and not exists (select 1 from empleados emp where emp.id::text = i.entregado_por);
"""


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            get_settings().database_url, min_size=1, max_size=10, init=_init_connection
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def ensure_schema() -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(_SCHEMA)
