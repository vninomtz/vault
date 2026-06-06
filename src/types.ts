export type EntryType = "note" | "rule" | "skill" | "policy" | "context" | "agent";
export type Intent = "genesis" | "addition" | "correction" | "supersedes" | "retraction";
export type Confidence = "high" | "medium" | "low";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CACHE: KVNamespace;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ENCRYPTION_KEY: string;
  ENVIRONMENT: string;
}

export interface ActorContext {
  id?: string;
  accountId?: string;
  kind: "human" | "agent" | "system";
  email?: string;
  isSystem?: boolean;
}

export type HonoVariables = { actor: ActorContext };
export type HonoEnv = { Bindings: Env; Variables: HonoVariables };

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
  accountId: string;
  fileId: string;
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
