import { eq, max } from "drizzle-orm";
import { createDb } from "../db/index";
import { entries, files, entryReferences, snapshots } from "../db/schema";
import { ulid } from "../utils";
import { generateHLC } from "./hlc";
import { ConflictError } from "../types";
import type { Env, AppendEntryParams, EntryResult } from "../types";

async function nextGlobalPosition(db: ReturnType<typeof createDb>): Promise<number> {
  const row = await db.select({ max: max(entries.globalPosition) }).from(entries).get();
  return (row?.max ?? 0) + 1;
}

async function maybeSnapshot(
  db: ReturnType<typeof createDb>,
  fileId: string,
  sequenceNumber: number,
  snapshotPolicyJson: string,
): Promise<void> {
  const policy = JSON.parse(snapshotPolicyJson) as { type: string; value: number };
  if (policy.type !== "n_events" || sequenceNumber % policy.value !== 0) return;

  const allEntries = await db
    .select()
    .from(entries)
    .where(eq(entries.fileId, fileId))
    .orderBy(entries.sequenceNumber)
    .all();

  const state: Record<string, unknown> = {};
  for (const e of allEntries) {
    state[e.id] = { content: e.content, confidence: e.confidence, author: e.authorId, hlc: e.hlc };
  }

  await db
    .insert(snapshots)
    .values({
      id: ulid(),
      fileId,
      atSequence: sequenceNumber,
      state: JSON.stringify(Object.entries(state)),
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export async function appendEntry(env: Env, params: AppendEntryParams): Promise<EntryResult> {
  const db = createDb(env.DB);

  // 1. Deduplication
  const existing = await db
    .select({ id: entries.id, sequenceNumber: entries.sequenceNumber, globalPosition: entries.globalPosition, hlc: entries.hlc })
    .from(entries)
    .where(eq(entries.idempotencyKey, params.idempotencyKey))
    .get();
  if (existing) return { ...existing, idempotent: true };

  // 2. Get file (caller must ensure it exists)
  const file = await db.select().from(files).where(eq(files.id, params.fileId)).get();
  if (!file) throw new Error(`File ${params.fileId} not found`);

  // 3. Optimistic concurrency
  if (params.expectedVersion !== undefined && file.currentVersion !== params.expectedVersion) {
    throw new ConflictError(params.expectedVersion, file.currentVersion);
  }

  // 4. Generate IDs and positions
  const entryId = ulid();
  const sequenceNumber = file.currentVersion + 1;
  const globalPosition = await nextGlobalPosition(db);
  const hlc = generateHLC();
  const now = Date.now();

  // 5. Insert entry + update file version
  await db.batch([
    db.insert(entries).values({
      id: entryId,
      fileId: file.id,
      schemaVersion: 1,
      sequenceNumber,
      globalPosition,
      hlc,
      idempotencyKey: params.idempotencyKey,
      content: params.content,
      contentRef: params.contentRef,
      contentType: "text/markdown",
      type: params.type,
      intent: params.intent,
      tombstone: params.intent === "retraction" ? 1 : 0,
      authorId: params.authorId,
      sourceId: params.sourceId,
      confidence: params.confidence,
      createdAt: now,
    }),
    db.update(files).set({ currentVersion: sequenceNumber, updatedAt: now }).where(eq(files.id, file.id)),
  ]);

  // 6. References
  for (const refId of params.references) {
    await db.insert(entryReferences).values({ fromEntryId: entryId, toEntryId: refId }).onConflictDoNothing().run();
  }

  // 7. Invalidate KV cache
  await env.CACHE.delete(`projection:${params.accountId}:${file.name}`);
  await env.CACHE.delete(`projection_id:${file.id}`);

  // 8. Maybe snapshot
  await maybeSnapshot(db, file.id, sequenceNumber, file.snapshotPolicy);

  return { id: entryId, sequenceNumber, globalPosition, hlc };
}
