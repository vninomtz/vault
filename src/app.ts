import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcp } from "./mcp";
import { eq, desc, asc, lt, and } from "drizzle-orm";
import { createDb } from "./db/index";
import { files, entries, tokens, sources, subscriptions, conflicts, authors, accounts } from "./db/schema";
import { appendEntry } from "./domain/append-log";
import { readProjection } from "./domain/projection-engine";
import { ulid, sha256 } from "./utils";
import { ConflictError } from "./types";
import type { Env, ActorContext, Confidence } from "./types";

type Variables = { actor: ActorContext };
type HonoEnv = { Bindings: Env; Variables: Variables };

const SYSTEM_SOURCE_ID = "01SYSTEM000000000000000000";
const SYSTEM_AUTHOR_ID = "01SYSTEM000000000000000001";
const SYSTEM_ACCOUNT_ID = "01SYSTEM000000000000000000";

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Vault-Version", "CF-Access-Jwt-Assertion"],
    maxAge: 86400,
  }),
);

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const cfJwt = c.req.header("CF-Access-Jwt-Assertion") ?? "";

  if (cfJwt) {
    const identity = await validateAccessJwt(cfJwt, c.env.CF_ACCESS_TEAM ?? "");
    if (!identity) return c.json({ error: { code: "unauthorized", message: "Invalid Cloudflare Access token" } }, 401);
    const db = createDb(c.env.DB);
    const actor = await resolveHumanActor(db, identity.email);
    c.set("actor", actor);
    return next();
  }

  if (auth.startsWith("Bearer vlt_")) {
    const hash = await sha256(auth.slice(7));
    const db = createDb(c.env.DB);
    const row = await db.select().from(tokens).where(eq(tokens.tokenHash, hash)).get();
    const expired = row?.expiresAt != null && row.expiresAt < Date.now();
    if (!row || expired) return c.json({ error: { code: "unauthorized", message: "Invalid or expired token" } }, 401);
    c.set("actor", {
      id: row.actorId,
      accountId: row.accountId,
      kind: "agent",
      read: JSON.parse(row.readScope) as string[],
      write: JSON.parse(row.writeScope) as string[],
    });
    return next();
  }

  // TODO: remove — dev bypass
  c.set("actor", { id: SYSTEM_AUTHOR_ID, accountId: SYSTEM_ACCOUNT_ID, kind: "system", isSystem: true, read: ["*:*"], write: ["*:*"] });
  return next();
});

// ─── Rate limit ───────────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  const actor = c.get("actor");
  const actorId = actor.id ?? actor.email ?? "anonymous";
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${actorId}:${minute}`;
  const isWrite = ["PUT", "POST", "PATCH", "DELETE"].includes(c.req.method);
  const limit = isWrite ? 100 : 500;
  const current = parseInt((await c.env.CACHE.get(key)) ?? "0", 10);
  if (current >= limit)
    return c.json({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429);
  await c.env.CACHE.put(key, String(current + 1), { expirationTtl: 120 });
  return next();
});

// ─── Files ───────────────────────────────────────────────────────────────────

// POST /files — create a new file, server assigns ID
app.post("/files", async (c) => {
  const actor = c.get("actor");
  const body = await c.req.json<{
    name: string;
    content?: string;
    content_ref?: string;
    idempotency_key?: string;
    meta?: { confidence?: string };
  }>();

  if (!body.name) return c.json({ error: { code: "invalid", message: '"name" is required' } }, 422);
  if (!body.content && !body.content_ref)
    return c.json({ error: { code: "invalid", message: '"content" or "content_ref" is required' } }, 422);

  const db = createDb(c.env.DB);

  // Validate name uniqueness within account
  const existing = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.accountId, actor.accountId!), eq(files.name, body.name)))
    .get();
  if (existing)
    return c.json({ error: { code: "conflict", message: `File '${body.name}' already exists`, details: { id: existing.id } } }, 409);

  const fileId = ulid();
  const now = Date.now();
  await db.insert(files).values({
    id: fileId,
    accountId: actor.accountId!,
    name: body.name,
    type: "note",
    currentVersion: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();

  const result = await appendEntry(c.env, {
    accountId: actor.accountId!,
    fileId,
    content: body.content ?? null,
    contentRef: body.content_ref ?? null,
    type: "note",
    intent: "genesis",
    authorId: actor.id ?? SYSTEM_AUTHOR_ID,
    sourceId: SYSTEM_SOURCE_ID,
    confidence: (body.meta?.confidence ?? "medium") as Confidence,
    references: [],
    idempotencyKey: body.idempotency_key ?? ulid(),
  });

  return c.json({
    file: {
      id: fileId,
      name: body.name,
      content: body.content,
      version: result.sequenceNumber,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    },
  }, 201);
});

// PUT /files/:id — update content by ID
app.put("/files/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  const body = await c.req.json<{
    content?: string;
    content_ref?: string;
    if_version?: number;
    idempotency_key?: string;
    meta?: { confidence?: string; supersedes?: string[]; references?: string[] };
  }>();

  if (!body.content && !body.content_ref)
    return c.json({ error: { code: "invalid", message: '"content" or "content_ref" is required' } }, 422);

  const db = createDb(c.env.DB);
  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.accountId, actor.accountId!)))
    .get();
  if (!file) return c.json({ error: { code: "not_found", message: `File '${id}' not found` } }, 404);

  try {
    const result = await appendEntry(c.env, {
      accountId: actor.accountId!,
      fileId: file.id,
      content: body.content ?? null,
      contentRef: body.content_ref ?? null,
      type: file.type,
      intent: "addition",
      authorId: actor.id ?? SYSTEM_AUTHOR_ID,
      sourceId: SYSTEM_SOURCE_ID,
      confidence: (body.meta?.confidence ?? "medium") as Confidence,
      references: [...(body.meta?.supersedes ?? []), ...(body.meta?.references ?? [])],
      idempotencyKey: body.idempotency_key ?? ulid(),
      expectedVersion: body.if_version,
    });

    const projection = await readProjection(c.env, actor.accountId!, file.name);
    return c.json({
      file: {
        id: file.id,
        name: file.name,
        content: projection?.content ?? body.content,
        version: result.sequenceNumber,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    if (e instanceof ConflictError)
      return c.json({ error: { code: "conflict", message: e.message, details: { expected: e.expected, actual: e.actual } } }, 409);
    throw e;
  }
});

// PATCH /files/:id — rename / move
app.patch("/files/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  const body = await c.req.json<{ name: string }>();

  if (!body.name) return c.json({ error: { code: "invalid", message: '"name" is required' } }, 422);

  const db = createDb(c.env.DB);
  const file = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, id), eq(files.accountId, actor.accountId!)))
    .get();
  if (!file) return c.json({ error: { code: "not_found", message: `File '${id}' not found` } }, 404);

  // Validate new name doesn't conflict
  const conflict = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.accountId, actor.accountId!), eq(files.name, body.name)))
    .get();
  if (conflict)
    return c.json({ error: { code: "conflict", message: `File '${body.name}' already exists` } }, 409);

  await db.update(files).set({ name: body.name, updatedAt: Date.now() }).where(eq(files.id, id)).run();
  return c.json({ updated: true, name: body.name });
});

// GET /files/:id — read by ID
app.get("/files/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");

  const db = createDb(c.env.DB);
  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.accountId, actor.accountId!)))
    .get();
  if (!file) return c.json({ error: { code: "not_found", message: `File '${id}' not found` } }, 404);

  const projection = await readProjection(c.env, actor.accountId!, file.name);
  if (!projection) return c.json({ error: { code: "not_found", message: `File '${id}' not found` } }, 404);

  const accept = c.req.header("Accept") ?? "application/json";
  if (accept.includes("text/markdown")) return c.text(projection.content);

  return c.json({
    file: {
      id: file.id,
      name: file.name,
      content: projection.content,
      version: file.currentVersion,
      updated_at: new Date(file.updatedAt).toISOString(),
      created_at: new Date(file.createdAt).toISOString(),
      freshness: projection.freshness,
      has_conflicts: projection.hasConflicts,
    },
  });
});

// GET /files — list/search
// ?id=      lookup by ID (redirects to canonical response)
// ?name=    exact name lookup
// ?prefix=  list files under a virtual path
// ?q=       full-text search
app.get("/files", async (c) => {
  const actor = c.get("actor");
  const db = createDb(c.env.DB);

  const idParam = c.req.query("id");
  const nameParam = c.req.query("name");
  const prefix = c.req.query("prefix");
  const q = c.req.query("q");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
  const cursor = c.req.query("cursor");

  // Lookup by ID
  if (idParam) {
    const file = await db.select().from(files).where(and(eq(files.id, idParam), eq(files.accountId, actor.accountId!))).get();
    if (!file) return c.json({ error: { code: "not_found", message: `File '${idParam}' not found` } }, 404);
    const projection = await readProjection(c.env, actor.accountId!, file.name);
    return c.json({ file: { id: file.id, name: file.name, content: projection?.content ?? "", version: file.currentVersion, updated_at: new Date(file.updatedAt).toISOString() } });
  }

  // Lookup by exact name
  if (nameParam) {
    const file = await db.select().from(files).where(and(eq(files.accountId, actor.accountId!), eq(files.name, nameParam))).get();
    if (!file) return c.json({ error: { code: "not_found", message: `File '${nameParam}' not found` } }, 404);
    const projection = await readProjection(c.env, actor.accountId!, file.name);
    return c.json({ file: { id: file.id, name: file.name, content: projection?.content ?? "", version: file.currentVersion, updated_at: new Date(file.updatedAt).toISOString() } });
  }

  // List with optional prefix / full-text
  let query = db
    .select()
    .from(files)
    .where(eq(files.accountId, actor.accountId!))
    .orderBy(desc(files.updatedAt))
    .limit(limit + 1)
    .$dynamic();

  if (prefix) query = query.where(and(eq(files.accountId, actor.accountId!)));
  if (cursor) query = query.where(and(eq(files.accountId, actor.accountId!), lt(files.updatedAt, new Date(cursor).getTime())));

  const rows = await query.all();

  const filtered = rows
    .filter(f => !prefix || f.name.startsWith(prefix))
    .slice(0, limit);

  const hasMore = rows.length > limit;

  const results = await Promise.all(
    filtered.map(async (file) => {
      const projection = await readProjection(c.env, actor.accountId!, file.name);
      const content = projection?.content ?? "";
      if (q && !content.toLowerCase().includes(q.toLowerCase())) return null;
      return {
        id: file.id,
        name: file.name,
        content,
        version: file.currentVersion,
        updated_at: new Date(file.updatedAt).toISOString(),
        freshness: projection?.freshness ?? "unknown",
      };
    }),
  );

  const out = results.filter(Boolean);
  const nextCursor = hasMore ? new Date(filtered[filtered.length - 1]?.updatedAt ?? 0).toISOString() : null;

  return c.json({ files: out, next_cursor: nextCursor, total: out.length });
});

// ─── Batch ────────────────────────────────────────────────────────────────────

app.post("/batch", async (c) => {
  const actor = c.get("actor");
  const body = await c.req.json<{
    atomic?: boolean;
    operations: Array<{
      id: string;
      content: string;
      if_version?: number;
      idempotency_key?: string;
    }>;
  }>();

  if (!body.operations?.length)
    return c.json({ error: { code: "invalid", message: "No operations provided" } }, 422);
  if (body.operations.length > 50)
    return c.json({ error: { code: "invalid", message: "Maximum 50 operations per batch" } }, 422);

  const db = createDb(c.env.DB);
  const results: Array<{ id: string; status: string; version?: number; error?: unknown }> = [];

  for (const op of body.operations) {
    const file = await db
      .select()
      .from(files)
      .where(and(eq(files.id, op.id), eq(files.accountId, actor.accountId!)))
      .get();

    if (!file) {
      if (body.atomic) return c.json({ error: { code: "not_found", message: `File '${op.id}' not found` } }, 404);
      results.push({ id: op.id, status: "not_found" });
      continue;
    }

    try {
      const result = await appendEntry(c.env, {
        accountId: actor.accountId!,
        fileId: file.id,
        content: op.content,
        contentRef: null,
        type: file.type,
        intent: "addition",
        authorId: actor.id ?? SYSTEM_AUTHOR_ID,
        sourceId: SYSTEM_SOURCE_ID,
        confidence: "medium",
        references: [],
        idempotencyKey: op.idempotency_key ?? ulid(),
        expectedVersion: op.if_version,
      });
      results.push({ id: op.id, status: "ok", version: result.sequenceNumber });
    } catch (e) {
      if (e instanceof ConflictError) {
        if (body.atomic) return c.json({ error: { code: "conflict", message: `Conflict on '${op.id}'` } }, 409);
        results.push({ id: op.id, status: "conflict", error: { code: "conflict", details: { expected: e.expected, actual: e.actual } } });
      } else {
        if (body.atomic) throw e;
        results.push({ id: op.id, status: "error" });
      }
    }
  }

  return c.json({ results });
});

// ─── Tokens ───────────────────────────────────────────────────────────────────

app.post("/tokens", async (c) => {
  const actor = c.get("actor");
  const body = await c.req.json<{
    name: string;
    read?: string[];
    write?: string[];
    expires_at?: string;
    propose_only?: boolean;
  }>();

  if (!body.name) return c.json({ error: { code: "invalid", message: '"name" is required' } }, 422);

  const readScope = body.read ?? [];
  const writeScope = body.write ?? [];
  const parentRead = actor.read ?? ["*:*"];
  const parentWrite = actor.write ?? ["*:*"];

  if (!isScopeSubset(parentRead, readScope)) {
    return c.json({ error: { code: "forbidden", message: "Read scope exceeds parent" } }, 403);
  }
  if (!isScopeSubset(parentWrite, writeScope)) {
    return c.json({ error: { code: "forbidden", message: "Write scope exceeds parent" } }, 403);
  }

  const rawToken = `vlt_${ulid()}`;
  const tokenHash = await sha256(rawToken);
  const db = createDb(c.env.DB);

  await db
    .insert(tokens)
    .values({
      id: ulid(),
      tokenHash,
      name: body.name,
      accountId: actor.accountId ?? SYSTEM_ACCOUNT_ID,
      actorId: actor.id ?? SYSTEM_AUTHOR_ID,
      readScope: JSON.stringify(readScope),
      writeScope: JSON.stringify(writeScope),
      proposeOnly: body.propose_only ? 1 : 0,
      expiresAt: body.expires_at ? new Date(body.expires_at).getTime() : null,
      createdAt: Date.now(),
    })
    .run();

  return c.json({ token: rawToken, name: body.name, read: readScope, write: writeScope }, 201);
});

app.delete("/tokens/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  const db = createDb(c.env.DB);
  const token = await db
    .select({ actorId: tokens.actorId })
    .from(tokens)
    .where(eq(tokens.id, id))
    .get();
  if (!token) return c.json({ error: { code: "not_found", message: "Token not found" } }, 404);
  if (token.actorId !== actor.id && !actor.isSystem) {
    return c.json(
      { error: { code: "forbidden", message: "Cannot delete another actor's token" } },
      403,
    );
  }
  await db.delete(tokens).where(eq(tokens.id, id)).run();
  return c.json({ deleted: true });
});

// ─── Sources ─────────────────────────────────────────────────────────────────

app.post("/sources", async (c) => {
  const body = await c.req.json<{
    name: string;
    type: string;
    confidence?: string;
    config?: Record<string, unknown>;
  }>();

  if (!body.name || !body.type)
    return c.json({ error: { code: "invalid", message: '"name" and "type" are required' } }, 422);

  const validTypes = ["local_folder", "github", "confluence", "notion", "r2", "s3", "generic_git"];
  if (!validTypes.includes(body.type))
    return c.json({ error: { code: "invalid", message: `Invalid type: ${body.type}` } }, 422);

  const db = createDb(c.env.DB);
  const id = ulid();
  const authorId = ulid();

  await db.batch([
    db.insert(sources).values({
      id,
      name: body.name,
      type: body.type as (typeof sources.$inferInsert)["type"],
      config: JSON.stringify(body.config ?? {}),
      confidence: (body.confidence ?? "medium") as Confidence,
      status: "active",
      createdAt: Date.now(),
    }),
    db.insert(authors).values({
      id: authorId,
      name: body.name,
      kind: "system",
      sourceId: id,
      createdAt: Date.now(),
    }),
  ]);

  return c.json(
    { id, name: body.name, type: body.type, status: "active", author_id: authorId },
    201,
  );
});

app.patch("/sources/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: string; confidence?: string }>();
  const db = createDb(c.env.DB);
  const source = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, id)).get();
  if (!source) return c.json({ error: { code: "not_found", message: "Source not found" } }, 404);

  const updates: Partial<typeof sources.$inferInsert> = {};
  if (body.status) updates.status = body.status as (typeof sources.$inferInsert)["status"];
  if (body.confidence) updates.confidence = body.confidence as Confidence;
  if (!Object.keys(updates).length)
    return c.json({ error: { code: "invalid", message: "No fields to update" } }, 422);

  await db.update(sources).set(updates).where(eq(sources.id, id)).run();
  return c.json({ updated: true });
});

app.post("/sources/:id/import", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const source = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, id)).get();
  if (!source) return c.json({ error: { code: "not_found", message: "Source not found" } }, 404);

  const importId = ulid();
  await c.env.CACHE.put(
    `import:${importId}`,
    JSON.stringify({
      import_id: importId,
      source_id: id,
      status: "running",
      started_at: new Date().toISOString(),
      files_processed: 0,
      entries_created: 0,
      errors: [],
    }),
    { expirationTtl: 86400 },
  );

  return c.json(
    { import_id: importId, status: "running", started_at: new Date().toISOString() },
    202,
  );
});

app.get("/sources/:id/import/:importId", async (c) => {
  const importId = c.req.param("importId");
  const status = await c.env.CACHE.get(`import:${importId}`, "json");
  if (!status)
    return c.json({ error: { code: "not_found", message: "Import job not found" } }, 404);
  return c.json(status);
});

// ─── Subscriptions ────────────────────────────────────────────────────────────

app.post("/subscriptions", async (c) => {
  const actor = c.get("actor");
  const body = await c.req.json<{
    filter?: Record<string, unknown>;
    channel: string;
    url?: string;
    secret?: string;
  }>();

  if (!body.channel)
    return c.json({ error: { code: "invalid", message: '"channel" is required' } }, 422);
  const validChannels = ["webhook", "mcp", "polling"];
  if (!validChannels.includes(body.channel))
    return c.json({ error: { code: "invalid", message: `Invalid channel: ${body.channel}` } }, 422);
  if (body.channel === "webhook" && !body.url)
    return c.json({ error: { code: "invalid", message: '"url" required for webhook' } }, 422);

  const db = createDb(c.env.DB);
  const id = ulid();
  await db
    .insert(subscriptions)
    .values({
      id,
      actorId: actor.id ?? SYSTEM_AUTHOR_ID,
      filter: JSON.stringify(body.filter ?? {}),
      channel: body.channel as (typeof subscriptions.$inferInsert)["channel"],
      channelConfig: JSON.stringify(
        body.channel === "webhook" ? { url: body.url, secret: body.secret ?? "" } : {},
      ),
      createdAt: Date.now(),
    })
    .run();

  return c.json({ id, channel: body.channel, filter: body.filter ?? {} }, 201);
});

app.delete("/subscriptions/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  const db = createDb(c.env.DB);
  const sub = await db
    .select({ actorId: subscriptions.actorId })
    .from(subscriptions)
    .where(eq(subscriptions.id, id))
    .get();
  if (!sub) return c.json({ error: { code: "not_found", message: "Subscription not found" } }, 404);
  if (sub.actorId !== actor.id && !actor.isSystem) {
    return c.json(
      { error: { code: "forbidden", message: "Cannot delete another actor's subscription" } },
      403,
    );
  }
  await db.delete(subscriptions).where(eq(subscriptions.id, id)).run();
  return c.json({ deleted: true });
});

// ─── Advanced (admin scope) ───────────────────────────────────────────────────

app.get("/files/:slug/history", async (c) => {
  const actor = c.get("actor");
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, actor.accountId!), eq(files.id, slug))).get();
  if (!file)
    return c.json({ error: { code: "not_found", message: `File '${slug}' does not exist` } }, 404);
  const allEntries = await db
    .select({
      id: entries.id,
      sequenceNumber: entries.sequenceNumber,
      intent: entries.intent,
      type: entries.type,
      confidence: entries.confidence,
      authorId: entries.authorId,
      tombstone: entries.tombstone,
      createdAt: entries.createdAt,
    })
    .from(entries)
    .where(eq(entries.fileId, file.id))
    .orderBy(asc(entries.sequenceNumber))
    .all();
  return c.json({ entries: allEntries });
});

app.get("/files/:slug/conflicts", async (c) => {
  const actor = c.get("actor");
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, actor.accountId!), eq(files.id, slug))).get();
  if (!file)
    return c.json({ error: { code: "not_found", message: `File '${slug}' does not exist` } }, 404);
  const allConflicts = await db.select().from(conflicts).where(eq(conflicts.fileId, file.id)).all();
  return c.json({ conflicts: allConflicts });
});

app.post("/files/:slug/conflicts/:conflictId/resolve", async (c) => {
  const actor = c.get("actor");
  const slug = c.req.param("slug");
  const conflictId = c.req.param("conflictId");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, actor.accountId!), eq(files.id, slug))).get();
  if (!file)
    return c.json({ error: { code: "not_found", message: `File '${slug}' does not exist` } }, 404);

  const conflict = await db.select().from(conflicts).where(eq(conflicts.id, conflictId)).get();
  if (!conflict || conflict.status !== "open" || conflict.fileId !== file.id) {
    return c.json(
      { error: { code: "not_found", message: "Conflict not found or already resolved" } },
      404,
    );
  }

  const body = await c.req.json<{ content: string; supersedes?: string[] }>();
  if (!body.content)
    return c.json({ error: { code: "invalid", message: '"content" is required' } }, 422);

  const result = await appendEntry(c.env, {
    accountId: actor.accountId!,
    fileId: slug,
    content: body.content,
    contentRef: null,
    type: "note",
    intent: "supersedes",
    authorId: actor.id ?? SYSTEM_AUTHOR_ID,
    sourceId: SYSTEM_SOURCE_ID,
    confidence: "high",
    references: body.supersedes ?? [],
    idempotencyKey: ulid(),
  });

  await db.batch([
    db
      .update(conflicts)
      .set({ status: "resolved", resolvedAt: Date.now(), resolutionEntryId: result.id })
      .where(eq(conflicts.id, conflictId)),
    db.update(files).set({ status: "active" }).where(eq(files.id, file.id)),
  ]);

  return c.json({ resolved: true, entry_id: result.id });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────


function isScopeSubset(parent: string[], child: string[]): boolean {
  return child.every((childScope) => {
    const [ct, cs] = childScope.split(":");
    return parent.some((p) => {
      const [pt, ps] = p.split(":");
      return (pt === "*" || pt === ct) && (ps === "*" || ps === cs);
    });
  });
}


// ─── Auth helpers ────────────────────────────────────────────────────────────

async function validateAccessJwt(jwt: string, team: string): Promise<{ email: string } | null> {
  try {
    await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(atob(payloadB64)) as { email?: string; exp?: number };
    if (!payload.email) return null;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return { email: payload.email };
  } catch {
    return null;
  }
}

async function resolveHumanActor(
  db: ReturnType<typeof createDb>,
  email: string,
): Promise<ActorContext> {
  // Find existing author by email
  let author = await db.select().from(authors).where(eq(authors.name, email)).get();

  if (!author) {
    // Auto-provision: create account + author on first login
    const accountId = ulid();
    const authorId = ulid();
    const slug = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const now = Date.now();

    await db.batch([
      db.insert(accounts).values({ id: accountId, name: email, slug, createdAt: now }),
      db.insert(authors).values({ id: authorId, name: email, kind: "human", accountId, createdAt: now }),
    ]);

    return { id: authorId, accountId, kind: "human", email, read: ["*:*"], write: ["*:*"] };
  }

  // Author exists but has no account yet — create one
  if (!author.accountId) {
    const accountId = ulid();
    const slug = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "-");
    await db.batch([
      db.insert(accounts).values({ id: accountId, name: email, slug, createdAt: Date.now() }),
      db.update(authors).set({ accountId }).where(eq(authors.id, author.id)),
    ]);
    return { id: author.id, accountId, kind: "human", email, read: ["*:*"], write: ["*:*"] };
  }

  return { id: author.id, accountId: author.accountId, kind: "human", email, read: ["*:*"], write: ["*:*"] };
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.get("actor").accountId ?? SYSTEM_ACCOUNT_ID));

export default app;
