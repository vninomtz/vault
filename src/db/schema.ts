import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id", { length: 26 }).primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});


export const sources = sqliteTable(
  "sources",
  {
    id: text("id", { length: 26 }).primaryKey(),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["local_folder", "github", "confluence", "notion", "r2", "s3", "generic_git"],
    }).notNull(),
    config: text("config").notNull().default("{}"),
    confidence: text("confidence", { enum: ["high", "medium", "low"] })
      .notNull()
      .default("medium"),
    status: text("status", { enum: ["active", "paused", "removed"] })
      .notNull()
      .default("active"),
    lastSyncAt: integer("last_sync_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_sources_type").on(t.type), index("idx_sources_status").on(t.status)],
);

export const authors = sqliteTable(
  "authors",
  {
    id: text("id", { length: 26 }).primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["human", "agent", "system"] }).notNull(),
    accountId: text("account_id", { length: 26 }).references(() => accounts.id),
    sourceId: text("source_id", { length: 26 }).references(() => sources.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_authors_kind").on(t.kind),
    index("idx_authors_account_id").on(t.accountId),
    index("idx_authors_source_id").on(t.sourceId),
  ],
);

export const files = sqliteTable(
  "files",
  {
    id: text("id", { length: 26 }).primaryKey(),
    accountId: text("account_id", { length: 26 })
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["note", "rule", "skill", "policy", "context", "agent"],
    }).notNull(),
    currentVersion: integer("current_version").notNull().default(0),
    snapshotPolicy: text("snapshot_policy").notNull().default('{"type":"n_events","value":500}'),
    status: text("status", {
      enum: ["active", "archived", "conflicted", "stale"],
    })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_files_account_name").on(t.accountId, t.name),
    index("idx_files_account").on(t.accountId),
    index("idx_files_type").on(t.type),
    index("idx_files_status").on(t.status),
    index("idx_files_updated").on(t.updatedAt),
  ],
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id", { length: 26 }).primaryKey(),
    fileId: text("file_id", { length: 26 })
      .notNull()
      .references(() => files.id),
    schemaVersion: integer("schema_version").notNull().default(1),
    sequenceNumber: integer("sequence_number").notNull(),
    globalPosition: integer("global_position").notNull().unique(),
    hlc: integer("hlc").notNull(),
    idempotencyKey: text("idempotency_key", { length: 26 }).notNull().unique(),
    content: text("content"),
    contentRef: text("content_ref"),
    contentType: text("content_type").notNull().default("text/markdown"),
    type: text("type", {
      enum: ["note", "rule", "skill", "policy", "context", "agent"],
    }).notNull(),
    intent: text("intent", {
      enum: ["genesis", "addition", "correction", "supersedes", "retraction"],
    }).notNull(),
    tombstone: integer("tombstone").notNull().default(0),
    authorId: text("author_id", { length: 26 })
      .notNull()
      .references(() => authors.id),
    sourceId: text("source_id", { length: 26 })
      .notNull()
      .references(() => sources.id),
    confidence: text("confidence", { enum: ["high", "medium", "low"] })
      .notNull()
      .default("medium"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_entries_file_seq").on(t.fileId, t.sequenceNumber),
    index("idx_entries_global_pos").on(t.globalPosition),
    index("idx_entries_source_id").on(t.sourceId),
    index("idx_entries_author_id").on(t.authorId),
    index("idx_entries_type").on(t.type),
    index("idx_entries_hlc").on(t.hlc),
  ],
);

export const entryReferences = sqliteTable(
  "entry_references",
  {
    fromEntryId: text("from_entry_id", { length: 26 })
      .notNull()
      .references(() => entries.id),
    toEntryId: text("to_entry_id", { length: 26 })
      .notNull()
      .references(() => entries.id),
  },
  (t) => [
    primaryKey({ columns: [t.fromEntryId, t.toEntryId] }),
    index("idx_entry_refs_to").on(t.toEntryId),
  ],
);

export const projections = sqliteTable(
  "projections",
  {
    id: text("id", { length: 26 }).primaryKey(),
    fileId: text("file_id", { length: 26 })
      .notNull()
      .unique()
      .references(() => files.id),
    content: text("content").notNull(),
    lastGlobalPosition: integer("last_global_position").notNull(),
    materializedAt: integer("materialized_at").notNull(),
    freshness: text("freshness", { enum: ["fresh", "stale", "unknown"] })
      .notNull()
      .default("fresh"),
    rebuildStatus: text("rebuild_status", {
      enum: ["idle", "rebuilding", "stale"],
    })
      .notNull()
      .default("idle"),
  },
  (t) => [
    index("idx_projections_freshness").on(t.freshness),
    index("idx_projections_rebuild").on(t.rebuildStatus),
  ],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id", { length: 26 }).primaryKey(),
    fileId: text("file_id", { length: 26 })
      .notNull()
      .references(() => files.id),
    atSequence: integer("at_sequence").notNull(),
    state: text("state").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_snapshots_file_seq").on(t.fileId, t.atSequence),
    index("idx_snapshots_file_id").on(t.fileId),
  ],
);

export const upcasters = sqliteTable("upcasters", {
  id: text("id", { length: 26 }).primaryKey(),
  fromVersion: integer("from_version").notNull(),
  toVersion: integer("to_version").notNull(),
  transformFn: text("transform_fn").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const conflicts = sqliteTable(
  "conflicts",
  {
    id: text("id", { length: 26 }).primaryKey(),
    fileId: text("file_id", { length: 26 })
      .notNull()
      .references(() => files.id),
    status: text("status", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    detectedAt: integer("detected_at").notNull(),
    resolvedAt: integer("resolved_at"),
    resolutionEntryId: text("resolution_entry_id", { length: 26 }).references(() => entries.id),
  },
  (t) => [index("idx_conflicts_file_id").on(t.fileId), index("idx_conflicts_status").on(t.status)],
);

export const conflictEntries = sqliteTable(
  "conflict_entries",
  {
    conflictId: text("conflict_id", { length: 26 })
      .notNull()
      .references(() => conflicts.id),
    entryId: text("entry_id", { length: 26 })
      .notNull()
      .references(() => entries.id),
  },
  (t) => [primaryKey({ columns: [t.conflictId, t.entryId] })],
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id", { length: 26 }).primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    accountId: text("account_id", { length: 26 })
      .notNull()
      .references(() => accounts.id),
    actorId: text("actor_id", { length: 26 })
      .notNull()
      .references(() => authors.id),
    parentId: text("parent_id", { length: 26 }),
    readScope: text("read_scope").notNull().default("[]"),
    writeScope: text("write_scope").notNull().default("[]"),
    proposeOnly: integer("propose_only").notNull().default(0),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_tokens_actor_id").on(t.actorId),
    index("idx_tokens_account_id").on(t.accountId),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id", { length: 26 }).primaryKey(),
    actorId: text("actor_id", { length: 26 })
      .notNull()
      .references(() => authors.id),
    filter: text("filter").notNull().default("{}"),
    channel: text("channel", { enum: ["webhook", "mcp", "polling"] }).notNull(),
    channelConfig: text("channel_config").notNull().default("{}"),
    lastNotifiedAt: integer("last_notified_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_subscriptions_actor_id").on(t.actorId)],
);
