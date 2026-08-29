import type {
  TerminalCheckpoint,
  TerminalEndpointStatus,
  TerminalRole,
  TerminalServerFrame,
} from "@nanasa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import {
  copyTerminalSelection,
  installTrustedClipboardEvents,
  readClipboardText,
  selectionModifier,
} from "./terminal-clipboard.js";
import { TerminalContextMenu } from "./terminal-context-menu.js";
import { TerminalLeaseBanner } from "./terminal-lease-banner.js";
import { TerminalTranscriptDialog } from "./terminal-transcript-dialog.js";
import { TerminalTransport } from "./terminal-transport.js";
import { XtermController } from "./xterm-controller.js";

export function TerminalConsole({
  client,
  endpoint,
  runGeneration,
  theme,
  label,
}: {
  client: PortalClient;
  endpoint: Extract<TerminalEndpointStatus, { state: "ready" }>;
  runGeneration: number;
  theme: "light" | "dark";
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermController | null>(null);
  const transportRef = useRef<TerminalTransport | null>(null);
  const [role, setRole] = useState<TerminalRole>("observer");
  const [state, setState] = useState<"connecting" | "connected" | "reconnecting" | "closed">(
    "connecting",
  );
  const [selected, setSelected] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [title, setTitle] = useState("");
  const [effect, setEffect] = useState<Extract<TerminalServerFrame, { type: "effect" }>>();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [live, setLive] = useState<Awaited<ReturnType<PortalClient["readTerminal"]>>>();
  const [checkpoints, setCheckpoints] = useState<TerminalCheckpoint[]>([]);
  const [previous, setPrevious] =
    useState<Awaited<ReturnType<PortalClient["getTerminalCheckpoint"]>>>();
  const viewerId = useRef(sessionStorage.getItem("nanasa-terminal-viewer") ?? crypto.randomUUID());
  const modifier = selectionModifier();
  const selectionHint = `Mouse input belongs to the terminal app. Hold ${modifier} and drag to select text.`;

  const copy = useCallback(async () => {
    if (xtermRef.current === null) return;
    const outcome = await copyTerminalSelection(xtermRef.current.terminal);
    if ("message" in outcome) setFeedback(outcome.message);
    else setFeedback("Terminal selection copied.");
  }, []);

  const paste = useCallback(async () => {
    const result = await readClipboardText();
    if (typeof result === "string") {
      transportRef.current?.paste(result);
      xtermRef.current?.focus();
      setFeedback("Clipboard text pasted.");
    } else {
      setFeedback(result.message);
      xtermRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem("nanasa-terminal-viewer", viewerId.current);
    const host = hostRef.current;
    if (host === null) return;
    const onFrame = (frame: TerminalServerFrame) => {
      if (frame.type === "welcome" || frame.type === "lease") setRole(frame.role);
      if (frame.type === "baseline" || frame.type === "output") xtermRef.current?.write(frame.data);
      if (frame.type === "reset") {
        xtermRef.current?.reset();
        setFeedback(`Terminal reset: ${frame.reason.replaceAll("_", " ")}.`);
      }
      if (frame.type === "effect") setEffect(frame);
    };
    const transport = new TerminalTransport({
      endpoint,
      runGeneration,
      viewerId: viewerId.current,
      requestedRole: "controller",
      cols: 120,
      rows: 40,
      onFrame,
      onState: setState,
    });
    transportRef.current = transport;
    const xterm = new XtermController(host, {
      theme,
      onData: (data) => transport.input(data),
      onResize: (cols, rows) => transport.resize(cols, rows),
      onFocus: (focused) => transport.focus(focused),
      onSelectionChange: setSelected,
      onTitle: setTitle,
      onBell: () => setFeedback("Terminal bell."),
    });
    xtermRef.current = xterm;
    const removeClipboardEvents = installTrustedClipboardEvents(host, xterm.terminal, (text) =>
      transport.paste(text),
    );
    transport.connect();
    return () => {
      removeClipboardEvents();
      transport.dispose();
      xterm.dispose();
      transportRef.current = null;
      xtermRef.current = null;
    };
  }, [endpoint, runGeneration, theme]);

  const openTranscript = useCallback(() => {
    setTranscriptOpen(true);
    void Promise.all([
      client.readTerminal(endpoint.runId, runGeneration),
      client.listTerminalCheckpoints(),
    ]).then(([read, items]) => {
      setLive(read);
      setCheckpoints(items.filter((item) => item.runId === endpoint.runId));
    });
  }, [client, endpoint.runId, runGeneration]);

  return (
    <div
      className="terminal-console"
      aria-label={label}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "F10" && event.shiftKey) {
          event.preventDefault();
          setMenu({ x: 24, y: 80 });
        }
      }}
    >
      <TerminalLeaseBanner
        role={role}
        state={state}
        onTakeover={() => transportRef.current?.takeover()}
      />
      <div className="terminal-actions" role="toolbar" aria-label="Terminal actions">
        <button type="button" disabled={!selected} onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" disabled={role !== "controller"} onClick={() => void paste()}>
          Paste
        </button>
        <button type="button" onClick={() => setSearching((value) => !value)}>
          Search
        </button>
        <button type="button" onClick={openTranscript}>
          Transcript
        </button>
        <span title={title}>{title}</span>
      </div>
      {searching && (
        <form
          className="terminal-search"
          onSubmit={(event) => {
            event.preventDefault();
            xtermRef.current?.search(search);
          }}
        >
          <label>
            Search terminal{" "}
            <input value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="submit">Find next</button>
        </form>
      )}
      <p className="terminal-selection-hint">{selectionHint}</p>
      <div ref={hostRef} className="xterm-host" />
      <p className="terminal-feedback" role="status" aria-live="polite">
        {feedback}
      </p>
      {effect !== undefined && role === "controller" && (
        <div
          className="terminal-effect-prompt"
          role="alertdialog"
          aria-label="Terminal clipboard request"
        >
          <p>This terminal requests a clipboard write of {effect.byteCount} bytes.</p>
          <pre>{effect.preview}</pre>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(effect.data).then(
                () => setFeedback("Terminal clipboard request copied."),
                () => setFeedback("Clipboard permission was denied."),
              );
              setEffect(undefined);
            }}
          >
            Copy
          </button>
          <button type="button" onClick={() => setEffect(undefined)}>
            Deny
          </button>
        </div>
      )}
      {menu !== undefined && (
        <TerminalContextMenu
          position={menu}
          hasSelection={selected}
          selectionHint={selectionHint}
          onCopy={() => {
            void copy();
            setMenu(undefined);
          }}
          onPaste={() => {
            void paste();
            setMenu(undefined);
          }}
          onSelectAll={() => {
            xtermRef.current?.selectAll();
            setMenu(undefined);
          }}
          onClear={() => {
            xtermRef.current?.clearSelection();
            setMenu(undefined);
          }}
          onSearch={() => {
            setSearching(true);
            setMenu(undefined);
          }}
          onTranscript={() => {
            openTranscript();
            setMenu(undefined);
          }}
          onClose={() => setMenu(undefined)}
        />
      )}
      {transcriptOpen && (
        <TerminalTranscriptDialog
          {...(live === undefined ? {} : { live })}
          checkpoints={checkpoints}
          {...(previous === undefined ? {} : { selectedCheckpoint: previous })}
          onSelectCheckpoint={(id) => void client.getTerminalCheckpoint(id).then(setPrevious)}
          onClose={() => setTranscriptOpen(false)}
        />
      )}
    </div>
  );
}
