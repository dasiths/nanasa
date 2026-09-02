import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";

export interface XtermControllerOptions {
  theme: "light" | "dark";
  visible: boolean;
  fitEnabled?: boolean;
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onFocus(focused: boolean): void;
  onCopyShortcut(): void;
  onSelectionChange(selected: boolean): void;
  onTitle(title: string): void;
  onBell(): void;
}

const themes: Record<"light" | "dark", ITheme> = {
  dark: {
    background: "#111614",
    foreground: "#e1ebe7",
    cursor: "#7ad7b0",
    selectionBackground: "#315e50",
  },
  light: {
    background: "#f7faf8",
    foreground: "#14201e",
    cursor: "#176b52",
    selectionBackground: "#b9dfd1",
  },
};

export class XtermController {
  readonly terminal: Terminal;
  readonly #fit = new FitAddon();
  readonly #search = new SearchAddon();
  readonly #resizeObserver: ResizeObserver;
  readonly #disposables: Array<{ dispose(): void }> = [];
  #visible: boolean;
  #fitEnabled: boolean;
  #fitFrame: number | undefined;
  #webgl: WebglAddon | undefined;
  #webglUnavailable = false;
  #writeInProgress = false;
  #writeQueue: Array<{ type: "append" | "replace" | "reset"; data?: string }> = [];
  #disposed = false;

  public constructor(
    private readonly host: HTMLElement,
    private readonly options: XtermControllerOptions,
  ) {
    this.#visible = options.visible;
    this.#fitEnabled = options.fitEnabled ?? true;
    this.terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      scrollback: 10_000,
      scrollOnUserInput: true,
      theme: themes[options.theme],
    });
    this.terminal.attachCustomKeyEventHandler((event) => {
      const copyShortcut =
        event.type === "keydown" &&
        event.key.toLowerCase() === "c" &&
        (event.ctrlKey || event.metaKey);
      if (!copyShortcut || !this.terminal.hasSelection()) return true;
      options.onCopyShortcut();
      return false;
    });
    this.terminal.loadAddon(this.#fit);
    this.terminal.loadAddon(this.#search);
    this.terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        let url: URL;
        try {
          url = new URL(uri);
        } catch {
          return;
        }
        if (!["http:", "https:"].includes(url.protocol)) return;
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      }),
    );
    this.terminal.open(host);
    this.host.dataset.terminalRenderer = "dom";
    this.#disposables.push(
      this.terminal.onData(options.onData),
      this.terminal.onResize(({ cols, rows }) => options.onResize(cols, rows)),
      this.terminal.onSelectionChange(() =>
        options.onSelectionChange(this.terminal.hasSelection()),
      ),
      this.terminal.onTitleChange((title) =>
        options.onTitle(
          [...title]
            .filter((character) => {
              const code = character.codePointAt(0) ?? 0;
              return code >= 32 && code !== 127;
            })
            .join("")
            .slice(0, 120),
        ),
      ),
      this.terminal.onBell(options.onBell),
    );
    const textarea = host.querySelector(".xterm-helper-textarea");
    textarea?.addEventListener("focus", () => options.onFocus(true));
    textarea?.addEventListener("blur", () => options.onFocus(false));
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleFit());
    this.#resizeObserver.observe(host);
    this.fit();
  }

  public write(data: string): void {
    this.#writeQueue.push({ type: "append", data });
    this.#drainWrites();
  }

  public replace(data: string): void {
    this.#writeQueue = [{ type: "replace", data }];
    this.#drainWrites();
  }

  public reset(): void {
    this.#writeQueue = [{ type: "reset" }];
    this.#drainWrites();
  }

  public focus(): void {
    this.terminal.focus();
  }

  public fit(): void {
    if (
      !this.#visible ||
      !this.#fitEnabled ||
      !this.host.isConnected ||
      this.host.clientWidth <= 0 ||
      this.host.clientHeight <= 0
    ) {
      return;
    }
    try {
      this.#initializeWebgl();
      this.#fit.fit();
    } catch {
      // The host can detach between the geometry check and fit operation.
    }
  }

  public setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (!visible) {
      if (this.#fitFrame !== undefined) cancelAnimationFrame(this.#fitFrame);
      this.#fitFrame = undefined;
      return;
    }
    this.#scheduleFit();
  }

  public setFitEnabled(enabled: boolean): void {
    if (this.#fitEnabled === enabled) return;
    this.#fitEnabled = enabled;
    if (!enabled) {
      if (this.#fitFrame !== undefined) cancelAnimationFrame(this.#fitFrame);
      this.#fitFrame = undefined;
      return;
    }
    this.#scheduleFit();
  }

  public search(term: string): boolean {
    return this.#search.findNext(term, { incremental: true });
  }

  public selectAll(): void {
    this.terminal.selectAll();
  }

  public clearSelection(): void {
    this.terminal.clearSelection();
  }

  public setTheme(theme: "light" | "dark"): void {
    this.terminal.options.theme = themes[theme];
  }

  public dispose(): void {
    this.#disposed = true;
    this.#visible = false;
    this.#writeQueue = [];
    if (this.#fitFrame !== undefined) cancelAnimationFrame(this.#fitFrame);
    this.#fitFrame = undefined;
    this.#resizeObserver.disconnect();
    for (const disposable of this.#disposables) disposable.dispose();
    this.terminal.dispose();
  }

  #scheduleFit(): void {
    if (!this.#visible || !this.#fitEnabled || this.#fitFrame !== undefined || this.#disposed)
      return;
    this.#fitFrame = requestAnimationFrame(() => {
      this.#fitFrame = undefined;
      this.fit();
      if (this.#visible && !this.#disposed) {
        this.terminal.refresh(0, this.terminal.rows - 1);
      }
    });
  }

  #initializeWebgl(): void {
    if (this.#webgl !== undefined || this.#webglUnavailable) return;
    let addon: WebglAddon | undefined;
    try {
      addon = new WebglAddon();
      const contextLoss = addon.onContextLoss(() => {
        if (this.#webgl !== addon) return;
        this.#webgl = undefined;
        this.#webglUnavailable = true;
        this.host.dataset.terminalRenderer = "dom";
        addon?.dispose();
        if (!this.#disposed) this.terminal.refresh(0, this.terminal.rows - 1);
      });
      this.#disposables.push(contextLoss);
      this.terminal.loadAddon(addon);
      this.#webgl = addon;
      this.host.dataset.terminalRenderer = "webgl";
    } catch {
      this.#webglUnavailable = true;
      this.host.dataset.terminalRenderer = "dom";
      addon?.dispose();
    }
  }

  #drainWrites(): void {
    if (this.#writeInProgress || this.#disposed) return;
    const operation = this.#writeQueue.shift();
    if (operation === undefined) return;
    if (operation.type === "reset") {
      this.terminal.reset();
      this.terminal.clear();
      this.#drainWrites();
      return;
    }
    if (operation.type === "replace") {
      this.terminal.reset();
      this.terminal.clear();
    }
    this.#writeInProgress = true;
    this.terminal.write(operation.data ?? "", () => {
      this.#writeInProgress = false;
      this.#drainWrites();
    });
  }
}
