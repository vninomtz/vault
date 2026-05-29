import type { InferSelectModel } from "drizzle-orm";
import type { entries } from "../db/schema";

export type EntryRow = InferSelectModel<typeof entries>;

type UpcasterFn = (entry: Record<string, unknown>) => Record<string, unknown>;

const UPCASTERS: Record<string, UpcasterFn> = {
  "1->2": (entry) => ({ ...entry, confidence: entry["confidence"] ?? "medium" }),
  "2->3": (entry) => ({
    ...entry,
    content_type: entry["content_type"] ?? "text/markdown",
  }),
};

const CURRENT_SCHEMA_VERSION = 1;

export function upcast(entry: EntryRow): EntryRow {
  let result = entry as unknown as Record<string, unknown>;
  let version = entry.schemaVersion;

  while (version < CURRENT_SCHEMA_VERSION) {
    const fn = UPCASTERS[`${version}->${version + 1}`];
    if (!fn) throw new Error(`No upcaster from ${version} to ${version + 1}`);
    result = fn(result);
    version++;
  }

  return { ...result, schemaVersion: CURRENT_SCHEMA_VERSION } as unknown as EntryRow;
}
