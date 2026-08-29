import { useEffect, useRef } from "react";

export function TerminalContextMenu({
  position,
  hasSelection,
  selectionHint,
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
  onSearch,
  onTranscript,
  onClose,
}: {
  position: { x: number; y: number };
  hasSelection: boolean;
  selectionHint: string;
  onCopy(): void;
  onPaste(): void;
  onSelectAll(): void;
  onClear(): void;
  onSearch(): void;
  onTranscript(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const close = () => onClose();
    window.addEventListener("pointerdown", close, { once: true });
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="terminal-context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <button role="menuitem" type="button" disabled={!hasSelection} onClick={onCopy}>
        Copy
      </button>
      <button role="menuitem" type="button" onClick={onPaste}>
        Paste text
      </button>
      <button role="menuitem" type="button" onClick={onSelectAll}>
        Select all scrollback
      </button>
      <button role="menuitem" type="button" disabled={!hasSelection} onClick={onClear}>
        Clear selection
      </button>
      <button role="menuitem" type="button" onClick={onSearch}>
        Search
      </button>
      <button role="menuitem" type="button" onClick={onTranscript}>
        Open transcript
      </button>
      <p>{selectionHint}</p>
    </div>
  );
}
