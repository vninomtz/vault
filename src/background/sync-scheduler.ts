import { eq } from "drizzle-orm";
import { createDb } from "../db/index";
import { sources, authors } from "../db/schema";
import { appendEntry } from "../domain/append-log";
import type { Env, EntryType, Intent } from "../types";
import type { InferSelectModel } from "drizzle-orm";

type SourceRow = InferSelectModel<typeof sources>;

interface RawChange {
  slug: string;
  content: string;
  type: EntryType;
  intent: Intent;
  idempotencyKey: string;
}

interface Connector {
  fetchChanges(source: SourceRow, since: number | null): Promise<RawChange[]>;
}

// Placeholder connectors — real implementations go in src/connectors/
const connectors: Record<string, Connector> = {
  local_folder: {
    async fetchChanges() {
      return [];
    },
  },
  github: {
    async fetchChanges() {
      return [];
    },
  },
  confluence: {
    async fetchChanges() {
      return [];
    },
  },
  notion: {
    async fetchChanges() {
      return [];
    },
  },
  r2: {
    async fetchChanges() {
      return [];
    },
  },
  s3: {
    async fetchChanges() {
      return [];
    },
  },
  generic_git: {
    async fetchChanges() {
      return [];
    },
  },
};

async function syncSource(env: Env, source: SourceRow): Promise<void> {
  const connector = connectors[source.type];
  if (!connector) return;

  const changes = await connector.fetchChanges(source, source.lastSyncAt);
  const db = createDb(env.DB);

  const authorRow = await db
    .select({ id: authors.id })
    .from(authors)
    .where(eq(authors.sourceId, source.id))
    .get();
  const authorId = authorRow?.id ?? "01SYSTEM000000000000000001";

  for (const change of changes) {
    await appendEntry(env, {
      fileSlug: change.slug,
      content: change.content,
      contentRef: null,
      type: change.type,
      intent: change.intent,
      authorId,
      sourceId: source.id,
      confidence: source.confidence,
      references: [],
      idempotencyKey: change.idempotencyKey,
    });
  }

  await db.update(sources).set({ lastSyncAt: Date.now() }).where(eq(sources.id, source.id)).run();
}

export async function syncScheduler(_event: ScheduledEvent, env: Env): Promise<void> {
  const db = createDb(env.DB);
  const activeSources = await db.select().from(sources).where(eq(sources.status, "active")).all();

  await Promise.allSettled(activeSources.map((source) => syncSource(env, source)));
}
