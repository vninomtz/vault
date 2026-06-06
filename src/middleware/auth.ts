import { eq } from "drizzle-orm";
import { validateAccessJWT } from "../auth";
import { createDb } from "../db/index";
import { authors, accounts } from "../db/schema";
import { ulid } from "../utils";
import { SYSTEM_AUTHOR_ID, SYSTEM_ACCOUNT_ID } from "../constants";
import type { MiddlewareHandler } from "hono";
import type { ActorContext, HonoEnv } from "../types";

export const authMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();

  const identity = await validateAccessJWT(c.req.raw, c.env);
  if (identity) {
    const db = createDb(c.env.DB);
    const actor = await resolveHumanActor(db, identity.email);
    c.set("actor", actor);
    return next();
  }

  if (c.env.ENVIRONMENT === "development") {
    c.set("actor", { id: SYSTEM_AUTHOR_ID, accountId: SYSTEM_ACCOUNT_ID, kind: "system", isSystem: true });
    return next();
  }

  return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
};

async function resolveHumanActor(
  db: ReturnType<typeof createDb>,
  email: string,
): Promise<ActorContext> {
  const author = await db.select().from(authors).where(eq(authors.name, email)).get();

  if (!author) {
    const accountId = ulid();
    const authorId = ulid();
    const accountSlug = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const now = Date.now();
    await db.batch([
      db.insert(accounts).values({ id: accountId, name: email, slug: accountSlug, createdAt: now }),
      db.insert(authors).values({ id: authorId, name: email, kind: "human", accountId, createdAt: now }),
    ]);
    return { id: authorId, accountId, kind: "human", email };
  }

  if (!author.accountId) {
    const accountId = ulid();
    const accountSlug = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "-");
    await db.batch([
      db.insert(accounts).values({ id: accountId, name: email, slug: accountSlug, createdAt: Date.now() }),
      db.update(authors).set({ accountId }).where(eq(authors.id, author.id)),
    ]);
    return { id: author.id, accountId, kind: "human", email };
  }

  return { id: author.id, accountId: author.accountId, kind: "human", email };
}
