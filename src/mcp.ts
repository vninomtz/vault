import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const VAULT_URL = "https://vault-api.ninomtz-victor.workers.dev";

const HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  "Vault-Version": "2026-05-26",
};

function createServer(): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });

  server.tool(
    "read_file",
    "Lee el contenido vigente de un archivo de conocimiento en Vault",
    { slug: z.string().describe("Identificador del archivo (kebab-case)") },
    async ({ slug }) => {
      const res = await fetch(`${VAULT_URL}/files/${slug}`, { headers: HEADERS });
      if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: '${slug}' no encontrado` }] };
      const { file } = await res.json() as { file: { content: string; version: number } };
      return { content: [{ type: "text", text: file.content }] };
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
      const res = await fetch(`${VAULT_URL}/files/${slug}`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ content, type }),
      });
      const { file } = await res.json() as { file: { slug: string; version: number } };
      return { content: [{ type: "text", text: `Guardado como '${file.slug}' (v${file.version})` }] };
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
    async ({ type, q, limit }) => {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (q) params.set("q", q);
      if (limit) params.set("limit", String(limit));
      const res = await fetch(`${VAULT_URL}/files?${params}`, { headers: HEADERS });
      const { files } = await res.json() as { files: Array<{ slug: string; type: string; content: string; version: number }> };
      if (!files.length) return { content: [{ type: "text", text: "No se encontraron archivos." }] };
      const text = files.map(f => `## ${f.slug} (${f.type}, v${f.version})\n${f.content}`).join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.tool(
    "list_files",
    "Lista todos los archivos de Vault",
    { type: z.enum(["note", "rule", "skill", "policy", "context", "agent"]).optional() },
    async ({ type }) => {
      const params = type ? `?type=${type}` : "";
      const res = await fetch(`${VAULT_URL}/files${params}`, { headers: HEADERS });
      const { files } = await res.json() as { files: Array<{ slug: string; type: string; version: number }> };
      if (!files.length) return { content: [{ type: "text", text: "Vault vacío." }] };
      return { content: [{ type: "text", text: files.map(f => `- ${f.slug} (${f.type}, v${f.version})`).join("\n") }] };
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
      const res = await fetch(`${VAULT_URL}/batch`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ operations: operations.map(op => ({ method: "PUT", ...op })) }),
      });
      const { results } = await res.json() as { results: Array<{ slug: string; status: string; version?: number }> };
      const text = results.map(r => `${r.status === "ok" ? "✓" : "✗"} ${r.slug}${r.version ? ` (v${r.version})` : ""}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

export async function handleMcp(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}
