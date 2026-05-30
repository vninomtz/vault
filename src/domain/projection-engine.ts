import { eq, asc, desc, and } from "drizzle-orm";
import { createDb } from "../db/index";
import {
  entries,
  files,
  projections,
  snapshots,
  entryReferences,
  conflicts,
} from "../db/schema";
import { ulid } from "../utils";
import { upcast } from "./upcaster";
import type { Env, EntryContribution } from "../types";

async function getReferences(db: ReturnType<typeof createDb>, entryId: string): Promise<string[]> {
  const rows = await db
    .select({ toEntryId: entryReferences.toEntryId })
    .from(entryReferences)
    .where(eq(entryReferences.fromEntryId, entryId))
    .all();
  return rows.map((r) => r.toEntryId);
}

export async function materializeProjection(env: Env, fileId: string): Promise<string> {
  const db = createDb(env.DB);

  // 1. Most recent snapshot
  const snapshot = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.fileId, fileId))
    .orderBy(desc(snapshots.atSequence))
    .limit(1)
    .get();

  const fromSequence = snapshot ? snapshot.atSequence + 1 : 0;
  const baseState: Map<string, EntryContribution> = snapshot
    ? new Map(JSON.parse(snapshot.state) as Array<[string, EntryContribution]>)
    : new Map();

  // 2. Load entries since snapshot
  const allEntries = await db
    .select()
    .from(entries)
    .where(eq(entries.fileId, fileId))
    .orderBy(asc(entries.sequenceNumber))
    .all();

  const relevantEntries = allEntries.filter((e) => e.sequenceNumber >= fromSequence);

  // 3. Apply each entry
  const state = new Map(baseState);

  for (const rawEntry of relevantEntries) {
    const entry = upcast(rawEntry);

    if (entry.tombstone) {
      const refs = await getReferences(db, entry.id);
      for (const refId of refs) state.delete(refId);
      continue;
    }

    switch (entry.intent) {
      case "genesis":
      case "addition":
        state.set(entry.id, {
          content: entry.content ?? "",
          confidence: entry.confidence,
          author: entry.authorId,
          hlc: entry.hlc,
        });
        break;

      case "correction":
      case "supersedes": {
        const refs = await getReferences(db, entry.id);
        for (const refId of refs) state.delete(refId);
        state.set(entry.id, {
          content: entry.content ?? "",
          confidence: entry.confidence,
          author: entry.authorId,
          hlc: entry.hlc,
        });
        break;
      }
    }
  }

  // 4. Build markdown ordered by HLC
  const contributions = Array.from(state.values()).sort((a, b) => a.hlc - b.hlc);
  const markdown = contributions.map((c) => c.content).join("\n\n---\n\n");

  // 5. Persist
  const lastEntry = relevantEntries[relevantEntries.length - 1];
  const lastGlobalPosition = lastEntry?.globalPosition ?? snapshot?.atSequence ?? 0;
  const now = Date.now();

  await env.CACHE.put(
    `projection_id:${fileId}`,
    JSON.stringify({ content: markdown, freshness: "fresh" }),
    { expirationTtl: 3600 },
  );

  await db
    .insert(projections)
    .values({
      id: ulid(),
      fileId,
      content: markdown,
      lastGlobalPosition,
      materializedAt: now,
      freshness: "fresh",
      rebuildStatus: "idle",
    })
    .onConflictDoUpdate({
      target: projections.fileId,
      set: {
        content: markdown,
        lastGlobalPosition,
        materializedAt: now,
        freshness: "fresh",
        rebuildStatus: "idle",
      },
    })
    .run();

  return markdown;
}

export async function readProjection(
  env: Env,
  accountId: string,
  fileSlug: string,
): Promise<{ content: string; freshness: string; hasConflicts: boolean } | null> {
  // 1. KV cache by account+slug
  const cacheKey = `projection:${accountId}:${fileSlug}`;
  const cached = await env.CACHE.get<{ content: string; freshness: string }>(cacheKey, "json");
  if (cached) return { ...cached, hasConflicts: false };

  const db = createDb(env.DB);

  // 2. Find File (scoped to account)
  const file = await db
    .select({ id: files.id, status: files.status })
    .from(files)
    .where(and(eq(files.accountId, accountId), eq(files.name, fileSlug)))
    .get();
  if (!file) return null;

  // 3. KV cache by file ID
  const cachedById = await env.CACHE.get<{ content: string; freshness: string }>(
    `projection_id:${file.id}`,
    "json",
  );
  if (cachedById) {
    await env.CACHE.put(cacheKey, JSON.stringify(cachedById), { expirationTtl: 3600 });
    const openConflict = await db
      .select({ id: conflicts.id })
      .from(conflicts)
      .where(eq(conflicts.fileId, file.id))
      .get();
    return { ...cachedById, hasConflicts: !!openConflict };
  }

  // 4. Materialize from log
  const content = await materializeProjection(env, file.id);
  await env.CACHE.put(cacheKey, JSON.stringify({ content, freshness: "fresh" }), {
    expirationTtl: 3600,
  });
  const openConflict = await db
    .select({ id: conflicts.id })
    .from(conflicts)
    .where(eq(conflicts.fileId, file.id))
    .get();
  return { content, freshness: "fresh", hasConflicts: !!openConflict };
}
