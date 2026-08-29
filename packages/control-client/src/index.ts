import {
  ControlMetadataSchema,
  EventServerFrameSchema,
  OperatorSessionSchema,
  type ControlMetadata,
  type EventServerFrame,
  type OperatorSession,
} from "@nanasa/contracts";

export const CONTROL_API_PREFIX = "/api/v1";
export const CSRF_HEADER = "x-nanasa-csrf";
export const BOOTSTRAP_FRAGMENT_KEY = "nanasa-bootstrap";

export interface Schema<T> {
  parse(value: unknown): T;
}

export class ControlClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ControlClientError";
  }
}

export interface ControlClientOptions {
  fetch?: typeof globalThis.fetch;
  websocket?: (url: string) => WebSocket;
  location?: Pick<Location, "href" | "hash">;
  replaceLocation?: (url: string) => void;
}

function errorFields(payload: unknown): { code?: string; message?: string } {
  if (typeof payload !== "object" || payload === null) return {};
  if ("error" in payload && typeof payload.error === "object" && payload.error !== null) {
    const error = payload.error as Record<string, unknown>;
    return {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : {}),
    };
  }
  const value = payload as Record<string, unknown>;
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

export class NanasaControlClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #websocket: (url: string) => WebSocket;
  readonly #location: Pick<Location, "href" | "hash"> | undefined;
  readonly #replaceLocation: ((url: string) => void) | undefined;
  #csrfToken: string | undefined;
  #bootstrapPromise: Promise<OperatorSession> | undefined;

  public constructor(options: ControlClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#websocket = options.websocket ?? ((url) => new WebSocket(url));
    this.#location = options.location ?? globalThis.location;
    this.#replaceLocation =
      options.replaceLocation ??
      (globalThis.history === undefined
        ? undefined
        : (url) => globalThis.history.replaceState(null, "", url));
  }

  public metadata(): Promise<ControlMetadata> {
    return this.request(`${CONTROL_API_PREFIX}/meta`, ControlMetadataSchema, {
      authenticate: false,
    });
  }

  public ensureSession(): Promise<OperatorSession> {
    this.#bootstrapPromise ??= this.#establishSession().catch((error: unknown) => {
      this.#bootstrapPromise = undefined;
      throw error;
    });
    return this.#bootstrapPromise;
  }

  public async request<T>(
    path: string,
    schema: Schema<T>,
    options: { init?: RequestInit; authenticate?: boolean } = {},
  ): Promise<T> {
    const authenticate = options.authenticate ?? true;
    if (authenticate) await this.ensureSession();
    const init = this.#authorizedInit(options.init, authenticate);
    const response = await this.#fetch(path, init);
    const payload: unknown = await response.json();
    if (!response.ok) {
      const fields = errorFields(payload);
      throw new ControlClientError(
        fields.message ?? `Request failed with status ${response.status}`,
        response.status,
        fields.code,
      );
    }
    return schema.parse(payload);
  }

  public async requestVoid(path: string, init: RequestInit): Promise<void> {
    await this.ensureSession();
    const response = await this.#fetch(path, this.#authorizedInit(init, true));
    if (response.ok) return;
    const payload: unknown = await response.json();
    const fields = errorFields(payload);
    throw new ControlClientError(
      fields.message ?? `Request failed with status ${response.status}`,
      response.status,
      fields.code,
    );
  }

  public openEvents(afterSequence: number, instanceId: string): WebSocket {
    if (this.#location === undefined) throw new Error("A browser location is required");
    const url = new URL(`${CONTROL_API_PREFIX}/events`, this.#location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("after", String(afterSequence));
    url.searchParams.set("instance", instanceId);
    return this.#websocket(url.toString());
  }

  public parseEventFrame(value: unknown): EventServerFrame {
    return EventServerFrameSchema.parse(value);
  }

  public clearSession(): void {
    this.#csrfToken = undefined;
    this.#bootstrapPromise = undefined;
  }

  async #establishSession(): Promise<OperatorSession> {
    const token = this.#consumeBootstrapFragment();
    const response = await this.#fetch(
      token === undefined
        ? `${CONTROL_API_PREFIX}/auth/session`
        : `${CONTROL_API_PREFIX}/auth/bootstrap`,
      token === undefined
        ? { credentials: "same-origin" }
        : {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ token }),
          },
    );
    const payload: unknown = await response.json();
    if (!response.ok) {
      const fields = errorFields(payload);
      throw new ControlClientError(
        fields.message ?? "Unable to establish an operator session",
        response.status,
        fields.code,
      );
    }
    const session = OperatorSessionSchema.parse(payload);
    this.#csrfToken = session.csrfToken;
    return session;
  }

  #consumeBootstrapFragment(): string | undefined {
    if (this.#location === undefined || this.#location.hash.length <= 1) return undefined;
    const parameters = new URLSearchParams(this.#location.hash.slice(1));
    const token = parameters.get(BOOTSTRAP_FRAGMENT_KEY) ?? undefined;
    if (token === undefined) return undefined;
    parameters.delete(BOOTSTRAP_FRAGMENT_KEY);
    const url = new URL(this.#location.href);
    url.hash = parameters.size === 0 ? "" : parameters.toString();
    this.#replaceLocation?.(url.toString());
    return token;
  }

  #authorizedInit(init: RequestInit | undefined, authenticate: boolean): RequestInit | undefined {
    if (init === undefined) return undefined;
    const headers =
      typeof init.headers === "object" &&
      init.headers !== null &&
      !(init.headers instanceof Headers) &&
      !Array.isArray(init.headers)
        ? { ...init.headers }
        : Object.fromEntries(new Headers(init.headers).entries());
    const method = (init?.method ?? "GET").toUpperCase();
    if (authenticate && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (this.#csrfToken === undefined) throw new Error("Operator CSRF token is unavailable");
      headers[CSRF_HEADER] = this.#csrfToken;
    }
    return { ...init, credentials: "same-origin", headers };
  }
}
