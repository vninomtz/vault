import { useState, useRef, useEffect } from "react";
import { useFile, useUpdateFile, useRenameFile } from "../hooks/useFiles";
import { renderMarkdown } from "../lib/markdown";

interface Props {
  fileId: string;
}

export function FileViewer({ fileId }: Props) {
  const { data: file, isLoading } = useFile(fileId);
  const updateFile = useUpdateFile();
  const renameFile = useRenameFile();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(file?.content ?? "");
      setTimeout(() => editorRef.current?.focus(), 50);
    }
  }, [editing, file?.content]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-subtle)]">
        Loading…
      </div>
    );
  }

  if (!file) return null;

  const parts = file.name.split("/");
  const basename = parts.pop()!;
  const pathPrefix = parts.length ? parts.join("/") + "/" : "";

  async function save() {
    await updateFile.mutateAsync({ id: file!.id, content: draft });
    setEditing(false);
  }

  async function doRename() {
    if (!newName.trim() || newName === file!.name) { setRenaming(false); return; }
    await renameFile.mutateAsync({ id: file!.id, name: newName });
    setRenaming(false);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] min-h-[42px]">
        {renaming ? (
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") setRenaming(false); }}
            onBlur={doRename}
            className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] focus:border-[var(--color-border-hover)] rounded px-2 py-1 text-xs text-[var(--color-text)] outline-none"
          />
        ) : (
          <button
            onClick={() => { setNewName(file.name); setRenaming(true); }}
            className="flex-1 text-left text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors truncate"
          >
            <span className="text-[var(--color-text-subtle)]">{pathPrefix}</span>
            <span className="font-medium text-[var(--color-text)]">{basename}</span>
          </button>
        )}

        <div className="flex items-center gap-2 shrink-0">
          {updateFile.isPending && (
            <span className="text-[10px] text-[var(--color-text-subtle)]">Saving…</span>
          )}
          {updateFile.isSuccess && !editing && (
            <span className="text-[10px] text-emerald-500">Saved</span>
          )}
          {updateFile.isError && (
            <span className="text-[10px] text-red-400">{updateFile.error?.message}</span>
          )}

          {editing ? (
            <>
              <button
                onClick={() => setEditing(false)}
                className="text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={updateFile.isPending}
                className="text-xs px-2.5 py-1 rounded bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
              >
                Save
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-hover)] transition-colors"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {editing ? (
          <textarea
            ref={editorRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "s" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
              if (e.key === "Escape") setEditing(false);
            }}
            className="flex-1 bg-transparent border-none outline-none resize-none px-8 py-6 text-sm text-[var(--color-text)] font-[var(--font-mono)] leading-relaxed"
            spellCheck={false}
          />
        ) : (
          <div
            className="flex-1 overflow-y-auto px-8 py-6 prose-vault"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content ?? "") }}
          />
        )}
      </div>
    </div>
  );
}
