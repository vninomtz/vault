import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createDb } from "./db/index";
import { files } from "./db/schema";
import { appendEntry } from "./domain/append-log";
import { readProjection } from "./domain/projection-engine";
import { ulid } from "./utils";
import type { Env, EntryType } from "./types";

const SYSTEM_SOURCE_ID = "01SYSTEM000000000000000000";
const SYSTEM_AUTHOR_ID = "01SYSTEM000000000000000001";

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });
  const db = createDb(env.DB);

  server.tool(
    "read_file",
    "Lee el contenido vigente de un archivo de conocimiento en Vault",
    { slug: z.string().describe("Identificador del archivo (kebab-case)") },
    async ({ slug }) => {
      const projection = await readProjection(env, slug);
      if (!projection) return { content: [{ type: "text", text: `File '${slug}' no encontrado` }] };
      return { content: [{ type: "text", text: projection.content }] };
    },
  );

  server.tool(
    "write_file",
    "Escribe o actualiza un archivo de conocimiento en Vault",
    {
      slug: z.string().describe("Identificador del archivo (kebab-case)"),
      content: z.string().describe("Contenido en markdown"),
      type: z.enum(["note", "rule", "skill", "policy", "context", "agent"]),
    },
    async ({ slug, content, type }) => {
      const existing = await db.select({ id: files.id }).from(files).where(eq(files.slug, slug)).get();
      const result = await appendEntry(env, {
        fileSlug: slug,
        content,
        contentRef: null,
        type: type as EntryType,
        intent: existing ? "addition" : "genesis",
        authorId: SYSTEM_AUTHOR_ID,
        sourceId: SYSTEM_SOURCE_ID,
        confidence: "medium",
        references: [],
        idempotencyKey: ulid(),
      });
      return { content: [{ type: "text", text: `Guardado como '${slug}' (v${result.sequenceNumber})` }] };
    },
  );

  server.tool(
    "search_files",
    "Busca archivos de conocimiento en Vault por tipo o texto",
    {
      type: z.enum(["note", "rule", "skill", "policy", "context", "agent"]).optional(),
      q: z.string().optional().describe("Búsqueda full-text"),
      limit: z.number().optional(),
    },
    async ({ type, q, limit = 20 }) => {
      let query = db.select().from(files).orderBy(desc(files.updatedAt)).limit(limit).$dynamic();
      if (type) query = query.where(eq(files.type, type as EntryType));
      const rows = await query.all();

      const results = await Promise.all(
        rows.map(async (file) => {
          const projection = await readProjection(env, file.slug);
          const content = projection?.content ?? "";
          if (q && !content.toLowerCase().includes(q.toLowerCase())) return null;
          return { slug: file.slug, type: file.type, content, version: file.currentVersion };
        }),
      );

      const filtered = results.filter(Boolean) as Array<{ slug: string; type: string; content: string; version: number }>;
      if (!filtered.length) return { content: [{ type: "text", text: "No se encontraron archivos." }] };
      const text = filtered.map(f => `## ${f.slug} (${f.type}, v${f.version})\n${f.content}`).join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "list_files",
    "Lista todos los archivos de Vault",
    { type: z.enum(["note", "rule", "skill", "policy", "context", "agent"]).optional() },
    async ({ type }) => {
      let query = db.select().from(files).orderBy(desc(files.updatedAt)).$dynamic();
      if (type) query = query.where(eq(files.type, type as EntryType));
      const rows = await query.all();
      if (!rows.length) return { content: [{ type: "text", text: "Vault vacío." }] };
      return { content: [{ type: "text", text: rows.map(f => `- ${f.slug} (${f.type}, v${f.currentVersion})`).join("\n") }] };
    },
  );

  server.tool(
    "batch_write",
    "Escribe múltiples archivos en Vault en una sola operación",
    {
      operations: z.array(z.object({
        slug: z.string(),
        content: z.string(),
        type: z.enum(["note", "rule", "skill", "policy", "context", "agent"]),
      })),
    },
    async ({ operations }) => {
      const lines: string[] = [];
      for (const op of operations) {
        const existing = await db.select({ id: files.id }).from(files).where(eq(files.slug, op.slug)).get();
        const result = await appendEntry(env, {
          fileSlug: op.slug,
          content: op.content,
          contentRef: null,
          type: op.type as EntryType,
          intent: existing ? "addition" : "genesis",
          authorId: SYSTEM_AUTHOR_ID,
          sourceId: SYSTEM_SOURCE_ID,
          confidence: "medium",
          references: [],
          idempotencyKey: ulid(),
        });
        lines.push(`✓ ${op.slug} (v${result.sequenceNumber})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer(env);
  await server.connect(transport);
  return transport.handleRequest(request);
}
