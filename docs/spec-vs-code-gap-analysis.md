# Vault - Comparacion spec vs codigo

## Resumen

La spec ahora esta alineada con un core acotado:

- Cloudflare Access como unica autenticacion.
- Files por `id`, con `name` como path humano dentro de `account`.
- Contenido como string, hoy usado como Markdown.
- Append log y projections como complejidad interna.
- MCP y UI como clientes del mismo core.

Se removieron del runtime actual: tokens `vlt_`, batch writes, version header,
sources/import/conectores, subscriptions/webhooks y cron scheduler.

## Core Que Existe En Codigo

- Worker Hono bajo `/api`.
- Cloudflare Access JWT validation.
- Auto-provisioning de `account` y `author`.
- `POST /files` para crear.
- `GET /files/:id` para leer.
- `PUT /files/:id` para actualizar.
- `PATCH /files/:id` para renombrar.
- `GET /files` con `id`, `name`, `prefix`, `q`, `cursor`, `limit`.
- Append log con entries inmutables.
- Projection engine con cache KV.
- Snapshots internos.
- MCP tools: crear, leer, buscar, listar, actualizar.
- UI web basica para archivos.
- Ruta avanzada por ID para history.

## Diferencias Restantes

### 1. File type sigue como columna interna

Spec:

- No hay `type` publico de file en el core actual.

Codigo:

- `files.type` y `entries.type` siguen existiendo en schema y dominio.
- El API y MCP crean todo como `note`.

Estado:

Aceptable por compatibilidad interna, pero no debe exponerse en el contrato
publico por ahora.

### 2. Sources siguen como tabla interna

Spec:

- Conectores externos no estan activos.
- GitHub queda como modulo futuro.

Codigo:

- `sources` permanece porque `authors.source_id` y `entries.source_id` dependen
  de esa tabla para provenance.
- Los endpoints de sources/import y el scheduler fueron removidos.

Estado:

Aceptable como infraestructura interna.

### 3. Conflict detection quedo fuera del core

Spec:

- Conflict detection es modulo futuro.

Codigo:

- Se removieron rutas y tablas de conflicts.
- No hay writer automatico de conflicts.

Estado:

Correcto para el recorte actual. Reintroducirlo solo cuando exista un flujo real
que cree y resuelva conflictos.

## Riesgos Tecnicos Del Core

- `global_position` usa `max + 1`; puede chocar bajo concurrencia.
- HLC usa JS `number`; no representa todos los enteros de 64 bits con precision.
- `GET /files?q=...` busca en memoria sobre la pagina actual, no en full-text real.
- `GET /files?prefix=...` filtra despues del `limit`; puede ocultar resultados.
- No hay tests automatizados para API, append log ni projections.

## Siguiente Implementacion Recomendada

1. Fortalecer el core antes de reactivar modulos:
   - tests de `POST/GET/PUT/PATCH /files`
   - tests de projection rebuild
   - tests de concurrencia `if_version`
2. Mejorar query de listado:
   - aplicar `prefix` antes de `limit`
   - decidir si `q` sigue siendo simple substring o se introduce FTS
3. Resolver concurrencia de `global_position`.
4. Decidir si `files.type` y `entries.type` se quedan como campos internos
   legacy o se migran fuera cuando haya una ventana de schema.
5. Cuando el core este estable, implementar el modulo futuro de GitHub connector.
