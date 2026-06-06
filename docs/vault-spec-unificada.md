# Vault - Spec unificada

## Que es

Vault es un sistema de conocimiento con backend en la nube. En el core actual,
permite crear, listar, leer, actualizar y renombrar archivos de texto Markdown
asociados a una cuenta autenticada por Cloudflare Access.

El API no depende semanticamente de Markdown: recibe y devuelve strings de
texto. Markdown es el formato de contenido que usan los clientes hoy.

## Principios

- Superficie pequena: el runtime actual prioriza operaciones exactas sobre
  archivos.
- Auth externa: Cloudflare Access autentica humanos y clientes MCP.
- Identidad estable: el servidor asigna un ULID por file y las operaciones
  exactas usan ese `id`.
- `name` como path humano: unico dentro de una account, por ejemplo
  `projects/vault/spec`.
- Log interno: cada escritura produce una entry append-only.
- Projection desechable: el contenido vigente se puede regenerar desde el log.
- Modulos futuros separados: versionado de API, conectores, notificaciones y
  permisos delegados no forman parte del core runtime actual.

## Core Actual

### Modulo 1 - Accounts y Auth

Responsabilidad:

- Validar Cloudflare Access JWT.
- Resolver o auto-provisionar una `account` y un `author` para el usuario.
- Permitir bypass solo en `ENVIRONMENT=development`.
- Usar la misma auth para UI, API y MCP.

Fuera de alcance por ahora:

- Tokens propios `vlt_`.
- Scopes delegados.
- Permisos granulares por file.

### Modulo 2 - Files

Responsabilidad:

- Crear archivos con `POST /files`.
- Leer archivos con `GET /files/:id`.
- Actualizar archivos con `PUT /files/:id`.
- Renombrar o mover archivos con `PATCH /files/:id`.
- Resolver por nombre exacto con `GET /files?name=...`.
- Listar por cuenta con `GET /files`.
- Filtrar por prefijo virtual con `GET /files?prefix=...`.
- Buscar texto con `GET /files?q=...`.

Modelo publico:

```json
{
  "id": "01HX...",
  "name": "projects/vault/spec",
  "content": "# Vault Spec\n\n...",
  "version": 3,
  "created_at": "2026-05-26T10:00:00.000Z",
  "updated_at": "2026-05-26T10:01:00.000Z"
}
```

Notas:

- No hay `type` publico de file en esta etapa.
- El contenido es un string.
- `content_ref` y binarios quedan fuera del core actual.
- `if_version` existe para concurrencia optimista en updates.

### Modulo 3 - Append Log

Responsabilidad:

- Crear una entry inmutable por escritura.
- Asignar `sequence_number` por file.
- Asignar `global_position` por servidor.
- Asignar HLC.
- Guardar author/source internos para provenance.
- Soportar idempotency key para reintentos.

Invariantes:

1. Una entry no se modifica ni se elimina.
2. `sequence_number` y `global_position` los asigna el servidor.
3. Toda entry tiene `author_id` y `source_id`.
4. El log es la fuente de verdad.

### Modulo 4 - Projections

Responsabilidad:

- Materializar el contenido vigente desde entries.
- Cachear projections en KV.
- Regenerar una projection si no existe en cache.
- Soportar snapshots internos para acelerar rebuilds.
- Devolver Markdown plano con `Accept: text/markdown`.

### Modulo 5 - MCP

Responsabilidad:

- Exponer herramientas equivalentes al core:
  - `create_file`
  - `read_file`
  - `find_file`
  - `list_files`
  - `update_file`
- Operar por `id` para lecturas/updates exactos.
- Operar por `name` para busqueda humana.
- Autenticarse via Cloudflare Access.

### Modulo 6 - UI Web

Responsabilidad:

- Listar archivos.
- Crear archivos.
- Leer contenido.
- Editar contenido.
- Renombrar archivos.
- Resolver archivos por ID devuelto por el API.

## API Core

### Crear archivo

```http
POST /files
Content-Type: application/json
```

```json
{
  "name": "projects/vault/spec",
  "content": "# Vault Spec\n\n..."
}
```

Response `201`:

```json
{
  "file": {
    "id": "01HX...",
    "name": "projects/vault/spec",
    "content": "# Vault Spec\n\n...",
    "version": 1,
    "created_at": "2026-05-26T10:00:00.000Z",
    "updated_at": "2026-05-26T10:00:00.000Z"
  }
}
```

### Leer archivo

```http
GET /files/:id
```

Response `200`:

```json
{
  "file": {
    "id": "01HX...",
    "name": "projects/vault/spec",
    "content": "# Vault Spec\n\n...",
    "version": 1,
    "freshness": "fresh",
    "created_at": "2026-05-26T10:00:00.000Z",
    "updated_at": "2026-05-26T10:00:00.000Z"
  }
}
```

Para Markdown plano:

```http
GET /files/:id
Accept: text/markdown
```

### Actualizar archivo

```http
PUT /files/:id
Content-Type: application/json
```

```json
{
  "content": "# Vault Spec\n\nUpdated.",
  "if_version": 1
}
```

`if_version` es opcional. Si se envia y no coincide, el API responde `409`.

### Renombrar archivo

```http
PATCH /files/:id
Content-Type: application/json
```

```json
{
  "name": "projects/vault/spec-updated"
}
```

### Listar y buscar

```http
GET /files
GET /files?name=projects/vault/spec
GET /files?prefix=projects/vault/
GET /files?q=projection
GET /files?cursor=2026-05-26T10:00:00.000Z&limit=20
```

## Datos Core

Tablas del core actual:

- `accounts`: cuenta propietaria.
- `authors`: actor humano o sistema.
- `sources`: source interno para provenance; conectores externos aun no activos.
- `files`: `id`, `account_id`, `name`, version, status, timestamps.
- `entries`: log append-only.
- `entry_references`: relaciones entre entries.
- `projections`: vista materializada.
- `snapshots`: compactacion interna.
- `upcasters`: migracion interna de entries.

## Modulos Futuros

### Versionado del API

Se mantiene en la spec para implementacion futura, pero no esta activo en el
codigo actual.

```http
Vault-Version: 2026-05-26
```

Objetivo futuro: pinnear contratos por fecha sin cambiar URL.

### GitHub Connector

Unico conector considerado por ahora.

Objetivo futuro:

- Registrar un repo GitHub como source.
- Importar archivos Markdown desde una ruta configurada.
- Mantener provenance por source.
- Sincronizar cambios por webhook o polling.

Fuera de alcance:

- Confluence.
- Notion.
- R2/S3 como sources.
- Generic Git.
- Local folder watcher.

### Notifications

Objetivo futuro:

- Notificar cambios a clientes externos.
- Usar Cloudflare Queues para dispatch asincrono.
- Mantener payloads sin contenido; el receptor hace `GET /files/:id`.

### Permissions

Objetivo futuro:

- Scopes por account/file.
- Delegacion fina si Cloudflare Access deja de ser suficiente.
- Tokens propios solo si Access no cubre el caso MCP/agentes.

### Projection Rebuilder

Objetivo futuro:

- Rebuild asincrono stateful.
- Posible Durable Object si el costo/latencia lo justifica.

### Conflict Detection

Objetivo futuro:

- Detectar contradicciones entre escrituras.
- Exponer conflictos solo cuando exista un flujo real que los genere y resuelva.
- Mantener lecturas desbloqueadas aunque existan conflictos.

## Explicitamente Fuera Del Core Actual

- File `type` publico.
- Tokens `vlt_`.
- Batch writes.
- API version header activo.
- Conectores externos en runtime.
- Webhook subscriptions.
- Binarios y `content_ref`.
- Conflict detection.
- Busqueda full-text avanzada.
- Permisos delegados por scope.
