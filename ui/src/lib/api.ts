const BASE = "/api";
const HEADERS = { "Content-Type": "application/json" };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { headers: HEADERS, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface FileItem {
  id: string;
  name: string;
  version: number;
  updated_at: string;
}

export interface FileDetail extends FileItem {
  content: string;
  freshness: string;
  created_at: string;
}

export interface FilesResponse {
  files: FileItem[];
  next_cursor: string | null;
  total: number;
}

export const api = {
  listFiles: (params?: { prefix?: string; q?: string; limit?: number; cursor?: string }) => {
    const qs = new URLSearchParams();
    if (params?.prefix) qs.set("prefix", params.prefix);
    if (params?.q) qs.set("q", params.q);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);
    return request<FilesResponse>(`/files${qs.size ? `?${qs}` : ""}`);
  },

  getFile: (id: string) =>
    request<{ file: FileDetail }>(`/files/${id}`).then((r) => r.file),

  findByName: (name: string) =>
    request<{ file: FileDetail }>(`/files?name=${encodeURIComponent(name)}`).then((r) => r.file),

  createFile: (name: string, content: string) =>
    request<{ file: FileDetail }>("/files", {
      method: "POST",
      body: JSON.stringify({ name, content }),
    }).then((r) => r.file),

  updateFile: (id: string, content: string, ifVersion?: number) =>
    request<{ file: FileDetail }>(`/files/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content, ...(ifVersion !== undefined && { if_version: ifVersion }) }),
    }).then((r) => r.file),

  renameFile: (id: string, name: string) =>
    request<{ updated: boolean; name: string }>(`/files/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
};
