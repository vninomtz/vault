export type EntryType = "note" | "rule" | "skill" | "policy" | "context" | "agent";
export type Intent = "genesis" | "addition" | "correction" | "supersedes" | "retraction";
export type Confidence = "high" | "medium" | "low";
export type SourceType =
  | "local_folder"
  | "github"
  | "confluence"
  | "notion"
  | "r2"
  | "s3"
  | "generic_git";

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  CACHE: KVNamespace;
  WEBHOOKS: Queue;
  REBUILDER: DurableObjectNamespace;
  CF_ACCESS_TEAM: string;
  ENCRYPTION_KEY: string;
  VAULT_VERSION: string;
  ENVIRONMENT: string;
}

export interface ActorContext {
  id?: string;
  kind: "human" | "agent" | "system";
  email?: string;
  read?: string[];
  write?: string[];
  isSystem?: boolean;
}

export class ConflictError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`File is at version ${actual}, expected ${expected}`);
    this.name = "ConflictError";
  }
}

export interface AppendEntryParams {
  fileSlug: string;
  content: string | null;
  contentRef: string | null;
  type: EntryType;
  intent: Intent;
  authorId: string;
  sourceId: string;
  confidence: Confidence;
  references: string[];
  idempotencyKey: string;
  expectedVersion?: number;
}

export interface EntryResult {
  id: string;
  sequenceNumber: number;
  globalPosition: number;
  hlc: number;
  idempotent?: boolean;
}

export interface EntryContribution {
  content: string;
  confidence: Confidence;
  author: string;
  hlc: number;
}
