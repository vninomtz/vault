import app from "./app";
import { webhookDispatcher } from "./background/webhook-dispatcher";
import { syncScheduler } from "./background/sync-scheduler";
import type { Env } from "./types";

export { ProjectionRebuilder } from "./background/projection-rebuilder";

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await webhookDispatcher(
      batch as MessageBatch<{
        type: "notify" | "detect_conflicts";
        fileSlug?: string;
        fileType?: string;
        version?: number;
        fileId?: string;
        entryId?: string;
      }>,
      env,
    );
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await syncScheduler(event, env);
  },
};
