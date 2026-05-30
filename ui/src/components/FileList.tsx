import { useState } from "react";
import { useFileList } from "../hooks/useFiles";

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function FileList({ selectedId, onSelect, onNew }: Props) {
  const [search, setSearch] = useState("");
  const [prefix, setPrefix] = useState("");

  const { data, isLoading } = useFileList({ q: search || undefined, prefix: prefix || undefined });
  const files = data?.files ?? [];

  // Build virtual folder tree from flat list
  const prefixes = new Set<string>();
  files.forEach((f) => {
    const parts = f.name.split("/");
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        prefixes.add(parts.slice(0, i).join("/") + "/");
      }
    }
  });

  const activePrefixFiles = prefix
    ? files.filter((f) => f.name.startsWith(prefix) && !f.name.slice(prefix.length).includes("/"))
    : files.filter((f) => !f.name.includes("/") || search);

  const activePrefixFolders = prefix
    ? [...prefixes].filter(
        (p) => p.startsWith(prefix) && p.slice(prefix.length).split("/").filter(Boolean).length === 1,
      )
    : [...prefixes].filter((p) => p.split("/").filter(Boolean).length === 1);

  return (
    <aside className="flex flex-col w-64 border-r border-[var(--color-border)] bg-[var(--color-surface-1)] shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
        <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-text-subtle)]">
          Files
        </span>
        <button
          onClick={onNew}
          className="text-xs px-2 py-1 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-text)] transition-colors"
        >
          + New
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--color-text)] placeholder-[var(--color-text-subtle)] outline-none focus:border-[var(--color-border-hover)] transition-colors"
        />
      </div>

      {/* Breadcrumb */}
      {prefix && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)]">
          <button
            onClick={() => setPrefix("")}
            className="text-xs text-[var(--color-text-subtle)] hover:text-[var(--color-text)] transition-colors"
          >
            root
          </button>
          {prefix
            .split("/")
            .filter(Boolean)
            .map((part, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-[var(--color-text-subtle)] text-xs">/</span>
                <button
                  onClick={() => setPrefix(arr.slice(0, i + 1).join("/") + "/")}
                  className="text-xs text-[var(--color-text-subtle)] hover:text-[var(--color-text)] transition-colors"
                >
                  {part}
                </button>
              </span>
            ))}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-subtle)]">Loading…</div>
        )}

        {/* Folders */}
        {!search && activePrefixFolders.map((folder) => {
          const name = folder.slice(prefix.length).replace(/\/$/, "");
          return (
            <button
              key={folder}
              onClick={() => setPrefix(folder)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-colors"
            >
              <span className="text-[var(--color-text-subtle)]">📁</span>
              {name}
            </button>
          );
        })}

        {/* Files */}
        {activePrefixFiles.map((file) => {
          const displayName = prefix
            ? file.name.slice(prefix.length)
            : file.name;
          const isActive = file.id === selectedId;
          return (
            <button
              key={file.id}
              onClick={() => onSelect(file.id)}
              className={`flex flex-col w-full px-3 py-1.5 text-left border-l-2 transition-colors ${
                isActive
                  ? "bg-[var(--color-surface-2)] border-l-[var(--color-accent)] text-[var(--color-text)]"
                  : "border-l-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              }`}
            >
              <span className="text-xs truncate">{displayName}</span>
              <span className="text-[10px] text-[var(--color-text-subtle)] mt-0.5">
                v{file.version} · {new Date(file.updated_at).toLocaleDateString()}
              </span>
            </button>
          );
        })}

        {!isLoading && files.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-[var(--color-text-subtle)]">
            No files
          </div>
        )}
      </div>
    </aside>
  );
}
