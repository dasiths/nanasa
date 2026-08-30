import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, useRovingFocus } from "../a11y/primitives.js";

export interface PortalCommand {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  keywords?: string[];
  run(): void;
}

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.matches("input, textarea, select, [contenteditable=true]") ||
    target.closest("dialog, .xterm-host") !== null
  );
}

export function useScopedShortcuts(commands: PortalCommand[], onOpenPalette: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || editableTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenPalette();
        return;
      }
      const key = [event.ctrlKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.key]
        .filter(Boolean)
        .join("+");
      const command = commands.find((candidate) => candidate.shortcut === key);
      if (command === undefined) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commands, onOpenPalette]);
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: PortalCommand[];
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { containerRef, onKeyDown } = useRovingFocus<HTMLUListElement>();
  useEffect(() => {
    if (!open) setQuery("");
    else requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((command) => {
      const haystack = [command.label, command.description, ...(command.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);
  return (
    <Dialog
      open={open}
      labelledBy="command-palette-title"
      onClose={onClose}
      className="command-dialog"
    >
      <div className="command-dialog-body">
        <header>
          <div>
            <span className="eyebrow">Navigate and act</span>
            <h2 id="command-palette-title">Command palette</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close command palette"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <label className="command-search">
          <Search aria-hidden="true" size={16} />
          <span className="visually-hidden">Search commands</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search groups, agents, routes, and actions"
          />
        </label>
        <ul ref={containerRef} onKeyDown={onKeyDown} aria-label="Command results">
          {results.map((command) => (
            <li key={command.id}>
              <button
                type="button"
                data-roving-item=""
                onClick={() => {
                  command.run();
                  onClose();
                }}
              >
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
                {command.shortcut !== undefined && <kbd>{command.shortcut}</kbd>}
              </button>
            </li>
          ))}
        </ul>
        {results.length === 0 && <p role="status">No matching commands.</p>}
      </div>
    </Dialog>
  );
}
