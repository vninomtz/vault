import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcp } from "./mcp";
import { eq, desc, asc, lt } from "drizzle-orm";
import { createDb } from "./db/index";
import { files, entries, tokens, sources, subscriptions, conflicts, authors } from "./db/schema";
import { appendEntry } from "./domain/append-log";
import { readProjection } from "./domain/projection-engine";
import { ulid, sha256 } from "./utils";
import { ConflictError } from "./types";
import type { Env, ActorContext, EntryType, Confidence, Intent } from "./types";

type Variables = { actor: ActorContext };
type HonoEnv = { Bindings: Env; Variables: Variables };

const SYSTEM_SOURCE_ID = "01SYSTEM000000000000000000";
const SYSTEM_AUTHOR_ID = "01SYSTEM000000000000000001";

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
  // TODO: auth disabled — re-enable when ready
  c.set("actor", { id: SYSTEM_AUTHOR_ID, kind: "system", isSystem: true, read: ["*:*"], write: ["*:*"] });
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

app.put("/files/:slug", async (c) => {
  const slug = c.req.param("slug");
  const actor = c.get("actor");
  if (!checkScope(actor.write ?? [], slug)) {
    return c.json({ error: { code: "forbidden", message: "No write access" } }, 403);
  }

  const body = await c.req.json<{
    content?: string;
    content_ref?: string;
    type?: string;
    if_version?: number;
    idempotency_key?: string;
    meta?: { confidence?: string; supersedes?: string[]; references?: string[] };
  }>();

  if (!body.type) return c.json({ error: { code: "invalid", message: '"type" is required' } }, 422);
  if (!body.content && !body.content_ref)
    return c.json(
      { error: { code: "invalid", message: '"content" or "content_ref" is required' } },
      422,
    );

  const validTypes = ["note", "rule", "skill", "policy", "context", "agent"];
  if (!validTypes.includes(body.type))
    return c.json({ error: { code: "invalid", message: `Invalid type: ${body.type}` } }, 422);

  const db = createDb(c.env.DB);
  const existingFile = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.slug, slug))
    .get();
  const intent: Intent = existingFile ? "addition" : "genesis";

  try {
    const result = await appendEntry(c.env, {
      fileSlug: slug,
      content: body.content ?? null,
      contentRef: body.content_ref ?? null,
      type: body.type as EntryType,
      intent,
      authorId: actor.id ?? SYSTEM_AUTHOR_ID,
      sourceId: SYSTEM_SOURCE_ID,
      confidence: (body.meta?.confidence ?? "medium") as Confidence,
      references: [...(body.meta?.supersedes ?? []), ...(body.meta?.references ?? [])],
      idempotencyKey: body.idempotency_key ?? ulid(),
      expectedVersion: body.if_version,
    });

    const file = await db.select().from(files).where(eq(files.slug, slug)).get();
    const projection = await readProjection(c.env, slug);
    const status = existingFile ? 200 : 201;

    return c.json(
      {
        file: {
          slug,
          type: file?.type,
          content: projection?.content ?? body.content,
          version: result.sequenceNumber,
          updated_at: new Date(file?.updatedAt ?? Date.now()).toISOString(),
          created_at: new Date(file?.createdAt ?? Date.now()).toISOString(),
        },
      },
      status as 200 | 201,
    );
  } catch (e) {
    if (e instanceof ConflictError) {
      return c.json(
        {
          error: {
            code: "conflict",
            message: e.message,
            details: { expected: e.expected, actual: e.actual },
          },
        },
        409,
      );
    }
    throw e;
  }
});

app.get("/files/:slug", async (c) => {
  const slug = c.req.param("slug");
  const actor = c.get("actor");
  if (!checkScope(actor.read ?? [], slug)) {
    return c.json({ error: { code: "forbidden", message: "No read access" } }, 403);
  }

  const db = createDb(c.env.DB);
  const file = await db.select().from(files).where(eq(files.slug, slug)).get();
  if (!file)
    return c.json({ error: { code: "not_found", message: `File '${slug}' does not exist` } }, 404);

  const projection = await readProjection(c.env, slug);
  if (!projection)
    return c.json({ error: { code: "not_found", message: `File '${slug}' does not exist` } }, 404);

  const accept = c.req.header("Accept") ?? "application/json";
  if (accept.includes("text/markdown")) {
    return c.text(projection.content);
  }

  return c.json({
    file: {
      slug: file.slug,
      type: file.type,
      content: projection.content,
      version: file.currentVersion,
      updated_at: new Date(file.updatedAt).toISOString(),
      created_at: new Date(file.createdAt).toISOString(),
      freshness: projection.freshness,
      has_conflicts: projection.hasConflicts,
    },
  });
});

app.get("/files", async (c) => {
  const type = c.req.query("type");
  const q = c.req.query("q");
  const hasConflictsParam = c.req.query("has_conflicts") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
  const cursor = c.req.query("cursor");

  const db = createDb(c.env.DB);

  let query = db
    .select()
    .from(files)
    .orderBy(desc(files.updatedAt))
    .limit(limit + 1)
    .$dynamic();

  if (type) query = query.where(eq(files.type, type as EntryType));
  if (cursor) query = query.where(lt(files.updatedAt, new Date(cursor).getTime()));

  const rows = await query.all();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const results = await Promise.all(
    page.map(async (file) => {
      if (hasConflictsParam) {
        const conflict = await db
          .select({ id: conflicts.id })
          .from(conflicts)
          .where(eq(conflicts.fileId, file.id))
          .get();
        if (!conflict) return null;
      }
      const projection = await readProjection(c.env, file.slug);
      const content = projection?.content ?? "";
      if (q && !content.toLowerCase().includes(q.toLowerCase())) return null;
      return {
        slug: file.slug,
        type: file.type,
        content,
        version: file.currentVersion,
        updated_at: new Date(file.updatedAt).toISOString(),
        freshness: projection?.freshness ?? "unknown",
      };
    }),
  );

  const filtered = results.filter(Boolean);
  const nextCursor = hasMore ? new Date(page[page.length - 1]?.updatedAt ?? 0).toISOString() : null;

  return c.json({ files: filtered, next_cursor: nextCursor, total: filtered.length });
});

// ─── Batch ────────────────────────────────────────────────────────────────────

app.post("/batch", async (c) => {
  const actor = c.get("actor");
  const body = await c.req.json<{
    atomic?: boolean;
    operations: Array<{
      method: "PUT";
      slug: string;
      content?: string;
      content_ref?: string;
      type: string;
      if_version?: number;
      idempotency_key?: string;
    }>;
  }>();

  if (!body.operations?.length)
    return c.json({ error: { code: "invalid", message: "No operations provided" } }, 422);
  if (body.operations.length > 50)
    return c.json({ error: { code: "invalid", message: "Maximum 50 operations per batch" } }, 422);

  const db = createDb(c.env.DB);
  const results: Array<{ slug: string; status: string; version?: number; error?: unknown }> = [];

  for (const op of body.operations) {
    if (!checkScope(actor.write ?? [], op.slug)) {
      if (body.atomic)
        return c.json(
          { error: { code: "forbidden", message: `No write access to '${op.slug}'` } },
          403,
        );
      results.push({ slug: op.slug, status: "forbidden" });
      continue;
    }

    const existingFile = await db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.slug, op.slug))
      .get();
    const intent: Intent = existingFile ? "addition" : "genesis";

    try {
      const result = await appendEntry(c.env, {
        fileSlug: op.slug,
        content: op.content ?? null,
        contentRef: op.content_ref ?? null,
        type: op.type as EntryType,
        intent,
        authorId: actor.id ?? SYSTEM_AUTHOR_ID,
        sourceId: SYSTEM_SOURCE_ID,
        confidence: "medium",
        references: [],
        idempotencyKey: op.idempotency_key ?? ulid(),
        expectedVersion: op.if_version,
      });
      results.push({ slug: op.slug, status: "ok", version: result.sequenceNumber });
    } catch (e) {
      if (e instanceof ConflictError) {
        if (body.atomic)
          return c.json({ error: { code: "conflict", message: `Conflict on '${op.slug}'` } }, 409);
        results.push({
          slug: op.slug,
          status: "conflict",
          error: { code: "conflict", details: { expected: e.expected, actual: e.actual } },
        });
      } else {
        if (body.atomic) throw e;
        results.push({ slug: op.slug, status: "error" });
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
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(eq(files.slug, slug)).get();
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
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(eq(files.slug, slug)).get();
  if (!file)
    return c.json({ error: { code: "not_found", message: `File '${slug}' does not exist` } }, 404);
  const allConflicts = await db.select().from(conflicts).where(eq(conflicts.fileId, file.id)).all();
  return c.json({ conflicts: allConflicts });
});

app.post("/files/:slug/conflicts/:conflictId/resolve", async (c) => {
  const slug = c.req.param("slug");
  const conflictId = c.req.param("conflictId");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(eq(files.slug, slug)).get();
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

  const actor = c.get("actor");
  const result = await appendEntry(c.env, {
    fileSlug: slug,
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

function checkScope(scopes: string[], slug: string): boolean {
  for (const scope of scopes) {
    const [scopeType, scopeSlug] = scope.split(":");
    const slugMatch = scopeSlug === "*" || matchGlob(scopeSlug ?? "*", slug);
    if (slugMatch) return true;
    void scopeType;
  }
  return scopes.length === 0;
}

function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const regex = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return regex.test(value);
}

function isScopeSubset(parent: string[], child: string[]): boolean {
  return child.every((childScope) => {
    const [ct, cs] = childScope.split(":");
    return parent.some((p) => {
      const [pt, ps] = p.split(":");
      return (pt === "*" || pt === ct) && (ps === "*" || ps === cs);
    });
  });
}


// ─── MCP ─────────────────────────────────────────────────────────────────────

app.all("/mcp", (c) => handleMcp(c.req.raw));

export default app;
