import { randomUUID } from "node:crypto";
import { BrowserUrlSchema, type UrlOpenRequest, UrlOpenRequestSchema } from "@nanasa/contracts";
import type { McpAgentPrincipal } from "./mcp-auth.js";
import { DomainError, type NanasaStore } from "./store.js";

export class UrlOpenService {
  public constructor(private readonly store: NanasaStore) {}

  public list(now = Date.now()): UrlOpenRequest[] {
    this.store.database
      .prepare("DELETE FROM url_open_requests WHERE expires_at <= ?")
      .run(new Date(now).toISOString());
    const rows = this.store.database
      .prepare("SELECT id, request_json FROM url_open_requests")
      .all() as Array<{ id: string; request_json: string }>;
    const requests: UrlOpenRequest[] = [];
    for (const row of rows) {
      const request = UrlOpenRequestSchema.parse(JSON.parse(row.request_json));
      if (this.active(request)) requests.push(request);
      else this.store.database.prepare("DELETE FROM url_open_requests WHERE id = ?").run(row.id);
    }
    return requests.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  public get(id: string): UrlOpenRequest {
    const request = this.list().find((candidate) => candidate.id === id);
    if (request === undefined) {
      throw new DomainError("url_request_expired", "URL request is no longer available", 410);
    }
    return request;
  }

  public create(principal: McpAgentPrincipal, value: string): UrlOpenRequest {
    const parsed = BrowserUrlSchema.safeParse(value);
    if (!parsed.success) throw new DomainError("invalid_browser_url", "Invalid browser URL", 400);
    if (!this.active({ ...principal })) {
      throw new DomainError(
        "url_request_run_inactive",
        "The requesting run is no longer active",
        403,
      );
    }
    const now = Date.now();
    const pending = this.list(now);
    const duplicate = pending.find(
      (request) => request.runId === principal.runId && request.url === parsed.data,
    );
    if (duplicate !== undefined) return duplicate;
    if (
      pending.length >= 500 ||
      pending.filter((request) => request.runId === principal.runId).length >= 10
    ) {
      throw new DomainError("url_request_rate_limited", "Too many pending browser requests", 429);
    }
    const request = UrlOpenRequestSchema.parse({
      id: `url-open-${randomUUID()}`,
      groupId: principal.groupId,
      memberId: principal.memberId,
      runId: principal.runId,
      generation: principal.generation,
      url: parsed.data,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
    });
    this.store.database
      .prepare("INSERT INTO url_open_requests (id, request_json, expires_at) VALUES (?, ?, ?)")
      .run(request.id, JSON.stringify(request), request.expiresAt);
    this.store.recordRuntimeEvent("url-open.requested", "run", request.runId, {
      requestId: request.id,
      groupId: request.groupId,
      memberId: request.memberId,
      runId: request.runId,
      generation: request.generation,
    });
    return request;
  }

  private active(
    request: Pick<UrlOpenRequest, "runId" | "generation" | "groupId" | "memberId">,
  ): boolean {
    try {
      const run = this.store.getRun(request.runId);
      return (
        run.generation === request.generation &&
        run.groupId === request.groupId &&
        run.memberId === request.memberId &&
        run.desiredState === "running" &&
        ["starting", "running"].includes(run.status) &&
        this.store.getActiveRun(run.groupId, run.memberId)?.id === run.id &&
        this.store
          .listActiveMemberships(run.groupId)
          .some((member) => member.memberId === run.memberId)
      );
    } catch {
      return false;
    }
  }
}
