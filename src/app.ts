import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { handleMcp } from "./mcp";
import {
  handleCreateFile,
  handleUpdateFile,
  handleRenameFile,
  handleGetFile,
  handleListFiles,
  handleGetFileHistory,
} from "./handlers/files";
import { SYSTEM_ACCOUNT_ID } from "./constants";
import type { HonoEnv } from "./types";

const app = new Hono<HonoEnv>();
const api = app.basePath("/api");

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "CF-Access-Jwt-Assertion"],
  maxAge: 86400,
}));
app.use("*", authMiddleware);
app.use("*", rateLimitMiddleware);

api.post("/files", handleCreateFile);
api.put("/files/:id", handleUpdateFile);
api.patch("/files/:id", handleRenameFile);
api.get("/files/:id/history", handleGetFileHistory);
api.get("/files/:id", handleGetFile);
api.get("/files", handleListFiles);
api.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.get("actor").accountId ?? SYSTEM_ACCOUNT_ID));

export default app;
