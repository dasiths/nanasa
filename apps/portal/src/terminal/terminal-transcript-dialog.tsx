import type { TerminalCheckpoint, TerminalReadResult } from "@nanasa/contracts";
import { useEffect, useRef } from "react";

export function TerminalTranscriptDialog({
  live,
  checkpoints,
  selectedCheckpoint,
  onSelectCheckpoint,
  onClose,
}: {
  live?: TerminalReadResult;
  checkpoints: TerminalCheckpoint[];
  selectedCheckpoint?: { checkpoint: TerminalCheckpoint; text: string };
  onSelectCheckpoint(id: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (typeof ref.current?.showModal === "function") ref.current.showModal();
    else ref.current?.setAttribute("open", "");
  }, []);
  return (
    <dialog
      ref={ref}
      className="terminal-transcript-dialog"
      aria-labelledby="terminal-transcript-title"
      onCancel={onClose}
    >
      <header>
        <div>
          <h2 id="terminal-transcript-title">Terminal transcript</h2>
          <p>Bounded read-only output. It is never replayed into the terminal.</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <section aria-labelledby="live-transcript-title">
        <h3 id="live-transcript-title">Live tmux output</h3>
        <p>
          {live?.alternateScreen ? "Current alternate screen" : "Primary screen and history"}
          {live?.truncated ? " · truncated" : ""}
        </p>
        <pre tabIndex={0}>{live?.text ?? "Loading live output…"}</pre>
      </section>
      {checkpoints.length > 0 && (
        <section aria-labelledby="previous-output-title">
          <h3 id="previous-output-title">Previous output checkpoints</h3>
          <p>Historical, read-only output—not live terminal state.</p>
          <select
            aria-label="Previous output checkpoint"
            value={selectedCheckpoint?.checkpoint.id ?? ""}
            onChange={(event) => onSelectCheckpoint(event.target.value)}
          >
            <option value="">Select a checkpoint</option>
            {checkpoints.map((checkpoint) => (
              <option key={checkpoint.id} value={checkpoint.id}>
                {new Date(checkpoint.capturedAt).toLocaleString()} · generation{" "}
                {checkpoint.generation}
              </option>
            ))}
          </select>
          {selectedCheckpoint !== undefined && (
            <pre tabIndex={0} aria-label="Previous output checkpoint content">
              {selectedCheckpoint.text}
            </pre>
          )}
        </section>
      )}
    </dialog>
  );
}
