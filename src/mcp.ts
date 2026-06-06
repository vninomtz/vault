import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { SYSTEM_AUTHOR_ID } from "./constants";
import {
  createFile,
  readFileById,
  readFileByName,
  updateFile,
  renameFile,
  listFiles,
  FileExistsError,
  FileNotFoundError,
  ConflictError,
} from "./services/files";
import type { Env } from "./types";

function createServer(env: Env, accountId: string): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });

  server.tool(
    "read_file",
    "Lee el contenido de un archivo por su ID. Devuelve nombre, versión y contenido.",
    { id: z.string().describe("ID del archivo (ULID)") },
    async ({ id }) => {
      const file = await readFileById(env, accountId, id);
      if (!file) return { content: [{ type: "text", text: `Error: archivo '${id}' no encontrado` }] };
      return {
        content: [{
          type: "text",
          text: `name: ${file.name}\nversion: ${file.version}\nupdated_at: ${new Date(file.updatedAt).toISOString()}\n\n${file.content}`,
        }],
      };
    },
  );

  server.tool(
    "find_file",
    "Busca un archivo por nombre o path (ej: projects/vault/spec). Devuelve el ID necesario para editar.",
    { name: z.string().describe("Nombre o path del archivo") },
    async ({ name }) => {
      const file = await readFileByName(env, accountId, name);
      if (!file) return { content: [{ type: "text", text: `Error: archivo '${name}' no encontrado` }] };
      return {
        content: [{
          type: "text",
          text: `id: ${file.id}\nname: ${file.name}\nversion: ${file.version}\nupdated_at: ${new Date(file.updatedAt).toISOString()}\n\n${file.content}`,
        }],
      };
    },
  );

  server.tool(
    "create_file",
    "Crea un nuevo archivo de conocimiento en Vault.",
    {
      name: z.string().describe("Nombre o path del archivo (ej: projects/vault/spec)"),
      content: z.string().describe("Contenido en markdown"),
    },
    async ({ name, content }) => {
      try {
        const file = await createFile(env, accountId, SYSTEM_AUTHOR_ID, { name, content });
        return { content: [{ type: "text", text: `Creado: id=${file.id} name=${file.name} v${file.version}` }] };
      } catch (e) {
        if (e instanceof FileExistsError)
          return { content: [{ type: "text", text: `Error: '${name}' ya existe (id: ${e.existingId})` }] };
        throw e;
      }
    },
  );

  server.tool(
    "update_file",
    "Reemplaza el contenido de un archivo por su ID. Usa if_version para concurrencia optimista.",
    {
      id: z.string().describe("ID del archivo (ULID)"),
      content: z.string().describe("Nuevo contenido en markdown"),
      if_version: z.number().optional().describe("Versión esperada (opcional). Rechaza la escritura si el archivo ya fue modificado."),
    },
    async ({ id, content, if_version }) => {
      try {
        const file = await updateFile(env, accountId, SYSTEM_AUTHOR_ID, { fileId: id, content, expectedVersion: if_version });
        return { content: [{ type: "text", text: `Actualizado: name=${file.name} v${file.version}` }] };
      } catch (e) {
        if (e instanceof FileNotFoundError)
          return { content: [{ type: "text", text: `Error: archivo '${id}' no encontrado` }] };
        if (e instanceof ConflictError)
          return { content: [{ type: "text", text: `Error de concurrencia: el archivo está en v${e.actual}, se esperaba v${e.expected}. Vuelve a leer y reintenta.` }] };
        throw e;
      }
    },
  );

  server.tool(
    "rename_file",
    "Renombra o mueve un archivo a un nuevo path. El ID del archivo no cambia.",
    {
      id: z.string().describe("ID del archivo (ULID)"),
      name: z.string().describe("Nuevo nombre o path (ej: archive/vault/spec)"),
    },
    async ({ id, name }) => {
      try {
        const result = await renameFile(env, accountId, { fileId: id, newName: name });
        return { content: [{ type: "text", text: `Renombrado: id=${result.id} name=${result.name}` }] };
      } catch (e) {
        if (e instanceof FileNotFoundError)
          return { content: [{ type: "text", text: `Error: archivo '${id}' no encontrado` }] };
        if (e instanceof FileExistsError)
          return { content: [{ type: "text", text: `Error: ya existe un archivo con el nombre '${name}'` }] };
        throw e;
      }
    },
  );

  server.tool(
    "list_files",
    "Lista archivos de Vault. Soporta filtro por prefix de path y búsqueda full-text.",
    {
      prefix: z.string().optional().describe("Prefix de path, ej: projects/vault/"),
      q: z.string().optional().describe("Búsqueda full-text en contenido"),
      limit: z.number().optional().describe("Máximo de resultados (default 20, máx 100)"),
    },
    async ({ prefix, q, limit = 20 }) => {
      const result = await listFiles(env, accountId, { prefix, q, limit });
      if (!result.files.length) return { content: [{ type: "text", text: "No se encontraron archivos." }] };
      const lines = result.files
        .map((f) => `- ${f.id}  ${f.name}  v${f.version}  ${new Date(f.updatedAt).toISOString()}`)
        .join("\n");
      return { content: [{ type: "text", text: lines }] };
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
