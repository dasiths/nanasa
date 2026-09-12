import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  CreateForemanConnectorCommandSchema,
  type ForemanConnector,
  OperatorBootstrapCommandSchema,
  type OperatorBootstrapGrant,
  OperatorBootstrapGrantSchema,
  type OperatorSession,
  OperatorSessionSchema,
} from "@nanasa/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "./store.js";

const COOKIE_NAME = "nanasa_operator";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;
const MAX_BOOTSTRAP_TOKENS = 32;

interface SessionRecord extends OperatorSession {
  id: string;
  revoked: boolean;
  connectorId?: string;
}

export interface OperatorAuthOptions {
  secretPath: string;
  secureCookies?: boolean;
  expectedUid?: number;
  now?: () => Date;
  database?: DatabaseSync;
}

function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function tokenEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function secret(path: string, expectedUid = process.getuid?.()): Buffer {
  const directory = resolve(dirname(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = lstatSync(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    (expectedUid !== undefined && directoryMetadata.uid !== expectedUid)
  ) {
    throw new Error("Operator credential directory must be owner-controlled without symlinks");
  }
  chmodSync(directory, 0o700);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      const value = randomBytes(32);
      writeFileSync(descriptor, value);
      fchmodSync(descriptor, 0o600);
      return value;
    } finally {
      closeSync(descriptor);
    }
  }
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (expectedUid !== undefined && metadata.uid !== expectedUid)
    ) {
      throw new Error("Operator credential must be an owner-only regular file");
    }
    const value = readFileSync(descriptor);
    if (value.length !== 32) throw new Error("Operator credential must contain 32 bytes");
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function cookieValue(request: FastifyRequest): string | undefined {
  for (const item of (request.headers.cookie ?? "").split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === COOKIE_NAME) return parts.join("=");
  }
  return undefined;
}

export class OperatorAuth {
  readonly #database: DatabaseSync | undefined;
  readonly #credential: string;
  readonly #secureCookies: boolean;
  readonly #now: () => Date;
  readonly #bootstrapTokens = new Map<string, number>();
  readonly #sessions = new Map<string, SessionRecord>();

  public constructor(options: OperatorAuthOptions) {
    this.#database = options.database;
    this.#credential = secret(options.secretPath, options.expectedUid).toString("base64url");
    this.#secureCookies = options.secureCookies ?? false;
    this.#now = options.now ?? (() => new Date());
  }

  public createBootstrapToken(): string {
    const now = this.#now().getTime();
    for (const [token, expiresAt] of this.#bootstrapTokens) {
      if (expiresAt < now) this.#bootstrapTokens.delete(token);
    }
    while (this.#bootstrapTokens.size >= MAX_BOOTSTRAP_TOKENS) {
      const oldest = this.#bootstrapTokens.keys().next().value;
      if (oldest === undefined) break;
      this.#bootstrapTokens.delete(oldest);
    }
    const token = opaqueToken();
    this.#bootstrapTokens.set(token, now + BOOTSTRAP_TTL_MS);
    return token;
  }

  public createBootstrapGrant(): OperatorBootstrapGrant {
    const token = this.createBootstrapToken();
    return OperatorBootstrapGrantSchema.parse({
      fragment: `nanasa-bootstrap=${token}`,
      expiresAt: new Date(this.#now().getTime() + BOOTSTRAP_TTL_MS).toISOString(),
    });
  }

  public bootstrap(command: unknown, reply: FastifyReply): OperatorSession {
    const { token } = OperatorBootstrapCommandSchema.parse(command);
    const expiresAt = this.#bootstrapTokens.get(token);
    this.#bootstrapTokens.delete(token);
    if (expiresAt === undefined || expiresAt < this.#now().getTime()) {
      throw new DomainError(
        "operator_bootstrap_invalid",
        "The operator bootstrap token is invalid or already used",
        401,
      );
    }
    return this.#issueSession(reply);
  }

  public session(request: FastifyRequest): OperatorSession {
    return this.#publicSession(this.authenticate(request));
  }

  public revoke(request: FastifyRequest, reply: FastifyReply): void {
    const session = this.authenticate(request);
    session.revoked = true;
    this.#sessions.delete(session.id);
    this.#clearCookie(reply);
  }

  public authenticate(request: FastifyRequest): SessionRecord {
    const authorization = request.headers.authorization;
    if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
      const value = authorization.slice("Bearer ".length);
      const row = this.#database
        ?.prepare("SELECT data_json FROM foreman_connectors WHERE token_hash = ?")
        .get(createHash("sha256").update(value).digest("hex"));
      if (row !== undefined) {
        const connector = JSON.parse(String(row.data_json)) as ForemanConnector;
        if (connector.revoked || Date.parse(connector.expiresAt) <= this.#now().getTime())
          throw new DomainError(
            "operator_unauthorized",
            "Connector credential expired or revoked",
            401,
          );
        const path = request.url.split("?", 1)[0]!;
        const base = "/api/v1/foreman";
        const allowed = connector.scopes.some((scope) => {
          if (scope === "notifications")
            return (
              (request.method === "GET" &&
                [base + "/notifications", base + "/notifications/cursor"].includes(path)) ||
              (request.method === "POST" && path === base + "/notifications/ack")
            );
          if (scope === "conversation")
            return (
              (["GET", "POST"].includes(request.method) && path === base + "/channel") ||
              (request.method === "GET" && path === base + "/conversations")
            );
          if (scope === "goals")
            return (
              (request.method === "GET" &&
                (path === base + "/goals" ||
                  /^\/api\/v1\/foreman\/goals\/goal_[a-zA-Z0-9_-]+$/.test(path))) ||
              (request.method === "POST" && path === base + "/goals")
            );
          if (scope === "decisions")
            return request.method === "POST" && path === base + "/decisions/resolve";
          return (
            request.method === "POST" &&
            [base + "/goals/control", base + "/run/stop"].includes(path)
          );
        });
        if (!allowed)
          throw new DomainError(
            "connector_scope_forbidden",
            "Connector scope does not permit this operation",
            403,
          );
        return {
          id: connector.id,
          connectorId: connector.id,
          operatorId: connector.principalId,
          csrfToken: "connector-bearer",
          expiresAt: connector.expiresAt,
          revoked: false,
        };
      }
      if (tokenEquals(value, this.#credential)) {
        return {
          id: "cli",
          operatorId: "operator-local-cli",
          csrfToken: "bearer-authority-does-not-use-csrf",
          expiresAt: new Date(8_640_000_000_000_000).toISOString(),
          revoked: false,
        };
      }
    }
    const id = cookieValue(request);
    const session = id === undefined ? undefined : this.#sessions.get(id);
    if (
      session === undefined ||
      session.revoked ||
      Date.parse(session.expiresAt) <= this.#now().getTime()
    ) {
      if (id !== undefined) this.#sessions.delete(id);
      throw new DomainError("operator_unauthorized", "An operator session is required", 401);
    }
    return session;
  }

  public authorize(request: FastifyRequest): void {
    const session = this.authenticate(request);
    if (
      ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
      session.id === "cli" ||
      session.connectorId !== undefined
    )
      return;
    const csrf = request.headers["x-nanasa-csrf"];
    if (typeof csrf !== "string" || !tokenEquals(csrf, session.csrfToken)) {
      throw new DomainError("csrf_invalid", "A valid operator CSRF token is required", 403);
    }
  }

  public createConnector(command: unknown) {
    if (!this.#database)
      throw new DomainError("connector_unavailable", "Connector persistence is unavailable", 503);
    const input = CreateForemanConnectorCommandSchema.parse(command);
    const token = opaqueToken();
    const connector: ForemanConnector = {
      id: `connector_${opaqueToken(16)}`,
      principalId: input.principalId,
      name: input.name,
      scopes: [...new Set(input.scopes)],
      expiresAt: new Date(this.#now().getTime() + input.expiresInHours * 3600000).toISOString(),
      createdAt: this.#now().toISOString(),
      revoked: false,
    };
    this.#database
      .prepare("INSERT INTO foreman_connectors VALUES (?, ?, ?)")
      .run(
        connector.id,
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify(connector),
      );
    return { connector, token };
  }
  public listConnectors(): ForemanConnector[] {
    return (
      this.#database?.prepare("SELECT data_json FROM foreman_connectors ORDER BY rowid").all() ?? []
    ).map((row) => JSON.parse(String(row.data_json)) as ForemanConnector);
  }
  public revokeConnector(id: string) {
    const connector = this.listConnectors().find((item) => item.id === id);
    if (!connector) throw new DomainError("connector_not_found", "Connector not found", 404);
    connector.revoked = true;
    this.#database!.prepare("UPDATE foreman_connectors SET data_json = ? WHERE id = ?").run(
      JSON.stringify(connector),
      id,
    );
    return connector;
  }

  #issueSession(reply: FastifyReply): OperatorSession {
    const now = this.#now();
    const session: SessionRecord = {
      id: opaqueToken(),
      operatorId: "operator-local-portal",
      csrfToken: opaqueToken(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      revoked: false,
    };
    this.#sessions.set(session.id, session);
    const attributes = [
      `${COOKIE_NAME}=${session.id}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}`,
      ...(this.#secureCookies ? ["Secure"] : []),
    ];
    reply.header("Set-Cookie", attributes.join("; "));
    return OperatorSessionSchema.parse(this.#publicSession(session));
  }

  #publicSession(session: SessionRecord): OperatorSession {
    return {
      operatorId: session.operatorId,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  }

  #clearCookie(reply: FastifyReply): void {
    reply.header(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.#secureCookies ? "; Secure" : ""}`,
    );
  }
}
