import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemon } from "../src/server.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-api-"));
  temporaryDirectories.push(directory);
  return join(directory, "nanasa.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("daemon REST API", () => {
  it("renames and removes groups and memberships while preserving profiles", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({
        method: "POST",
        url: "/api/groups",
        payload: { name: "Original group" },
      })
    ).json<{ id: string }>();
    const profile = (
      await daemon.app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { name: "Reusable", agentType: "copilot" },
      })
    ).json<{ id: string }>();
    await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/memberships`,
      payload: { memberId: "reviewer", agentProfileId: profile.id, alias: "Original alias" },
    });

    const renamedGroup = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}`,
      headers: { "idempotency-key": "rename-group" },
      payload: { name: "Renamed group" },
    });
    expect(renamedGroup.statusCode).toBe(200);
    expect(renamedGroup.json()).toMatchObject({
      id: group.id,
      name: "Renamed group",
      membershipRevision: 1,
    });
    const renamedMembership = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}/memberships/reviewer`,
      headers: { "idempotency-key": "rename-member" },
      payload: { alias: "Renamed alias" },
    });
    expect(renamedMembership.statusCode).toBe(200);
    expect(renamedMembership.json()).toMatchObject({
      memberId: "reviewer",
      alias: "Renamed alias",
    });

    const removedMembership = await daemon.app.inject({
      method: "DELETE",
      url: `/api/groups/${group.id}/memberships/reviewer`,
      headers: { "idempotency-key": "remove-member" },
    });
    expect(removedMembership.statusCode).toBe(200);
    expect(removedMembership.json()).toMatchObject({ memberId: "reviewer", state: "removed" });
    expect(daemon.store.getSnapshot()).toMatchObject({
      groups: [{ id: group.id, membershipRevision: 2 }],
      agentProfiles: [{ id: profile.id }],
      memberships: [],
      runs: [],
    });

    const deleted = await daemon.app.inject({
      method: "DELETE",
      url: `/api/groups/${group.id}`,
      headers: { "idempotency-key": "delete-group" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      groupId: group.id,
      deletedMemberships: 1,
      deletedRuns: 0,
      deletedMessages: 0,
      deletedDeliveries: 0,
    });
    expect(
      (
        await daemon.app.inject({
          method: "DELETE",
          url: `/api/groups/${group.id}`,
          headers: { "idempotency-key": "delete-group" },
        })
      ).json(),
    ).toEqual(deleted.json());
    expect(daemon.store.getSnapshot()).toMatchObject({
      groups: [],
      memberships: [],
      agentProfiles: [{ id: profile.id }],
    });
    await daemon.app.close();
  });

  it("exposes group Start All with validated idempotency outcomes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const startAll = vi.spyOn(daemon.coordinator, "startAll").mockResolvedValue({
      groupId: "group-one",
      outcomes: [
        {
          groupId: "group-one",
          memberId: "alpha",
          status: "already-running",
          runId: "run-alpha",
        },
      ],
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/api/groups/group-one/runs/start-all",
      headers: { "idempotency-key": "start-team" },
      payload: { cols: 100, rows: 30 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      groupId: "group-one",
      outcomes: [{ memberId: "alpha", status: "already-running" }],
    });
    expect(startAll).toHaveBeenCalledWith("group-one", { cols: 100, rows: 30 }, "start-team");
    await daemon.app.close();
  });

  it("removes semantic routes and keeps interrupt as a terminal lifecycle command", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const interrupt = vi.spyOn(daemon.coordinator, "interrupt").mockResolvedValue(undefined);

    expect(
      (await daemon.app.inject({ method: "GET", url: "/api/runs/run-one/adapter" })).statusCode,
    ).toBe(404);
    expect(
      (
        await daemon.app.inject({
          method: "POST",
          url: "/api/groups/group-one/delivery-modes",
          payload: { memberIds: ["member-one"] },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await daemon.app.inject({
          method: "POST",
          url: "/api/runs/run-one/interrupt",
          payload: { operatorId: "operator", reason: "Stop current work" },
        })
      ).statusCode,
    ).toBe(204);
    expect(interrupt).toHaveBeenCalledWith("run-one");
    await daemon.app.close();
  });

  it("supports idempotent operator commands and restores their results after restart", async () => {
    const dataPath = temporaryDatabase();
    const first = await createDaemon({ dataPath });

    expect((await first.app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      status: "ok",
    });
    const createGroup = {
      method: "POST" as const,
      url: "/api/groups",
      headers: { "idempotency-key": "create-review-group" },
      payload: { name: "Review group" },
    };
    const groupResponse = await first.app.inject(createGroup);
    const replayedGroupResponse = await first.app.inject(createGroup);
    expect(groupResponse.statusCode).toBe(201);
    expect(replayedGroupResponse.json()).toEqual(groupResponse.json());
    const group = groupResponse.json<{ id: string }>();

    const profileResponse = await first.app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: {
        name: "Reviewer",
        agentType: "copilot",
      },
    });
    expect(profileResponse.statusCode).toBe(201);
    const profile = profileResponse.json<{ id: string; command: string }>();
    expect(profile).toMatchObject({ command: "copilot" });
    expect(profile).not.toHaveProperty("adapter");

    for (const memberId of ["reviewer", "tester"]) {
      const membershipResponse = await first.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/memberships`,
        payload: { memberId, agentProfileId: profile.id, alias: memberId },
      });
      expect(membershipResponse.statusCode).toBe(201);
    }

    const messageResponse = await first.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/messages`,
      headers: { "idempotency-key": "broadcast-review" },
      payload: {
        intent: "request",
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "group", membershipRevision: 2 },
        body: { contentType: "text/markdown", text: "Review this API." },
        delivery: { mode: "steer" },
        hop: 0,
      },
    });
    expect(messageResponse.statusCode).toBe(201);
    const submission = messageResponse.json<{
      message: { id: string };
      deliveryOutcomes: unknown[];
    }>();
    expect(submission.deliveryOutcomes).toHaveLength(2);

    const deliveriesResponse = await first.app.inject({
      method: "GET",
      url: `/api/messages/${submission.message.id}/deliveries`,
    });
    expect(deliveriesResponse.json()).toEqual(submission.deliveryOutcomes);
    await first.app.close();

    const reopened = await createDaemon({ dataPath });
    const snapshot = (await reopened.app.inject({ method: "GET", url: "/api/snapshot" })).json<{
      groups: unknown[];
      memberships: unknown[];
      messages: unknown[];
      deliveryOutcomes: unknown[];
    }>();
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.memberships).toHaveLength(2);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.deliveryOutcomes).toHaveLength(2);
    expect(snapshot).toMatchObject({
      config: { version: 1, agentTypes: { copilot: { command: ["copilot"] } } },
      configStatus: { state: "ready" },
    });
    expect(snapshot.config.agentTypes.copilot).not.toHaveProperty("adapter");
    await reopened.app.close();
  });

  it("exposes config status and rejects unconfigured or arbitrary profile launch data", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const config = await daemon.app.inject({ method: "GET", url: "/api/config" });
    const status = await daemon.app.inject({ method: "GET", url: "/api/config/status" });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      version: 1,
      agentTypes: {
        "claude-copilot": { command: ["make", "claude-copilot"] },
      },
    });
    expect(status.json()).toMatchObject({ state: "ready", revision: expect.any(String) });

    const unknown = await daemon.app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { name: "Unknown", agentType: "not-configured" },
    });
    expect(unknown.statusCode).toBe(400);
    const arbitrary = await daemon.app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { name: "Unsafe", agentType: "copilot", command: "sh" },
    });
    expect(arbitrary.statusCode).toBe(400);
    await daemon.app.close();
  });

  it("returns policy and validation failures without accepting state", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Team" } })
    ).json<{ id: string }>();

    const invalidProfile = await daemon.app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { name: "", kind: "unknown", command: "" },
    });
    expect(invalidProfile.statusCode).toBe(400);

    const staleBroadcast = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/messages`,
      payload: {
        intent: "request",
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "group", membershipRevision: 1 },
        body: { contentType: "text/plain", text: "No recipients." },
        delivery: { mode: "queue" },
      },
    });
    expect(staleBroadcast.statusCode).toBe(409);

    const unauthorizedControl = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/messages`,
      payload: {
        intent: "control",
        sender: { kind: "agent", memberId: "missing", runId: "missing" },
        audience: { kind: "dm", memberId: "missing" },
        body: { contentType: "text/plain", text: "Stop." },
        delivery: { mode: "queue" },
      },
    });
    expect(unauthorizedControl.statusCode).toBe(400);
    expect(daemon.store.getSnapshot().messages).toHaveLength(0);
    await daemon.app.close();
  });
});

describe("portal static assets", () => {
  it("serves the portal and SPA routes without masking assets or API 404s", async () => {
    const portalAssetsPath = mkdtempSync(join(tmpdir(), "nanasa-portal-"));
    temporaryDirectories.push(portalAssetsPath);
    mkdirSync(join(portalAssetsPath, "assets"));
    writeFileSync(
      join(portalAssetsPath, "index.html"),
      '<!doctype html><html><body><div id="root">Nanasa</div></body></html>',
    );
    writeFileSync(join(portalAssetsPath, "assets", "portal.js"), "globalThis.NANASA = true;\n");
    const daemon = await createDaemon({
      dataPath: ":memory:",
      servePortal: true,
      portalAssetsPath,
    });

    const index = await daemon.app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain('<div id="root">Nanasa</div>');

    const asset = await daemon.app.inject({ method: "GET", url: "/assets/portal.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.body).toContain("globalThis.NANASA");

    const spaRoute = await daemon.app.inject({
      method: "GET",
      url: "/groups/reviewers",
      headers: { accept: "text/html" },
    });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toBe(index.body);

    const missingAsset = await daemon.app.inject({
      method: "GET",
      url: "/assets/missing.js",
      headers: { accept: "text/html" },
    });
    expect(missingAsset.statusCode).toBe(404);
    expect((await daemon.app.inject({ method: "GET", url: "/api/missing" })).statusCode).toBe(404);
    expect((await daemon.app.inject({ method: "GET", url: "/api/terminal" })).statusCode).toBe(404);
    expect((await daemon.app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      status: "ok",
    });

    daemon.store.createGroup({ name: "Static route WebSocket check" });
    let resolveEvent: (value: string) => void = () => undefined;
    const eventFrame = new Promise<string>((resolve) => {
      resolveEvent = resolve;
    });
    const eventSocket = await daemon.app.injectWS(
      "/api/events?after=0",
      {},
      {
        onInit(client) {
          client.once("message", (data) => resolveEvent(data.toString()));
        },
      },
    );
    expect(JSON.parse(await eventFrame)).toMatchObject({ type: "group.created" });
    eventSocket.terminate();

    await daemon.app.close();
  });

  it("requires a portal asset path when static serving is enabled", async () => {
    await expect(createDaemon({ dataPath: ":memory:", servePortal: true })).rejects.toThrow(
      "portalAssetsPath is required",
    );
  });
});

describe("domain event WebSocket", () => {
  it("replays after a sequence and continues with committed events", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    daemon.store.createGroup({ name: "First" });
    daemon.store.createAgentProfile({
      name: "Reviewer",
      agentType: "copilot",
    });

    let resolveReplay: (value: string) => void = () => undefined;
    const replay = new Promise<string>((resolve) => {
      resolveReplay = resolve;
    });
    const socket = await daemon.app.injectWS(
      "/api/events?after=1",
      {},
      {
        onInit(client) {
          client.once("message", (data) => resolveReplay(data.toString()));
        },
      },
    );
    expect(JSON.parse(await replay)).toMatchObject({
      sequence: 2,
      type: "agent-profile.created",
    });

    const live = new Promise<string>((resolve) => {
      socket.once("message", (data) => resolve(data.toString()));
    });
    daemon.store.createGroup({ name: "Second" });
    expect(JSON.parse(await live)).toMatchObject({ sequence: 3, type: "group.created" });

    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.terminate();
    });
    await daemon.app.close();
  });
});
