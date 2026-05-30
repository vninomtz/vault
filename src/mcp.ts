import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { createDb } from "./db/index";
import { files } from "./db/schema";
import { appendEntry } from "./domain/append-log";
import { readProjection } from "./domain/projection-engine";
import { ulid } from "./utils";
import type { Env } from "./types";

const SYSTEM_SOURCE_ID = "01SYSTEM000000000000000000";
const SYSTEM_AUTHOR_ID = "01SYSTEM000000000000000001";

function createServer(env: Env, accountId: string): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });
  const db = createDb(env.DB);

  // Read by ID
  server.tool(
    "read_file",
    "Lee el contenido de un archivo por su ID",
    { id: z.string().describe("ID del archivo (ULID)") },
    async ({ id }) => {
      const file = await db.select().from(files).where(and(eq(files.id, id), eq(files.accountId, accountId))).get();
      if (!file) return { content: [{ type: "text", text: `File '${id}' no encontrado` }] };
      const projection = await readProjection(env, accountId, file.name);
      return { content: [{ type: "text", text: projection?.content ?? "" }] };
    },
  );

  // Find by name
  server.tool(
    "find_file",
    "Busca un archivo por su nombre o path (ej: projects/vault/spec)",
    { name: z.string().describe("Nombre o path del archivo") },
    async ({ name }) => {
      const file = await db.select().from(files).where(and(eq(files.accountId, accountId), eq(files.name, name))).get();
      if (!file) return { content: [{ type: "text", text: `File '${name}' no encontrado` }] };
      const projection = await readProjection(env, accountId, file.name);
      return { content: [{ type: "text", text: JSON.stringify({ id: file.id, name: file.name, content: projection?.content ?? "", version: file.currentVersion }) }] };
    },
  );

  // Create new file
  server.tool(
    "create_file",
    "Crea un nuevo archivo de conocimiento en Vault",
    {
      name: z.string().describe("Nombre o path del archivo (ej: projects/vault/spec)"),
      content: z.string().describe("Contenido en markdown"),
    },
    async ({ name, content }) => {
      const existing = await db.select({ id: files.id }).from(files).where(and(eq(files.accountId, accountId), eq(files.name, name))).get();
      if (existing) return { content: [{ type: "text", text: `Error: '${name}' ya existe (id: ${existing.id})` }] };

      const fileId = ulid();
      const now = Date.now();
      await db.insert(files).values({ id: fileId, accountId, name, type: "note", currentVersion: 0, status: "active", createdAt: now, updatedAt: now }).run();
      const result = await appendEntry(env, {
        accountId,
        fileId,
        content,
        contentRef: null,
        type: "note",
        intent: "genesis",
        authorId: SYSTEM_AUTHOR_ID,
        sourceId: SYSTEM_SOURCE_ID,
        confidence: "medium",
        references: [],
        idempotencyKey: ulid(),
      });
      return { content: [{ type: "text", text: `Creado '${name}' (id: ${fileId}, v${result.sequenceNumber})` }] };
    },
  );

  // Update by ID
  server.tool(
    "update_file",
    "Actualiza el contenido de un archivo por su ID",
    {
      id: z.string().describe("ID del archivo (ULID)"),
      content: z.string().describe("Nuevo contenido en markdown"),
    },
    async ({ id, content }) => {
      const file = await db.select().from(files).where(and(eq(files.id, id), eq(files.accountId, accountId))).get();
      if (!file) return { content: [{ type: "text", text: `File '${id}' no encontrado` }] };
      const result = await appendEntry(env, {
        accountId,
        fileId: file.id,
        content,
        contentRef: null,
        type: file.type,
        intent: "addition",
        authorId: SYSTEM_AUTHOR_ID,
        sourceId: SYSTEM_SOURCE_ID,
        confidence: "medium",
        references: [],
        idempotencyKey: ulid(),
      });
      return { content: [{ type: "text", text: `Actualizado '${file.name}' (v${result.sequenceNumber})` }] };
    },
  );

  // List files
  server.tool(
    "list_files",
    "Lista archivos de Vault, opcionalmente filtrados por prefix de path",
    {
      prefix: z.string().optional().describe("Prefix de path, ej: projects/vault/"),
      q: z.string().optional().describe("Búsqueda full-text"),
      limit: z.number().optional(),
    },
    async ({ prefix, q, limit = 20 }) => {
      const rows = await db.select().from(files).where(eq(files.accountId, accountId)).orderBy(desc(files.updatedAt)).limit(100).all();
      const filtered = rows.filter(f => !prefix || f.name.startsWith(prefix)).slice(0, limit);
      if (!filtered.length) return { content: [{ type: "text", text: "No se encontraron archivos." }] };

      const results = await Promise.all(
        filtered.map(async (file) => {
          if (q) {
            const projection = await readProjection(env, accountId, file.name);
            const content = projection?.content ?? "";
            if (!content.toLowerCase().includes(q.toLowerCase())) return null;
          }
          return `- ${file.id}  ${file.name} (v${file.currentVersion})`;
        }),
      );

      const lines = results.filter(Boolean).join("\n");
      return { content: [{ type: "text", text: lines || "No se encontraron archivos." }] };
    },
  );

  return server;
}

export async function handleMcp(request: Request, env: Env, accountId: string): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer(env, accountId);
  await server.connect(transport);
  return transport.handleRequest(request);
}
