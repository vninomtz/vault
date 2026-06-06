import type { MiddlewareHandler } from "hono";
import type { HonoEnv } from "../types";

export const rateLimitMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const actor = c.get("actor");
  if (!actor) return next();

  const actorId = actor.id ?? actor.email ?? "anonymous";
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl:${actorId}:${minute}`;
  const isWrite = ["PUT", "POST", "PATCH", "DELETE"].includes(c.req.method);
  const limit = isWrite ? 100 : 500;

  const current = parseInt((await c.env.CACHE.get(key)) ?? "0", 10);
  if (current >= limit)
    return c.json({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429);

  await c.env.CACHE.put(key, String(current + 1), { expirationTtl: 120 });
  return next();
};
