import { eq, desc, asc, lt, and, like, ne } from "drizzle-orm";
import { createDb } from "../db/index";
import { files, entries } from "../db/schema";
import { appendEntry, replaceContent } from "../domain/append-log";
import { readProjection } from "../domain/projection-engine";
import { ulid } from "../utils";
import { SYSTEM_SOURCE_ID } from "../constants";
import { ConflictError } from "../types";
import type { Env } from "../types";

export class FileExistsError extends Error {
  constructor(
    public readonly name: string,
    public readonly existingId: string,
  ) {
    super(`File '${name}' already exists`);
  }
}

export class FileNotFoundError extends Error {
  constructor(public readonly ref: string) {
    super(`File '${ref}' not found`);
  }
}

export { ConflictError };

export interface FileResult {
  id: string;
  name: string;
  content: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  freshness?: string;
}

export interface FileListResult {
  files: Array<{ id: string; name: string; version: number; updatedAt: number }>;
  nextCursor: string | null;
}

export interface HistoryEntry {
  id: string;
  sequenceNumber: number;
  intent: string;
  type: string;
  confidence: string;
  authorId: string;
  tombstone: number;
  createdAt: number;
}

export async function createFile(
  env: Env,
  accountId: string,
  authorId: string,
  params: { name: string; content: string },
): Promise<FileResult> {
  const db = createDb(env.DB);

  const existing = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.accountId, accountId), eq(files.name, params.name)))
    .get();
  if (existing) throw new FileExistsError(params.name, existing.id);

  const fileId = ulid();
  const now = Date.now();
  await db
    .insert(files)
    .values({ id: fileId, accountId, name: params.name, type: "note", currentVersion: 0, status: "active", createdAt: now, updatedAt: now })
    .run();

  const result = await appendEntry(env, {
    accountId,
    fileId,
    content: params.content,
    contentRef: null,
    type: "note",
    intent: "genesis",
    authorId,
    sourceId: SYSTEM_SOURCE_ID,
    confidence: "medium",
    references: [],
    idempotencyKey: ulid(),
  });

  return { id: fileId, name: params.name, content: params.content, version: result.sequenceNumber, createdAt: now, updatedAt: now };
}

export async function readFileById(env: Env, accountId: string, id: string): Promise<FileResult | null> {
  const db = createDb(env.DB);
  const file = await db.select().from(files).where(and(eq(files.id, id), eq(files.accountId, accountId), ne(files.status, "archived"))).get();
  if (!file) return null;

  const projection = await readProjection(env, accountId, file.name);
  if (!projection) return null;

  return {
    id: file.id,
    name: file.name,
    content: projection.content,
    version: file.currentVersion,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    freshness: projection.freshness,
  };
}

export async function readFileByName(env: Env, accountId: string, name: string): Promise<FileResult | null> {
  const db = createDb(env.DB);
  const file = await db.select().from(files).where(and(eq(files.accountId, accountId), eq(files.name, name), ne(files.status, "archived"))).get();
  if (!file) return null;

  const projection = await readProjection(env, accountId, file.name);
  if (!projection) return null;

  return {
    id: file.id,
    name: file.name,
    content: projection.content,
    version: file.currentVersion,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    freshness: projection.freshness,
  };
}

export async function updateFile(
  env: Env,
  accountId: string,
  authorId: string,
  params: { fileId: string; content: string; expectedVersion?: number },
): Promise<FileResult> {
  const db = createDb(env.DB);
  const file = await db.select().from(files).where(and(eq(files.id, params.fileId), eq(files.accountId, accountId))).get();
  if (!file) throw new FileNotFoundError(params.fileId);

  const result = await replaceContent(env, {
    accountId,
    fileId: file.id,
    content: params.content,
    authorId,
    sourceId: SYSTEM_SOURCE_ID,
    confidence: "medium",
    expectedVersion: params.expectedVersion,
  });

  const projection = await readProjection(env, accountId, file.name);
  return {
    id: file.id,
    name: file.name,
    content: projection?.content ?? params.content,
    version: result.sequenceNumber,
    createdAt: file.createdAt,
    updatedAt: Date.now(),
  };
}

export async function renameFile(
  env: Env,
  accountId: string,
  params: { fileId: string; newName: string },
): Promise<{ id: string; name: string }> {
  const db = createDb(env.DB);

  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.id, params.fileId), eq(files.accountId, accountId))).get();
  if (!file) throw new FileNotFoundError(params.fileId);

  const conflict = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, accountId), eq(files.name, params.newName))).get();
  if (conflict) throw new FileExistsError(params.newName, conflict.id);

  await db.update(files).set({ name: params.newName, updatedAt: Date.now() }).where(eq(files.id, params.fileId)).run();
  return { id: file.id, name: params.newName };
}

export async function listFiles(
  env: Env,
  accountId: string,
  params: { prefix?: string; q?: string; limit?: number; cursor?: string },
): Promise<FileListResult> {
  const db = createDb(env.DB);
  const limit = Math.min(params.limit ?? 20, 100);

  const conditions = [
    eq(files.accountId, accountId),
    ne(files.status, "archived"),
    ...(params.cursor ? [lt(files.updatedAt, new Date(params.cursor).getTime())] : []),
    ...(params.prefix ? [like(files.name, `${params.prefix}%`)] : []),
  ];

  const rows = await db
    .select({ id: files.id, name: files.name, currentVersion: files.currentVersion, updatedAt: files.updatedAt })
    .from(files)
    .where(and(...conditions))
    .orderBy(desc(files.updatedAt))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  let out: typeof page;
  if (params.q) {
    const withMatch = await Promise.all(
      page.map(async (file) => {
        const projection = await readProjection(env, accountId, file.name);
        return (projection?.content ?? "").toLowerCase().includes(params.q!.toLowerCase()) ? file : null;
      }),
    );
    out = withMatch.filter(Boolean) as typeof page;
  } else {
    out = page;
  }

  const nextCursor = hasMore ? new Date(page[page.length - 1]?.updatedAt ?? 0).toISOString() : null;
  return {
    files: out.map((f) => ({ id: f.id, name: f.name, version: f.currentVersion, updatedAt: f.updatedAt })),
    nextCursor,
  };
}

export async function deleteFile(env: Env, accountId: string, fileId: string): Promise<void> {
  const db = createDb(env.DB);
  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.accountId, accountId), ne(files.status, "archived"))).get();
  if (!file) throw new FileNotFoundError(fileId);
  await db.update(files).set({ status: "archived", updatedAt: Date.now() }).where(eq(files.id, fileId)).run();
}

export async function getFileHistory(env: Env, accountId: string, fileId: string): Promise<HistoryEntry[]> {
  const db = createDb(env.DB);
  const file = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, accountId), eq(files.id, fileId))).get();
  if (!file) throw new FileNotFoundError(fileId);

  return db
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
}
