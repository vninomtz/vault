import app from "./app";
import { syncScheduler } from "./background/sync-scheduler";
import type { Env } from "./types";

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await syncScheduler(event, env);
  },
};
