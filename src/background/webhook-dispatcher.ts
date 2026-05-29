import { eq } from "drizzle-orm";
import { createDb } from "../db/index";
import { subscriptions } from "../db/schema";
import { hmacSha256 } from "../utils";
import { detectConflicts } from "../domain/conflict-detector";
import type { Env } from "../types";

interface QueueMessage {
  type: "notify" | "detect_conflicts";
  fileSlug?: string;
  fileType?: string;
  version?: number;
  fileId?: string;
  entryId?: string;
}

async function deliverWebhook(
  sub: { id: string; channelConfig: string },
  payload: object,
  env: Env,
): Promise<void> {
  const config = JSON.parse(sub.channelConfig) as { url?: string; secret?: string };
  if (!config.url) return;

  const body = JSON.stringify(payload);
  const signature = config.secret ? await hmacSha256(config.secret, body) : "";

  try {
    await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature && { "X-Vault-Signature": `sha256=${signature}` }),
      },
      body,
    });
    const db = createDb(env.DB);
    await db
      .update(subscriptions)
      .set({ lastNotifiedAt: Date.now() })
      .where(eq(subscriptions.id, sub.id))
      .run();
  } catch {
    // Non-fatal
  }
}

export async function webhookDispatcher(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  const db = createDb(env.DB);

  for (const message of batch.messages) {
    const payload = message.body;

    if (payload.type === "notify" && payload.fileSlug) {
      const allSubs = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.channel, "webhook"))
        .all();

      const matching = allSubs.filter((sub) => {
        const filter = JSON.parse(sub.filter) as Record<string, unknown>;
        if (filter["type"] && filter["type"] !== payload.fileType) return false;
        return true;
      });

      for (const sub of matching) {
        await deliverWebhook(
          sub,
          {
            event: "file.updated",
            slug: payload.fileSlug,
            type: payload.fileType,
            version: payload.version,
            updated_at: new Date().toISOString(),
          },
          env,
        );
      }
    }

    if (payload.type === "detect_conflicts" && payload.fileId && payload.entryId) {
      await detectConflicts(env, payload.fileId, payload.entryId);
    }

    message.ack();
  }
}
