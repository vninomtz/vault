import type { Context } from "hono";
import { SYSTEM_AUTHOR_ID } from "../constants";
import {
  createFile,
  readFileById,
  readFileByName,
  updateFile,
  renameFile,
  deleteFile,
  listFiles,
  getFileHistory,
  FileExistsError,
  FileNotFoundError,
  ConflictError,
} from "../services/files";
import type { HonoEnv } from "../types";
import type { FileResult } from "../services/files";

type FC = Context<HonoEnv>;

function toFileResponse(f: FileResult) {
  return {
    id: f.id,
    name: f.name,
    content: f.content,
    version: f.version,
    created_at: new Date(f.createdAt).toISOString(),
    updated_at: new Date(f.updatedAt).toISOString(),
    ...(f.freshness ? { freshness: f.freshness } : {}),
  };
}

export async function handleCreateFile(c: FC) {
  const actor = c.get("actor");
  const body = await c.req.json<{ name: string; content: string }>();
  if (!body.name) return c.json({ error: { code: "invalid", message: '"name" is required' } }, 422);
  if (!body.content) return c.json({ error: { code: "invalid", message: '"content" is required' } }, 422);

  try {
    const file = await createFile(c.env, actor.accountId!, actor.id ?? SYSTEM_AUTHOR_ID, body);
    return c.json({ file: toFileResponse(file) }, 201);
  } catch (e) {
    if (e instanceof FileExistsError)
      return c.json({ error: { code: "conflict", message: e.message, details: { id: e.existingId } } }, 409);
    throw e;
  }
}

export async function handleUpdateFile(c: FC) {
  const actor = c.get("actor");
  const body = await c.req.json<{ content: string; if_version?: number }>();
  if (!body.content) return c.json({ error: { code: "invalid", message: '"content" is required' } }, 422);

  try {
    const file = await updateFile(c.env, actor.accountId!, actor.id ?? SYSTEM_AUTHOR_ID, {
      fileId: c.req.param("id")!,
      content: body.content,
      expectedVersion: body.if_version,
    });
    return c.json({ file: toFileResponse(file) });
  } catch (e) {
    if (e instanceof FileNotFoundError)
      return c.json({ error: { code: "not_found", message: e.message } }, 404);
    if (e instanceof ConflictError)
      return c.json({ error: { code: "conflict", message: e.message, details: { expected: e.expected, actual: e.actual } } }, 409);
    throw e;
  }
}

export async function handleRenameFile(c: FC) {
  const actor = c.get("actor");
  const body = await c.req.json<{ name: string }>();
  if (!body.name) return c.json({ error: { code: "invalid", message: '"name" is required' } }, 422);

  try {
    const result = await renameFile(c.env, actor.accountId!, { fileId: c.req.param("id")!, newName: body.name });
    return c.json({ updated: true, name: result.name });
  } catch (e) {
    if (e instanceof FileNotFoundError)
      return c.json({ error: { code: "not_found", message: e.message } }, 404);
    if (e instanceof FileExistsError)
      return c.json({ error: { code: "conflict", message: e.message } }, 409);
    throw e;
  }
}

export async function handleGetFile(c: FC) {
  const actor = c.get("actor");
  const id = c.req.param("id")!;
  const file = await readFileById(c.env, actor.accountId!, id);
  if (!file) return c.json({ error: { code: "not_found", message: `File '${id}' not found` } }, 404);

  const accept = c.req.header("Accept") ?? "application/json";
  if (accept.includes("text/markdown")) return c.text(file.content);

  return c.json({ file: toFileResponse(file) });
}

export async function handleListFiles(c: FC) {
  const actor = c.get("actor");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);

  const idParam = c.req.query("id");
  if (idParam) {
    const file = await readFileById(c.env, actor.accountId!, idParam);
    if (!file) return c.json({ error: { code: "not_found", message: `File '${idParam}' not found` } }, 404);
    return c.json({ file: toFileResponse(file) });
  }

  const nameParam = c.req.query("name");
  if (nameParam) {
    const file = await readFileByName(c.env, actor.accountId!, nameParam);
    if (!file) return c.json({ error: { code: "not_found", message: `File '${nameParam}' not found` } }, 404);
    return c.json({ file: toFileResponse(file) });
  }

  const result = await listFiles(c.env, actor.accountId!, {
    prefix: c.req.query("prefix"),
    q: c.req.query("q"),
    limit,
    cursor: c.req.query("cursor"),
  });

  return c.json({
    files: result.files.map((f) => ({ id: f.id, name: f.name, version: f.version, updated_at: new Date(f.updatedAt).toISOString() })),
    next_cursor: result.nextCursor,
    total: result.files.length,
  });
}

export async function handleDeleteFile(c: FC) {
  const actor = c.get("actor");
  try {
    await deleteFile(c.env, actor.accountId!, c.req.param("id")!);
    return c.body(null, 204);
  } catch (e) {
    if (e instanceof FileNotFoundError)
      return c.json({ error: { code: "not_found", message: e.message } }, 404);
    throw e;
  }
}

export async function handleGetFileHistory(c: FC) {
  const actor = c.get("actor");
  try {
    const entries = await getFileHistory(c.env, actor.accountId!, c.req.param("id")!);
    return c.json({ entries });
  } catch (e) {
    if (e instanceof FileNotFoundError)
      return c.json({ error: { code: "not_found", message: e.message } }, 404);
    throw e;
  }
}
