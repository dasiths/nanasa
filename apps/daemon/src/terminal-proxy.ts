import type { IncomingHttpHeaders } from "node:http";
import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import { DomainError } from "./store.js";
import { TerminalEndpointRegistry } from "./terminal-endpoint-registry.js";

interface TerminalRouteParameters {
  endpointKey: string;
}

const publicHostPattern = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?$/;

function terminalPath(request: FastifyRequest<{ Params: TerminalRouteParameters }>): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function validateRoute(request: FastifyRequest<{ Params: TerminalRouteParameters }>): void {
  const { endpointKey } = request.params;
  const basePath = `/terminals/${endpointKey}`;
  const path = terminalPath(request);
  if (![basePath, `${basePath}/`, `${basePath}/token`, `${basePath}/ws`].includes(path)) {
    throw new DomainError("terminal_route_not_found", "Terminal route not found", 404);
  }
  if (request.method === "HEAD" && path !== `${basePath}/`) {
    throw new DomainError("terminal_route_not_found", "Terminal route not found", 404);
  }
  const isUpgrade = request.headers.upgrade?.toLowerCase() === "websocket";
  if (path === `${basePath}/ws` && !isUpgrade) {
    throw new DomainError("terminal_route_not_found", "Terminal route not found", 404);
  }
}

function validateWebSocketProtocol(
  request: FastifyRequest<{ Params: TerminalRouteParameters }>,
): void {
  const protocols = request.headers["sec-websocket-protocol"]
    ?.split(",")
    .map((protocol) => protocol.trim());
  if (protocols?.includes("tty") !== true) {
    throw new DomainError(
      "terminal_protocol_required",
      "The tty WebSocket protocol is required",
      400,
    );
  }
}

function publicAuthority(
  request: FastifyRequest<{ Params: TerminalRouteParameters }>,
  requireOrigin: boolean,
): { host: string; origin?: string } {
  const host = request.headers.host;
  if (host === undefined || !publicHostPattern.test(host)) {
    throw new DomainError("invalid_terminal_host", "Terminal request host is invalid", 400);
  }
  const origin = request.headers.origin;
  if (origin === undefined) {
    if (requireOrigin) {
      throw new DomainError(
        "terminal_origin_required",
        "Terminal WebSocket origin is required",
        403,
      );
    }
    return { host };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new DomainError("invalid_terminal_origin", "Terminal request origin is invalid", 403);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.host !== host) {
    throw new DomainError(
      "terminal_origin_mismatch",
      "Terminal request origin is not same-origin",
      403,
    );
  }
  return { host, origin: parsed.origin };
}

function requireReadyEndpoint(
  registry: TerminalEndpointRegistry,
  request: FastifyRequest<{ Params: TerminalRouteParameters }>,
  reply: FastifyReply,
): void {
  validateRoute(request);
  publicAuthority(request, request.headers.upgrade?.toLowerCase() === "websocket");
  const status = registry.statusByKey(request.params.endpointKey);
  if (status.state === "ready") {
    registry.resolve(request.params.endpointKey);
    return;
  }
  if (status.state === "stopped") {
    throw new DomainError("terminal_endpoint_inactive", "Terminal endpoint is inactive", 409);
  }
  if (status.retryAfterMs !== undefined) {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(status.retryAfterMs / 1_000))));
  }
  throw new DomainError(
    "terminal_endpoint_unavailable",
    `Terminal endpoint is ${status.state}`,
    503,
  );
}

function forwardedHeaders(
  request: FastifyRequest<{ Params: TerminalRouteParameters }>,
  headers: IncomingHttpHeaders,
): IncomingHttpHeaders {
  const authority = publicAuthority(
    request,
    request.headers.upgrade?.toLowerCase() === "websocket",
  );
  const forwarded = { ...headers };
  for (const name of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]) {
    delete forwarded[name];
  }
  forwarded.host = authority.host;
  if (authority.origin !== undefined) {
    forwarded.origin = authority.origin;
  } else {
    delete forwarded.origin;
  }
  return forwarded;
}

function rawDataBytes(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function forwardedCloseCode(code: number): number {
  return code >= 1_000 && code <= 4_999 && ![1_004, 1_005, 1_006, 1_015].includes(code)
    ? code
    : 1_000;
}

function proxyTerminalWebSocket(
  socket: WebSocket,
  request: FastifyRequest<{ Params: TerminalRouteParameters }>,
  registry: TerminalEndpointRegistry,
): void {
  const endpoint = registry.resolve(request.params.endpointKey);
  const releaseWriter = registry.beginWriter(endpoint.runId, endpoint.generation);
  const authority = publicAuthority(request, true);
  const upstreamUrl = new URL(request.url, endpoint.upstream);
  upstreamUrl.protocol = "ws:";
  const upstream = new WebSocket(upstreamUrl, "tty", {
    headers: {
      host: authority.host,
      origin: authority.origin as string,
    },
  });
  const pending: Array<{ data: RawData; binary: boolean }> = [];
  let pendingBytes = 0;
  let closed = false;

  const close = (code = 1011, reason = "Terminal proxy closed") => {
    if (closed) {
      return;
    }
    closed = true;
    releaseWriter();
    const safeCode = forwardedCloseCode(code);
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(safeCode, reason);
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(safeCode, reason);
    }
  };

  socket.on("message", (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary });
      return;
    }
    pendingBytes += rawDataBytes(data);
    if (pendingBytes > 65_536) {
      close(1009, "Terminal startup input exceeded the buffer limit");
      return;
    }
    pending.push({ data, binary });
  });
  socket.on("close", (code, reason) => close(code, reason.toString()));
  socket.on("error", () => close());
  upstream.on("open", () => {
    for (const message of pending.splice(0)) {
      upstream.send(message.data, { binary: message.binary });
    }
    pendingBytes = 0;
  });
  upstream.on("message", (data, binary) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data, { binary });
    }
  });
  upstream.on("close", (code, reason) => close(code, reason.toString()));
  upstream.on("error", () => close());
}

export async function registerTerminalProxy(
  app: FastifyInstance,
  registry: TerminalEndpointRegistry,
): Promise<void> {
  await app.register(httpProxy, {
    upstream: "",
    prefix: "/terminals/:endpointKey",
    rewritePrefix: "/terminals/:endpointKey",
    routes: ["/", "/token"],
    httpMethods: ["GET", "HEAD"],
    websocket: false,
    preHandler(request, reply, done) {
      try {
        requireReadyEndpoint(
          registry,
          request as FastifyRequest<{ Params: TerminalRouteParameters }>,
          reply,
        );
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    replyOptions: {
      getUpstream(request) {
        const parameters = request.params as TerminalRouteParameters;
        return registry.resolve(parameters.endpointKey).upstream;
      },
      rewriteRequestHeaders(request, headers) {
        return forwardedHeaders(
          request as FastifyRequest<{ Params: TerminalRouteParameters }>,
          headers,
        );
      },
    },
  });

  app.get<{ Params: TerminalRouteParameters }>(
    "/terminals/:endpointKey/ws",
    {
      websocket: true,
      preValidation(request, reply, done) {
        try {
          validateWebSocketProtocol(request);
          requireReadyEndpoint(registry, request, reply);
          done();
        } catch (error) {
          done(error as Error);
        }
      },
    },
    (socket, request) => proxyTerminalWebSocket(socket, request, registry),
  );
}
