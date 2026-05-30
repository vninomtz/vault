import { useState } from "react";
import { FileList } from "./components/FileList";
import { FileViewer } from "./components/FileViewer";
import { NewFileDialog } from "./components/NewFileDialog";

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleCreated(id: string) {
    setSelectedId(id);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] shrink-0">
        <span className="text-sm font-semibold tracking-tight text-white">Vault</span>
      </header>

      {/* Layout */}
      <div className="flex flex-1 overflow-hidden">
        <FileList
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNew={() => setDialogOpen(true)}
        />

        <main className="flex-1 flex overflow-hidden">
          {selectedId ? (
            <FileViewer key={selectedId} fileId={selectedId} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--color-text-subtle)]">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="opacity-30"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <p className="text-sm">Select a file or create a new one</p>
              <button
                onClick={() => setDialogOpen(true)}
                className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-hover)] transition-colors mt-1"
              >
                + New file
              </button>
            </div>
          )}
        </main>
      </div>

      <NewFileDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
