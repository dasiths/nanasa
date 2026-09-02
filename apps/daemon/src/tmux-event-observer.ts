import { randomBytes, timingSafeEqual } from "node:crypto";

export type TmuxInvalidationKind =
  | "pane_died"
  | "pane_exited"
  | "pane_mode_changed"
  | "window_changed"
  | "session_changed"
  | "screen_dirty"
  | "bell";

export interface TmuxInvalidation {
  serverName: string;
  kind: TmuxInvalidationKind;
  paneId?: string;
  windowId?: string;
  sessionId?: string;
  observedAt: string;
}

const INVALIDATION_KINDS = new Set<TmuxInvalidationKind>([
  "pane_died",
  "pane_exited",
  "pane_mode_changed",
  "window_changed",
  "session_changed",
  "screen_dirty",
  "bell",
]);

export class TmuxEventObserver {
  readonly #serverName: string;
  readonly #token: string;
  readonly #invalidate: (invalidation: TmuxInvalidation) => void;

  public constructor(serverName: string, invalidate: (invalidation: TmuxInvalidation) => void) {
    this.#serverName = serverName;
    this.#token = randomBytes(32).toString("hex");
    this.#invalidate = invalidate;
  }

  public token(): string {
    return this.#token;
  }

  public hookCommand(endpoint: string, kind: TmuxInvalidationKind): string {
    const script =
      "const [url,token,serverName,kind,paneId,windowId,sessionId]=process.argv.slice(1);" +
      "fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({serverName,kind,paneId,windowId,sessionId})}).catch(()=>{});";
    return [
      process.execPath,
      "-e",
      script,
      endpoint,
      this.#token,
      this.#serverName,
      kind,
      "#{pane_id}",
      "#{window_id}",
      "#{session_id}",
    ]
      .map((value) => `'${value.replaceAll("'", `'"'"'`)}'`)
      .join(" ");
  }

  public notify(token: string, invalidation: Omit<TmuxInvalidation, "observedAt">): void {
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.#token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("tmux_invalidation_unauthorized");
    }
    if (invalidation.serverName !== this.#serverName)
      throw new Error("tmux_invalidation_wrong_server");
    if (!INVALIDATION_KINDS.has(invalidation.kind))
      throw new Error("tmux_invalidation_kind_invalid");
    this.#invalidate({ ...invalidation, observedAt: new Date().toISOString() });
  }
}
