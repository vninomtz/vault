import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export const fileKeys = {
  list: (params?: object) => ["files", "list", params] as const,
  detail: (id: string) => ["files", "detail", id] as const,
};

export function useFileList(params?: { prefix?: string; q?: string }) {
  return useQuery({
    queryKey: fileKeys.list(params),
    queryFn: () => api.listFiles({ ...params, limit: 100 }),
  });
}

export function useFile(id: string | null) {
  return useQuery({
    queryKey: fileKeys.detail(id!),
    queryFn: () => api.getFile(id!),
    enabled: !!id,
  });
}

export function useCreateFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      api.createFile(name, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", "list"] }),
  });
}

export function useUpdateFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content, ifVersion }: { id: string; content: string; ifVersion?: number }) =>
      api.updateFile(id, content, ifVersion),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: ["files", "list"] });
      qc.setQueryData(fileKeys.detail(file.id), file);
    },
  });
}

export function useRenameFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.renameFile(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files"] }),
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files", "list"] }),
  });
}
