import type { FastifyRequest } from "fastify";
import { DomainError } from "./store.js";

export interface AuthorityPolicyOptions {
  allowedHostnames?: readonly string[];
  trustedProxyAddresses?: readonly string[];
}

function normalizedHostname(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export function isLoopbackAddress(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function assertLoopbackControlHost(host: string): void {
  if (!isLoopbackAddress(host)) {
    throw new Error(
      "NANASA_HOST must remain loopback; remote control-plane publication is not supported",
    );
  }
}

export class AuthorityPolicy {
  readonly #allowedHostnames: ReadonlySet<string>;
  readonly #trustedProxyAddresses: ReadonlySet<string>;

  public constructor(options: AuthorityPolicyOptions = {}) {
    this.#allowedHostnames = new Set(
      (options.allowedHostnames ?? ["localhost", "127.0.0.1", "::1"]).map((host) =>
        host.replace(/^\[|\]$/g, "").toLowerCase(),
      ),
    );
    this.#trustedProxyAddresses = new Set(options.trustedProxyAddresses ?? []);
  }

  public validate(request: FastifyRequest): void {
    const forwarded = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].filter(
      (name) => request.headers[name] !== undefined,
    );
    const remoteAddress = request.ip;
    if (forwarded.length > 0 && !this.#trustedProxyAddresses.has(remoteAddress)) {
      throw new DomainError(
        "untrusted_forwarded_headers",
        "Forwarded authority headers require an explicitly trusted proxy",
        400,
      );
    }
    const hostValue = request.headers["x-forwarded-host"] ?? request.headers.host;
    if (typeof hostValue !== "string" || hostValue.includes(",")) {
      throw new DomainError("invalid_host", "The request Host authority is invalid", 400);
    }
    const hostname = normalizedHostname(hostValue);
    if (hostname === undefined || !this.#allowedHostnames.has(hostname)) {
      throw new DomainError("host_not_allowed", "The request Host authority is not allowed", 403);
    }
    const origin = request.headers.origin;
    if (origin === undefined) return;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new DomainError("invalid_origin", "The request Origin is invalid", 403);
    }
    const expectedProtocolValue = request.headers["x-forwarded-proto"];
    const expectedProtocol =
      typeof expectedProtocolValue === "string"
        ? `${expectedProtocolValue}:`
        : request.protocol === "https"
          ? "https:"
          : "http:";
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.protocol !== expectedProtocol ||
      parsed.host.toLowerCase() !== hostValue.toLowerCase()
    ) {
      throw new DomainError("origin_not_allowed", "The request Origin is not same-origin", 403);
    }
  }
}
