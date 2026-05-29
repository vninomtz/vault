import { eq, desc } from "drizzle-orm";
import { createDb } from "../db/index";
import { entries, conflicts, conflictEntries, files } from "../db/schema";
import { ulid } from "../utils";
import type { Env } from "../types";

function extractSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split("\n");
  let currentHeading = "";
  const currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith("#")) {
      if (currentHeading) sections.set(currentHeading, currentBody.join("\n").trim());
      currentHeading = line.replace(/^#+\s*/, "").toLowerCase();
      currentBody.length = 0;
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading) sections.set(currentHeading, currentBody.join("\n").trim());
  return sections;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const wordsA = new Set(a.toLowerCase().split(/\W+/));
  const wordsB = new Set(b.toLowerCase().split(/\W+/));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

const OPPOSITE_PAIRS = [
  ["sync", "async"],
  ["always", "never"],
  ["required", "optional"],
  ["enabled", "disabled"],
  ["allow", "deny"],
  ["postgres", "mysql"],
] as const;

function hasSemanticConflict(contentA: string, contentB: string): boolean {
  const sectionsA = extractSections(contentA);
  const sectionsB = extractSections(contentB);
  for (const [heading, bodyA] of sectionsA) {
    const bodyB = sectionsB.get(heading);
    if (bodyB && similarity(bodyA, bodyB) < 0.3 && bodyA.length > 50) return true;
  }
  for (const [a, b] of OPPOSITE_PAIRS) {
    if (contentA.includes(a) && contentB.includes(b)) return true;
    if (contentA.includes(b) && contentB.includes(a)) return true;
  }
  return false;
}

export async function detectConflicts(env: Env, fileId: string, newEntryId: string): Promise<void> {
  const db = createDb(env.DB);

  const newEntry = await db.select().from(entries).where(eq(entries.id, newEntryId)).get();
  if (!newEntry || newEntry.tombstone || !newEntry.content) return;

  const recentEntries = await db
    .select()
    .from(entries)
    .where(eq(entries.fileId, fileId))
    .orderBy(desc(entries.sequenceNumber))
    .limit(21)
    .all();

  const others = recentEntries.filter((e) => e.id !== newEntryId && !e.tombstone && e.content);

  for (const entry of others) {
    if (!entry.content) continue;
    if (hasSemanticConflict(newEntry.content, entry.content)) {
      const conflictId = ulid();
      await db.batch([
        db.insert(conflicts).values({
          id: conflictId,
          fileId,
          status: "open",
          detectedAt: Date.now(),
        }),
        db.insert(conflictEntries).values({ conflictId, entryId: newEntryId }),
        db.insert(conflictEntries).values({ conflictId, entryId: entry.id }),
        db.update(files).set({ status: "conflicted" }).where(eq(files.id, fileId)),
      ]);
      return;
    }
  }
}
