import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcp } from "./mcp";
import { validateAccessJWT } from "./auth";
import { eq, desc, asc, lt, and } from "drizzle-orm";
import { createDb } from "./db/index";
import { files, entries, authors, accounts } from "./db/schema";
import { appendEntry, replaceContent } from "./domain/append-log";
import { readProjection } from "./domain/projection-engine";
import { ulid } from "./utils";
import { ConflictError } from "./types";
import type { Env, ActorContext } from "./types";

type Variables = { actor: ActorContext };
type HonoEnv = { Bindings: Env; Variables: Variables };

const SYSTEM_SOURCE_ID = "01SYSTEM000000000000000000";
const SYSTEM_AUTHOR_ID = "01SYSTEM000000000000000001";
const SYSTEM_ACCOUNT_ID = "01SYSTEM000000000000000000";

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();
const api = app.basePath("/api");

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "CF-Access-Jwt-Assertion"],
    maxAge: 86400,
  }),
);

// ─── Auth ─────────────────────────────────────────────────────────────────────
//
// Authentication strategy with Cloudflare Access Managed OAuth:
//   - Access protects this Worker at the edge. For non-browser clients (Claude)
//     it runs the full OAuth flow (401 + WWW-Authenticate, discovery, token)
//     and forwards the request with a Cf-Access-Jwt-Assertion header.
//   - The Worker re-validates that JWT here as defense-in-depth, since the
//     workers.dev origin is publicly reachable.
//   - MCP clients are also expected to authenticate through Cloudflare Access.

app.use("*", async (c, next) => {
  // Skip auth for CORS preflight.
  if (c.req.method === "OPTIONS") {
    return next();
  }

  // Humans / MCP clients authenticate via Cloudflare Access. The JWT arrives in
  // the Cf-Access-Jwt-Assertion header (or CF_Authorization cookie for browser).
  const identity = await validateAccessJWT(c.req.raw, c.env);
  if (identity) {
    const db = createDb(c.env.DB);
    const actor = await resolveHumanActor(db, identity.email);
    c.set("actor", actor);
    return next();
  }

  // Local development bypass — only when explicitly in dev.
  if (c.env.ENVIRONMENT === "development") {
    c.set("actor", { id: SYSTEM_AUTHOR_ID, accountId: SYSTEM_ACCOUNT_ID, kind: "system", isSystem: true });
    return next();
  }

  // No valid credentials. Under Managed OAuth, Access normally issues the
  // 401 + WWW-Authenticate at the edge before requests reach the Worker; this
  // is the fallback for direct-to-origin requests.
  return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
});

// ─── Rate limit ───────────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  const actor = c.get("actor");
  if (!actor) return next(); // preflight and other actor-less requests
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
api.post("/files", async (c) => {
  const actor = c.get("actor");
  const body = await c.req.json<{
    name: string;
    content: string;
  }>();

  if (!body.name) return c.json({ error: { code: "invalid", message: '"name" is required' } }, 422);
  if (!body.content)
    return c.json({ error: { code: "invalid", message: '"content" is required' } }, 422);

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
    content: body.content,
    contentRef: null,
    type: "note",
    intent: "genesis",
    authorId: actor.id ?? SYSTEM_AUTHOR_ID,
    sourceId: SYSTEM_SOURCE_ID,
    confidence: "medium",
    references: [],
    idempotencyKey: ulid(),
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
api.put("/files/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("actor");
  const body = await c.req.json<{
    content: string;
    if_version?: number;
  }>();

  if (!body.content)
    return c.json({ error: { code: "invalid", message: '"content" is required' } }, 422);

  const db = createDb(c.env.DB);
  const file = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.accountId, actor.accountId!)))
    .get();
  if (!file) return c.json({ error: { code: "not_found", message: `File '${id}' not found` } }, 404);

  try {
    const result = await replaceContent(c.env, {
      accountId: actor.accountId!,
      fileId: file.id,
      content: body.content,
      authorId: actor.id ?? SYSTEM_AUTHOR_ID,
      sourceId: SYSTEM_SOURCE_ID,
      confidence: "medium",
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
api.patch("/files/:id", async (c) => {
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
api.get("/files/:id", async (c) => {
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
    },
  });
});

// GET /files — list/search
// ?id=      lookup by ID (redirects to canonical response)
// ?name=    exact name lookup
// ?prefix=  list files under a virtual path
// ?q=       full-text search
api.get("/files", async (c) => {
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

  // List with optional prefix / full-text — no content in response
  let query = db
    .select({ id: files.id, name: files.name, currentVersion: files.currentVersion, updatedAt: files.updatedAt })
    .from(files)
    .where(eq(files.accountId, actor.accountId!))
    .orderBy(desc(files.updatedAt))
    .limit(limit + 1)
    .$dynamic();

  if (cursor) query = query.where(and(eq(files.accountId, actor.accountId!), lt(files.updatedAt, new Date(cursor).getTime())));

  const rows = await query.all();
  const prefixFiltered = prefix ? rows.filter(f => f.name.startsWith(prefix)) : rows;
  const hasMore = prefixFiltered.length > limit;
  const page = prefixFiltered.slice(0, limit);

  // Full-text search requires loading projections — only when ?q= is present
  let out: typeof page;
  if (q) {
    const withMatch = await Promise.all(
      page.map(async (file) => {
        const projection = await readProjection(c.env, actor.accountId!, file.name);
        return (projection?.content ?? "").toLowerCase().includes(q.toLowerCase()) ? file : null;
      }),
    );
    out = withMatch.filter(Boolean) as typeof page;
  } else {
    out = page;
  }

  const nextCursor = hasMore ? new Date(page[page.length - 1]?.updatedAt ?? 0).toISOString() : null;

  return c.json({
    files: out.map(f => ({ id: f.id, name: f.name, version: f.currentVersion, updated_at: new Date(f.updatedAt).toISOString() })),
    next_cursor: nextCursor,
    total: out.length,
  });
});

// ─── Advanced ────────────────────────────────────────────────────────────────

api.get("/files/:id/history", async (c) => {
  const actor = c.get("actor");
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, actor.accountId!), eq(files.id, id))).get();
  if (!file)
    return c.json({ error: { code: "not_found", message: `File '${id}' does not exist` } }, 404);
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

// ─── Auth helpers ────────────────────────────────────────────────────────────

async function resolveHumanActor(
  db: ReturnType<typeof createDb>,
  email: string,
): Promise<ActorContext> {
  // Find existing author by email
  const author = await db.select().from(authors).where(eq(authors.name, email)).get();

  if (!author) {
    // Auto-provision: create account + author on first login
    const accountId = ulid();
    const authorId = ulid();
    const accountSlug = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const now = Date.now();

    await db.batch([
      db.insert(accounts).values({ id: accountId, name: email, slug: accountSlug, createdAt: now }),
      db.insert(authors).values({ id: authorId, name: email, kind: "human", accountId, createdAt: now }),
    ]);

    return { id: authorId, accountId, kind: "human", email };
  }

  // Author exists but has no account yet — create one
  if (!author.accountId) {
    const accountId = ulid();
    const accountSlug = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "-");
    await db.batch([
      db.insert(accounts).values({ id: accountId, name: email, slug: accountSlug, createdAt: Date.now() }),
      db.update(authors).set({ accountId }).where(eq(authors.id, author.id)),
    ]);
    return { id: author.id, accountId, kind: "human", email };
  }

  return { id: author.id, accountId: author.accountId, kind: "human", email };
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

api.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.get("actor").accountId ?? SYSTEM_ACCOUNT_ID));

export default app;
