import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XtermController } from "./xterm-controller.js";

const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  refresh: vi.fn(),
  reset: vi.fn(),
  clear: vi.fn(),
  observerDisconnect: vi.fn(),
  terminalDispose: vi.fn(),
  terminalWrites: [] as string[],
  writeCallbacks: [] as Array<() => void>,
  webglDispose: vi.fn(),
  webglContextLoss: undefined as (() => void) | undefined,
  resizeCallback: undefined as (() => void) | undefined,
  animationCallback: undefined as FrameRequestCallback | undefined,
  keyEventHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  hasSelection: false,
  failWebgl: false,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    public fit(): void {
      mocks.fit();
    }
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    public findNext(): boolean {
      return false;
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    public constructor() {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    public onContextLoss(callback: () => void): { dispose(): void } {
      mocks.webglContextLoss = callback;
      return { dispose: vi.fn() };
    }

    public activate(): void {
      if (mocks.failWebgl) throw new Error("WebGL unavailable");
    }

    public dispose(): void {
      mocks.webglDispose();
    }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    public readonly rows = 24;
    public readonly cols = 80;
    public readonly options: Record<string, unknown> = {};

    public loadAddon(addon: { activate?(terminal: unknown): void }): void {
      addon.activate?.(this);
    }

    public open(host: HTMLElement): void {
      const element = document.createElement("div");
      element.className = "xterm";
      host.append(element);
    }

    public onData(): { dispose(): void } {
      return { dispose: vi.fn() };
    }

    public onResize(): { dispose(): void } {
      return { dispose: vi.fn() };
    }

    public onSelectionChange(): { dispose(): void } {
      return { dispose: vi.fn() };
    }

    public onTitleChange(): { dispose(): void } {
      return { dispose: vi.fn() };
    }

    public onBell(): { dispose(): void } {
      return { dispose: vi.fn() };
    }

    public attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      mocks.keyEventHandler = handler;
    }

    public write(data: string, callback?: () => void): void {
      mocks.terminalWrites.push(data);
      if (callback !== undefined) mocks.writeCallbacks.push(callback);
    }

    public reset(): void {
      mocks.reset();
    }
    public clear(): void {
      mocks.clear();
    }
    public focus(): void {}
    public refresh(start: number, end: number): void {
      mocks.refresh(start, end);
    }
    public hasSelection(): boolean {
      return mocks.hasSelection;
    }
    public selectAll(): void {}
    public clearSelection(): void {}
    public dispose(): void {
      mocks.terminalDispose();
    }
  },
}));

class MockResizeObserver {
  public constructor(callback: () => void) {
    mocks.resizeCallback = callback;
  }

  public observe(): void {}
  public disconnect(): void {
    mocks.observerDisconnect();
  }
}

const options = {
  theme: "dark" as const,
  visible: false,
  onData: vi.fn(),
  onResize: vi.fn(),
  onFocus: vi.fn(),
  onCopyShortcut: vi.fn(),
  onSelectionChange: vi.fn(),
  onTitle: vi.fn(),
  onBell: vi.fn(),
};

beforeEach(() => {
  mocks.fit.mockClear();
  mocks.refresh.mockClear();
  mocks.reset.mockClear();
  mocks.clear.mockClear();
  mocks.observerDisconnect.mockClear();
  mocks.terminalDispose.mockClear();
  mocks.terminalWrites.length = 0;
  mocks.writeCallbacks.length = 0;
  mocks.webglDispose.mockClear();
  mocks.webglContextLoss = undefined;
  mocks.resizeCallback = undefined;
  mocks.animationCallback = undefined;
  mocks.keyEventHandler = undefined;
  mocks.hasSelection = false;
  mocks.failWebgl = false;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    mocks.animationCallback = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function createHost(): HTMLElement {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 500 },
  });
  document.body.append(host);
  return host;
}

describe("XtermController", () => {
  it("uses copy shortcuts for selections and preserves Ctrl+C input otherwise", () => {
    const onCopyShortcut = vi.fn();
    const controller = new XtermController(createHost(), { ...options, onCopyShortcut });
    const copyEvent = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });

    expect(mocks.keyEventHandler?.(copyEvent)).toBe(true);
    mocks.hasSelection = true;
    expect(mocks.keyEventHandler?.(copyEvent)).toBe(false);
    expect(onCopyShortcut).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("defers hidden fits and activates WebGL after the terminal becomes visible", () => {
    const host = createHost();
    const controller = new XtermController(host, options);

    expect(mocks.fit).not.toHaveBeenCalled();
    expect(host.dataset.terminalRenderer).toBe("dom");

    controller.setVisible(true);
    expect(mocks.animationCallback).toBeDefined();
    mocks.animationCallback?.(0);

    expect(mocks.fit).toHaveBeenCalledOnce();
    expect(host.dataset.terminalRenderer).toBe("webgl");
    expect(mocks.refresh).toHaveBeenCalledWith(0, 23);

    controller.setVisible(false);
    mocks.resizeCallback?.();
    expect(mocks.fit).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("keeps the DOM renderer when WebGL activation fails", () => {
    mocks.failWebgl = true;
    const host = createHost();
    const controller = new XtermController(host, { ...options, visible: true });

    expect(mocks.fit).toHaveBeenCalledOnce();
    expect(host.dataset.terminalRenderer).toBe("dom");
    expect(mocks.webglDispose).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("falls back to DOM rendering after WebGL context loss", () => {
    const host = createHost();
    const controller = new XtermController(host, { ...options, visible: true });

    expect(host.dataset.terminalRenderer).toBe("webgl");
    mocks.webglContextLoss?.();

    expect(host.dataset.terminalRenderer).toBe("dom");
    expect(mocks.webglDispose).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledWith(0, 23);
    controller.dispose();
  });

  it("replaces stale queued output before appending new live output", () => {
    const controller = new XtermController(createHost(), options);

    controller.write("in-flight");
    controller.write("stale-queued");
    controller.replace("baseline");
    controller.write("live");
    expect(mocks.terminalWrites).toEqual(["in-flight"]);

    mocks.writeCallbacks.shift()?.();
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.terminalWrites).toEqual(["in-flight", "baseline"]);

    mocks.writeCallbacks.shift()?.();
    expect(mocks.terminalWrites).toEqual(["in-flight", "baseline", "live"]);
    controller.dispose();
  });

  it("coalesces resize observations and cancels pending work when hidden", () => {
    const controller = new XtermController(createHost(), { ...options, visible: true });
    const cancel = vi.mocked(cancelAnimationFrame);

    mocks.resizeCallback?.();
    const scheduled = mocks.animationCallback;
    mocks.resizeCallback?.();
    expect(scheduled).toBe(mocks.animationCallback);

    controller.setVisible(false);
    expect(cancel).toHaveBeenCalledWith(1);
    controller.dispose();
    expect(mocks.observerDisconnect).toHaveBeenCalledOnce();
    expect(mocks.terminalDispose).toHaveBeenCalledOnce();
  });

  it("does not fit or initialize WebGL without positive geometry", () => {
    const host = createHost();
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 0 });
    const controller = new XtermController(host, { ...options, visible: true });

    expect(mocks.fit).not.toHaveBeenCalled();
    expect(host.dataset.terminalRenderer).toBe("dom");
    controller.dispose();
  });

  it("freezes observer geometry and refits when control is acquired", () => {
    const controller = new XtermController(createHost(), { ...options, visible: true });
    expect(mocks.fit).toHaveBeenCalledOnce();

    controller.setFitEnabled(false);
    mocks.resizeCallback?.();
    expect(mocks.fit).toHaveBeenCalledOnce();

    controller.setFitEnabled(true);
    mocks.animationCallback?.(0);
    expect(mocks.fit).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
