import type {
  TerminalCheckpoint,
  TerminalEndpointStatus,
  TerminalRole,
  TerminalServerFrame,
} from "@nanasa/contracts";
import {
  ClipboardPaste,
  Copy,
  EllipsisVertical,
  Eraser,
  Info,
  ScrollText,
  Search,
  TextSelect,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PortalClient } from "../api.js";
import {
  copyTerminalSelection,
  installCopyOnSelect,
  installTrustedClipboardEvents,
  readClipboardText,
  selectionModifier,
  writeClipboardText,
} from "./terminal-clipboard.js";
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
  headerIdentity = null,
  memberIdentity = null,
  paneActions = null,
  suspended = false,
  visible = true,
}: {
  client: PortalClient;
  endpoint: Extract<TerminalEndpointStatus, { state: "ready" }>;
  runGeneration: number;
  theme: "light" | "dark";
  label: string;
  headerIdentity?: ReactNode;
  memberIdentity?: ReactNode;
  paneActions?: ReactNode;
  suspended?: boolean;
  visible?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const actionMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const xtermRef = useRef<XtermController | null>(null);
  const transportRef = useRef<TerminalTransport | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [role, setRole] = useState<TerminalRole>("observer");
  const [state, setState] = useState<"connecting" | "connected" | "reconnecting" | "closed">(
    "connecting",
  );
  const [selected, setSelected] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [title, setTitle] = useState("");
  const [effect, setEffect] = useState<Extract<TerminalServerFrame, { type: "effect" }>>();
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [live, setLive] = useState<Awaited<ReturnType<PortalClient["readTerminal"]>>>();
  const [checkpoints, setCheckpoints] = useState<TerminalCheckpoint[]>([]);
  const [previous, setPrevious] =
    useState<Awaited<ReturnType<PortalClient["getTerminalCheckpoint"]>>>();
  const viewerId = useRef(sessionStorage.getItem("nanasa-terminal-viewer") ?? crypto.randomUUID());
  const mountId = useRef(crypto.randomUUID());
  const modifier = selectionModifier();
  const copyShortcut = modifier === "Option" ? "Command+C" : "Ctrl+C";
  const selectionHint = `Hold ${modifier} and drag to select and copy text, or press ${copyShortcut} with a selection.`;

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
      if (frame.type === "welcome" || frame.type === "lease") {
        setRole(frame.role);
        if (frame.role !== "controller") setEffect(undefined);
        xtermRef.current?.setFitEnabled(frame.role === "controller");
      }
      if (
        (frame.type === "welcome" || frame.type === "lease") &&
        frame.role === "controller" &&
        visibleRef.current
      ) {
        const terminal = xtermRef.current?.terminal;
        if (terminal !== undefined) transportRef.current?.resize(terminal.cols, terminal.rows);
      }
      if (frame.type === "baseline") xtermRef.current?.replace(frame.data);
      if (frame.type === "output") xtermRef.current?.write(frame.data);
      if (frame.type === "reset") {
        xtermRef.current?.reset();
        setFeedback(`Terminal reset: ${frame.reason.replaceAll("_", " ")}.`);
      }
      if (frame.type === "effect" && Date.parse(frame.expiresAt) > Date.now()) setEffect(frame);
    };
    const xterm = new XtermController(host, {
      theme,
      visible: visibleRef.current,
      onData: (data) => transportRef.current?.input(data),
      onResize: (cols, rows) => transportRef.current?.resize(cols, rows),
      onFocus: (focused) => transportRef.current?.focus(focused),
      onCopyShortcut: () => void copy(),
      onSelectionChange: setSelected,
      onTitle: setTitle,
      onBell: () => setFeedback("Terminal bell."),
    });
    xtermRef.current = xterm;
    const transport = new TerminalTransport({
      endpoint,
      runGeneration,
      viewerId: viewerId.current,
      requestedRole: "controller",
      cols: xterm.terminal.cols,
      rows: xterm.terminal.rows,
      onFrame,
      onState: setState,
    });
    transportRef.current = transport;
    const removeClipboardEvents = installTrustedClipboardEvents(host, xterm.terminal, (text) =>
      transport.paste(text),
    );
    const removeCopyOnSelect = installCopyOnSelect(host, xterm.terminal, () => void copy());
    transport.connect();
    return () => {
      removeCopyOnSelect();
      removeClipboardEvents();
      transport.dispose();
      xterm.dispose();
      transportRef.current = null;
      xtermRef.current = null;
    };
  }, [copy, endpoint, runGeneration]);

  useEffect(() => {
    xtermRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    xtermRef.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (suspended) {
      setEffect(undefined);
      transportRef.current?.releaseController();
    }
  }, [suspended]);

  useEffect(() => setEffect(undefined), [endpoint.runId, runGeneration]);

  useEffect(() => {
    if (effect === undefined) return;
    const remaining = Date.parse(effect.expiresAt) - Date.now();
    if (remaining <= 0) {
      setEffect(undefined);
      return;
    }
    const timeout = window.setTimeout(
      () => setEffect((current) => (current?.effectId === effect.effectId ? undefined : current)),
      remaining,
    );
    return () => window.clearTimeout(timeout);
  }, [effect]);

  useEffect(() => {
    if (!actionMenuOpen) return;
    actionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!actionMenuRef.current?.contains(event.target as Node)) setActionMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setActionMenuOpen(false);
      actionMenuTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionMenuOpen]);

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
      data-terminal-mount-id={mountId.current}
      data-terminal-visible={visible}
    >
      <TerminalLeaseBanner
        role={role}
        state={state}
        title={title}
        identity={headerIdentity}
        memberIdentity={memberIdentity}
        paneActions={paneActions}
        onTakeover={() => transportRef.current?.takeover()}
        onRelease={() => transportRef.current?.releaseController()}
        actions={
          <div className="terminal-actions" role="toolbar" aria-label="Terminal actions">
            <div className="terminal-info">
              <span
                className="terminal-info-trigger"
                tabIndex={0}
                aria-label="Terminal selection help"
                aria-describedby={`${mountId.current}-selection-help`}
              >
                <Info aria-hidden="true" size={15} />
              </span>
              <span
                id={`${mountId.current}-selection-help`}
                className="terminal-info-tooltip"
                role="tooltip"
              >
                {selectionHint}
              </span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Copy"
              title="Copy terminal selection"
              disabled={!selected}
              onClick={() => void copy()}
            >
              <Copy aria-hidden="true" size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Paste"
              title="Paste clipboard text"
              disabled={role !== "controller" || state !== "connected"}
              onClick={() => void paste()}
            >
              <ClipboardPaste aria-hidden="true" size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Search"
              title="Search terminal"
              aria-pressed={searching}
              onClick={() => setSearching((value) => !value)}
            >
              <Search aria-hidden="true" size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Transcript"
              title="Open terminal transcript"
              onClick={openTranscript}
            >
              <ScrollText aria-hidden="true" size={15} />
            </button>
            <div ref={actionMenuRef} className="terminal-action-menu-anchor">
              <button
                ref={actionMenuTriggerRef}
                type="button"
                className="icon-button"
                aria-label="More terminal actions"
                title="More terminal actions"
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
                onClick={() => setActionMenuOpen((open) => !open)}
              >
                <EllipsisVertical aria-hidden="true" size={15} />
              </button>
              {actionMenuOpen && (
                <div
                  className="terminal-action-menu"
                  role="menu"
                  aria-label="More terminal actions"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      xtermRef.current?.selectAll();
                      setActionMenuOpen(false);
                    }}
                  >
                    <TextSelect aria-hidden="true" size={14} />
                    <span>Select all scrollback</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!selected}
                    onClick={() => {
                      xtermRef.current?.clearSelection();
                      setActionMenuOpen(false);
                    }}
                  >
                    <Eraser aria-hidden="true" size={14} />
                    <span>Clear selection</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        }
      />
      <div className="terminal-prelude">
        {searching && (
          <form
            className="terminal-search"
            onSubmit={(event) => {
              event.preventDefault();
              const found = xtermRef.current?.search(search) ?? false;
              setFeedback(found ? "Terminal match found." : "No terminal match found.");
            }}
          >
            <label>
              Search terminal{" "}
              <input value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <button type="submit">Find next</button>
          </form>
        )}
      </div>
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
          <button
            type="button"
            onClick={() => {
              const pending = effect;
              if (Date.parse(pending.expiresAt) <= Date.now()) {
                setEffect(undefined);
                setFeedback("Terminal clipboard request expired.");
                return;
              }
              void writeClipboardText(pending.data).then((outcome) => {
                if ("message" in outcome) {
                  setFeedback(outcome.message);
                  return;
                }
                setEffect((current) =>
                  current?.effectId === pending.effectId ? undefined : current,
                );
                setFeedback("Terminal clipboard request copied.");
              });
            }}
          >
            Copy
          </button>
          <button type="button" onClick={() => setEffect(undefined)}>
            Deny
          </button>
        </div>
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
