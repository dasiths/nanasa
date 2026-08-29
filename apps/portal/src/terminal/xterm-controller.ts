import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";

export interface XtermControllerOptions {
  theme: "light" | "dark";
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onFocus(focused: boolean): void;
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

  public constructor(
    private readonly host: HTMLElement,
    private readonly options: XtermControllerOptions,
  ) {
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
    this.#resizeObserver = new ResizeObserver(() => this.fit());
    this.#resizeObserver.observe(host);
    this.fit();
  }

  public write(data: string): void {
    this.terminal.write(data);
  }

  public reset(): void {
    this.terminal.reset();
    this.terminal.clear();
  }

  public focus(): void {
    this.terminal.focus();
  }

  public fit(): void {
    try {
      this.#fit.fit();
    } catch {
      // Hidden terminal surfaces have no measurable geometry yet.
    }
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
    this.#resizeObserver.disconnect();
    for (const disposable of this.#disposables) disposable.dispose();
    this.terminal.dispose();
  }
}
