import { useState } from "react";
import { Dialog } from "@base-ui/react";
import { useCreateFile } from "../hooks/useFiles";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewFileDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const createFile = useCreateFile();

  async function handleCreate() {
    if (!name.trim()) return;
    const file = await createFile.mutateAsync({
      name: name.trim(),
      content: `# ${name.trim().split("/").pop()}\n\n`,
    });
    setName("");
    onCreated(file.id);
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 z-40" />
        <Dialog.Popup className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl p-6 flex flex-col gap-4 shadow-2xl">
          <Dialog.Title className="text-sm font-semibold text-[var(--color-text)]">
            New File
          </Dialog.Title>

          <input
            autoFocus
            type="text"
            placeholder="Name or path (e.g. projects/vault/spec)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") onClose();
            }}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] focus:border-[var(--color-border-hover)] rounded-lg px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-text-subtle)] outline-none transition-colors"
          />

          {createFile.isError && (
            <p className="text-xs text-red-400">{createFile.error?.message}</p>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!name.trim() || createFile.isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-40"
            >
              {createFile.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
