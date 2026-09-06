import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CustomLaunchConsentDecisionResult,
  type CustomLaunchConsentRequest,
  type GroupMembership,
  MAX_MESSAGE_TEXT_BYTES,
  type StartAgentRunResult,
} from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadNanasaConfig } from "../src/config-loader.js";
import { createDaemon as createDaemonBase, type DaemonOptions } from "../src/server.js";

const temporaryDirectories: string[] = [];
const repositoryByDataPath = new Map<string, string>();
const providerDigest = (character: string): string => character.repeat(64);

async function createDaemon(options: DaemonOptions = {}) {
  const key = options.dataPath ?? `memory-${temporaryDirectories.length}`;
  let repository = repositoryByDataPath.get(key);
  if (repository === undefined) {
    repository = mkdtempSync(join(tmpdir(), "nanasa-api-config-"));
    temporaryDirectories.push(repository);
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Nanasa Test",
        "-c",
        "user.email=nanasa@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { stdio: "ignore" },
    );
    mkdirSync(join(repository, ".nanasa"));
    mkdirSync(join(repository, ".nanasa", "instructions"));
    writeFileSync(
      join(repository, ".nanasa", "instructions", "group.md"),
      "# Group instructions\n",
    );
    writeFileSync(
      join(repository, ".nanasa", "instructions", "profile.md"),
      "# Profile instructions\n",
    );
    writeFileSync(
      join(repository, ".nanasa", "instructions", "membership.md"),
      "# Membership instructions\n",
    );
    writeFileSync(
      join(repository, ".nanasa", "config.yaml"),
      `version: 2
integrations:
  copilot:
    name: GitHub Copilot
    kind: copilot
    command: [copilot]
    cwd: .
    providerState: { scope: integration }
  claude-copilot:
    name: Claude Code via Copilot
    kind: claude-code
    command: [make, claude-copilot]
    cwd: .
    providerState: { scope: integration }
roles:
  reviewer:
    name: Reviewer
    permissionPolicy: read-only
groups: {}
messages: { retentionPerGroup: 1000 }
`,
    );
    repositoryByDataPath.set(key, repository);
  }
  const daemon = await createDaemonBase({ ...options, loadedConfig: loadNanasaConfig(repository) });
  const rawInject = daemon.app.inject.bind(daemon.app);
  const bootstrapToken = daemon.bootstrapFragment.slice("nanasa-bootstrap=".length);
  const bootstrap = await rawInject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    payload: { token: bootstrapToken },
  });
  const cookie = bootstrap.headers["set-cookie"]?.split(";", 1)[0];
  const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken;
  const authenticatedInject = ((optionsOrUrl: Parameters<typeof rawInject>[0]) => {
    if (typeof optionsOrUrl === "string") {
      const url =
        optionsOrUrl.startsWith("/api/") && !optionsOrUrl.startsWith("/api/v1/")
          ? optionsOrUrl.replace("/api/", "/api/v1/")
          : optionsOrUrl;
      return rawInject({
        method: "GET",
        url,
        headers: cookie === undefined ? {} : { cookie },
      });
    }
    const url =
      optionsOrUrl.url.startsWith("/api/") && !optionsOrUrl.url.startsWith("/api/v1/")
        ? optionsOrUrl.url.replace("/api/", "/api/v1/")
        : optionsOrUrl.url;
    return rawInject({
      ...optionsOrUrl,
      url,
      headers: {
        ...optionsOrUrl.headers,
        ...(cookie === undefined ? {} : { cookie }),
        "x-nanasa-csrf": csrfToken,
      },
    });
  }) as typeof daemon.app.inject;
  daemon.app.inject = authenticatedInject;
  const rawInjectWs = daemon.app.injectWS.bind(daemon.app);
  daemon.app.injectWS = ((path, headers, options) =>
    rawInjectWs(
      path.startsWith("/api/") && !path.startsWith("/api/v1/")
        ? path.replace("/api/", "/api/v1/")
        : path,
      {
        ...headers,
        headers: {
          ...((headers as { headers?: Record<string, string> }).headers ?? {}),
          host: "localhost",
          origin: "http://localhost",
          ...(cookie === undefined ? {} : { cookie }),
        },
      },
      options,
    )) as typeof daemon.app.injectWS;
  return daemon;
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-api-"));
  temporaryDirectories.push(directory);
  return join(directory, "nanasa.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  repositoryByDataPath.clear();
});

describe("daemon REST API", () => {
  it("exposes Git references and explicit fetch through checkout routes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    try {
      const source = daemon.store.listCheckouts()[0]!;
      execFileSync("git", ["-C", source.path, "branch", "feature/suggestions"]);
      const references = await daemon.app.inject(`/api/v1/checkouts/${source.id}/references`);
      expect(references.statusCode).toBe(200);
      expect(references.json()).toContainEqual({ name: "feature/suggestions", kind: "branch" });
      const fetched = await daemon.app.inject({
        method: "POST",
        url: `/api/v1/checkouts/${source.id}/fetch`,
        payload: {},
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toContainEqual(expect.objectContaining({ checkoutId: source.id }));
      expect((await daemon.app.inject("/api/v1/checkouts/missing/references")).statusCode).toBe(
        404,
      );
      expect(
        (
          await daemon.app.inject({
            method: "POST",
            url: "/api/v1/checkouts/missing/fetch",
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await daemon.app.close();
    }
  });

  it("round-trips durable Attention dismissals through authenticated routes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const dismissed = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/attention-dismissals",
      payload: { itemIds: ["attention:health|run:1"] },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toEqual({
      dismissals: [expect.objectContaining({ itemId: "attention:health|run:1" })],
    });

    const listed = await daemon.app.inject("/api/v1/attention-dismissals");
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(dismissed.json());
    await daemon.app.close();
  });

  it("sets and resets effective Attention subscriptions through authenticated routes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Team" } })
    ).json<{ id: string }>();
    const member = (
      await daemon.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/agents`,
        payload: { name: "Builder", integrationId: "copilot" },
      })
    ).json<{ memberId: string }>();

    const updated = await daemon.app.inject({
      method: "PUT",
      url: `/api/v1/groups/${group.id}/members/${member.memberId}/attention-subscriptions/completion`,
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      groupId: group.id,
      memberId: member.memberId,
      subscriptions: expect.arrayContaining([
        { eventType: "completion", enabled: false, source: "operator-override" },
      ]),
    });

    const listed = await daemon.app.inject("/api/v1/attention-subscriptions");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().members).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: member.memberId })]),
    );

    const reset = await daemon.app.inject({
      method: "DELETE",
      url: `/api/v1/groups/${group.id}/members/${member.memberId}/attention-subscriptions`,
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().subscriptions).toEqual(
      expect.arrayContaining([
        { eventType: "completion", enabled: true, source: "repository-default" },
      ]),
    );
    await daemon.app.close();
  });

  it("discovers checkouts and manages provenance-fenced worktrees through routes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const snapshot = (await daemon.app.inject({ method: "GET", url: "/api/snapshot" })).json<{
      repositories: Array<{ id: string; primaryCheckoutId: string }>;
      checkouts: Array<{ id: string; repositoryId: string; kind: string }>;
    }>();
    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.checkouts).toEqual([
      expect.objectContaining({
        id: snapshot.repositories[0]!.primaryCheckoutId,
        repositoryId: snapshot.repositories[0]!.id,
        kind: "primary",
      }),
    ]);
    const created = await daemon.app.inject({
      method: "POST",
      url: "/api/worktrees",
      payload: {
        sourceCheckoutId: snapshot.checkouts[0]!.id,
        branch: "feature/api-worktree",
      },
    });
    expect(created.statusCode).toBe(201);
    const result = created.json<{
      worktree: { id: string; operationGeneration: number; state: string };
      checkout: { kind: string };
    }>();
    expect(result).toMatchObject({ worktree: { state: "ready" }, checkout: { kind: "linked" } });
    const removed = await daemon.app.inject({
      method: "DELETE",
      url: `/api/worktrees/${result.worktree.id}`,
      payload: {
        force: false,
        expectedOperationGeneration: result.worktree.operationGeneration,
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ worktree: { state: "removed" } });
    await daemon.app.close();
  });

  it("projects direct roles and requires restart for launch or prompt changes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({
        method: "POST",
        url: "/api/groups",
        payload: {
          name: "Team",
          instructions: [".nanasa/instructions/group.md"],
        },
      })
    ).json<{ id: string }>();
    const added = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/agents`,
      payload: {
        name: "Reviewer",
        integrationId: "copilot",
        roleId: "reviewer",
        instructions: [".nanasa/instructions/profile.md", ".nanasa/instructions/membership.md"],
      },
    });
    expect(added.statusCode).toBe(201);
    const agent = added.json<{ id: string; memberId: string }>();
    expect(agent).toMatchObject({ id: expect.any(String), roleId: "reviewer" });
    const configured = (await daemon.app.inject({ method: "GET", url: "/api/config" })).json<{
      groups: Record<
        string,
        {
          instructions: string[];
          agents: Record<
            string,
            { roleId?: string; integrationId: string; name: string; instructions: string[] }
          >;
        }
      >;
    }>();
    expect(configured.groups[group.id]).toMatchObject({
      instructions: [".nanasa/instructions/group.md"],
    });
    expect(configured.groups[group.id]!.agents[agent.id]).toMatchObject({
      name: "Reviewer",
      integrationId: "copilot",
      roleId: "reviewer",
      instructions: [".nanasa/instructions/profile.md", ".nanasa/instructions/membership.md"],
    });

    daemon.store.createRunForMembership(group.id, agent.memberId);
    const renamedAgent = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}/agents/${agent.id}`,
      payload: { name: "Renamed reviewer" },
    });
    expect(renamedAgent.statusCode).toBe(200);
    const renamedGroup = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}`,
      payload: { name: "Renamed team" },
    });
    expect(renamedGroup.statusCode).toBe(200);
    for (const payload of [
      { roleId: null },
      { integrationId: "claude-copilot" },
      { instructions: [] },
    ]) {
      const changed = await daemon.app.inject({
        method: "PATCH",
        url: `/api/groups/${group.id}/agents/${agent.id}`,
        payload,
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: "active_run_agent_change_requires_restart" });
    }
    const groupChanged = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}`,
      payload: { instructions: [] },
    });
    expect(groupChanged.statusCode).toBe(409);
    expect(groupChanged.json()).toMatchObject({
      code: "active_run_group_change_requires_restart",
    });
    await daemon.app.close();
  });

  it("updates role presentation and atomically persists agent order", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Team" } })
    ).json<{ id: string }>();
    const agents = new Map<string, { id: string; memberId: string }>();
    for (const name of ["builder", "reviewer", "tester"]) {
      const response = await daemon.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/agents`,
        payload: { name, integrationId: "copilot" },
      });
      expect(response.statusCode).toBe(201);
      agents.set(name, response.json<{ id: string; memberId: string }>());
    }
    daemon.store.createRunForMembership(group.id, agents.get("builder")!.memberId);

    const presentation = await daemon.app.inject({
      method: "PATCH",
      url: "/api/roles/reviewer/presentation",
      payload: { icon: "shield-check", color: "amber", shortName: "Review" },
    });
    expect(presentation.statusCode).toBe(200);
    expect(presentation.json()).toMatchObject({
      name: "Reviewer",
      presentation: { icon: "shield-check", color: "amber", shortName: "Review" },
    });

    const agentIds = ["tester", "builder", "reviewer"].map((name) => agents.get(name)!.id);
    const reordered = await daemon.app.inject({
      method: "PUT",
      url: `/api/groups/${group.id}/agent-order`,
      payload: { agentIds, expectedOrderRevision: 4 },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json()).toEqual({ groupId: group.id, agentIds, orderRevision: 5 });
    expect(daemon.store.getSnapshot()).toMatchObject({
      groups: [{ id: group.id, membershipRevision: 3 }],
      memberships: [
        { id: agents.get("tester")!.id },
        { id: agents.get("builder")!.id },
        { id: agents.get("reviewer")!.id },
      ],
    });

    const repository = repositoryByDataPath.get(":memory:") as string;
    const persisted = loadNanasaConfig(repository).config;
    expect(persisted.roles.reviewer?.presentation).toEqual({
      icon: "shield-check",
      color: "amber",
      shortName: "Review",
    });
    expect(
      Object.entries(persisted.groups[group.id]?.agents ?? {}).map(([id, item]) => [
        id,
        item.order,
      ]),
    ).toEqual(agentIds.map((id, order) => [id, order]));

    const stale = await daemon.app.inject({
      method: "PUT",
      url: `/api/groups/${group.id}/agent-order`,
      payload: { agentIds, expectedOrderRevision: 4 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "topology_order_stale" });
    await daemon.app.close();
  });

  it("renames and removes direct agents without exposing orphan profiles", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({
        method: "POST",
        url: "/api/groups",
        payload: { name: "Original group" },
      })
    ).json<{ id: string }>();
    const agent = (
      await daemon.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/agents`,
        payload: { name: "Original alias", integrationId: "copilot" },
      })
    ).json<{ id: string; memberId: string }>();

    const renamedGroup = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}`,
      payload: { name: "Renamed group" },
    });
    expect(renamedGroup.statusCode).toBe(200);
    expect(renamedGroup.json()).toMatchObject({
      id: group.id,
      name: "Renamed group",
      membershipRevision: 1,
    });
    const renamedAgent = await daemon.app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}/agents/${agent.id}`,
      payload: { name: "Renamed alias" },
    });
    expect(renamedAgent.statusCode).toBe(200);
    expect(renamedAgent.json()).toMatchObject({
      id: agent.id,
      memberId: agent.memberId,
      alias: "Renamed alias",
    });

    const removedAgent = await daemon.app.inject({
      method: "DELETE",
      url: `/api/groups/${group.id}/agents/${agent.id}`,
    });
    expect(removedAgent.statusCode).toBe(200);
    expect(removedAgent.json()).toEqual({
      groupId: group.id,
      agentId: agent.id,
      deletedRuns: 0,
      revokedDeliveries: 0,
    });
    expect(daemon.store.getSnapshot()).toMatchObject({
      groups: [{ id: group.id, membershipRevision: 2 }],
      agentProfiles: [],
      memberships: [],
      runs: [],
    });

    const deleted = await daemon.app.inject({
      method: "DELETE",
      url: `/api/groups/${group.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      groupId: group.id,
      deletedMemberships: 1,
      deletedRuns: 0,
      deletedMessages: 0,
      deletedDeliveries: 0,
    });
    expect(daemon.store.getSnapshot()).toMatchObject({
      groups: [],
      memberships: [],
      agentProfiles: [],
    });
    await daemon.app.close();
  });

  it("exposes group Start All without claiming idempotency for tmux effects", async () => {
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
      payload: { cols: 100, rows: 30 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      groupId: "group-one",
      outcomes: [{ memberId: "alpha", status: "already-running" }],
    });
    expect(startAll).toHaveBeenCalledWith("group-one", { cols: 100, rows: 30 });
    await daemon.app.close();
  });

  it("recovers group and single-agent runs through the provider update reconciler", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Team" } })
    ).json<{ id: string }>();
    const agent = (
      await daemon.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/agents`,
        payload: { name: "Engineer", integrationId: "copilot" },
      })
    ).json<{ id: string; memberId: string }>();
    const { run } = daemon.store.createRunForMembership(group.id, agent.memberId);
    const retained = {
      runId: run.id,
      generation: run.generation,
      memberId: run.memberId,
      providerId: "copilot",
      previousSnapshotDigest: providerDigest("a"),
      currentSnapshotDigest: providerDigest("a"),
      status: "retained" as const,
    };
    const recover = vi
      .spyOn(daemon.coordinator, "recoverProviderUpdates")
      .mockResolvedValue({ outcomes: [retained] });

    const groupResponse = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/runs/recover`,
      payload: { dryRun: true },
    });
    expect(groupResponse.statusCode).toBe(200);
    expect(groupResponse.json()).toMatchObject({
      groupId: group.id,
      dryRun: true,
      outcomes: [{ memberId: agent.memberId, status: "retained" }],
    });
    expect(recover).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ id: run.id, generation: run.generation })],
      { dryRun: true, forceIndeterminate: false },
    );

    const agentResponse = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/agents/${agent.id}/run/recover`,
      payload: { forceIndeterminate: false },
    });
    expect(agentResponse.statusCode).toBe(200);
    expect(agentResponse.json()).toMatchObject({ runId: run.id, status: "retained" });
    expect(recover).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ id: run.id, generation: run.generation })],
      { dryRun: false, forceIndeterminate: false },
    );

    const invalid = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/runs/recover`,
      payload: { dryRun: true, restartEverything: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "validation_error" });
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

  it("restores transactionally idempotent message outcomes after restart", async () => {
    const dataPath = temporaryDatabase();
    const first = await createDaemon({ dataPath });

    expect((await first.app.inject({ method: "GET", url: "/health" })).json()).toEqual({
      status: "ok",
    });
    const createGroup = {
      method: "POST" as const,
      url: "/api/groups",
      payload: { name: "Review group" },
    };
    const groupResponse = await first.app.inject(createGroup);
    expect(groupResponse.statusCode).toBe(201);
    const group = groupResponse.json<{ id: string }>();

    for (const name of ["reviewer", "tester"]) {
      const agentResponse = await first.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/agents`,
        payload: { name, integrationId: "copilot" },
      });
      expect(agentResponse.statusCode).toBe(201);
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
        delivery: {},
      },
    });
    expect(messageResponse.statusCode).toBe(201);
    const submission = messageResponse.json<{
      message: { id: string; sender: { kind: string; operatorId: string } };
      deliveryOutcomes: unknown[];
    }>();
    expect(submission.message.sender).toEqual({
      kind: "operator",
      operatorId: "operator-local-portal",
    });
    expect(submission.deliveryOutcomes).toHaveLength(2);
    const messageReplay = await first.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/messages`,
      headers: { "idempotency-key": "broadcast-review" },
      payload: {
        intent: "request",
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "group", membershipRevision: 2 },
        body: { contentType: "text/markdown", text: "Review this API." },
        delivery: {},
      },
    });
    expect(messageReplay.headers["idempotency-replayed"]).toBe("true");
    expect(messageReplay.json()).toEqual(messageResponse.json());

    const deliveriesResponse = await first.app.inject({
      method: "GET",
      url: `/api/messages/${submission.message.id}/deliveries`,
    });
    expect(deliveriesResponse.json()).toEqual(submission.deliveryOutcomes);
    await first.app.close();

    const reopened = await createDaemon({ dataPath });
    const restartReplay = await reopened.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/messages`,
      headers: { "idempotency-key": "broadcast-review" },
      payload: {
        intent: "request",
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "group", membershipRevision: 2 },
        body: { contentType: "text/markdown", text: "Review this API." },
        delivery: {},
      },
    });
    expect(restartReplay.statusCode).toBe(201);
    expect(restartReplay.headers["idempotency-replayed"]).toBe("true");
    expect(restartReplay.json()).toEqual(messageResponse.json());
    const snapshot = (await reopened.app.inject({ method: "GET", url: "/api/snapshot" })).json<{
      groups: unknown[];
      memberships: unknown[];
      messages: unknown[];
      deliveryOutcomes: unknown[];
    }>();
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.memberships).toHaveLength(2);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.deliveryOutcomes).toHaveLength(0);
    expect(snapshot.messageGroups).toEqual([
      expect.objectContaining({
        groupId: group.id,
        retainedMessageCount: 1,
        latestGroupSeq: 1,
      }),
    ]);
    expect(snapshot).toMatchObject({
      config: { integrations: { copilot: { command: ["copilot"] } } },
      configStatus: { state: "ready" },
    });
    expect(snapshot.config.integrations.copilot).not.toHaveProperty("adapter");
    await reopened.app.close();
  });

  it("centralizes digest, route, principal, concurrency, and failure idempotency semantics", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const request = {
      method: "POST" as const,
      url: "/api/v1/service/restart-plan",
      headers: { "idempotency-key": "central-plan" },
      payload: { reason: "upgrade" },
    };
    const first = await daemon.app.inject(request);
    const replay = await daemon.app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());

    const mismatch = await daemon.app.inject({
      ...request,
      payload: { reason: "rollback" },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: "idempotency_request_conflict" });

    const routeScoped = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/provider-states/missing/retain",
      headers: { "idempotency-key": "central-plan" },
      payload: {},
    });
    expect(routeScoped.statusCode).toBe(404);

    const credential = readFileSync(join(daemon.runtimePath, "operator-secret")).toString(
      "base64url",
    );
    const principalScoped = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/service/restart-plan",
      headers: {
        authorization: `Bearer ${credential}`,
        "idempotency-key": "central-plan",
      },
      payload: { reason: "upgrade" },
    });
    expect(principalScoped.statusCode).toBe(200);

    const concurrentRequest = {
      method: "POST" as const,
      url: "/api/v1/service/restart-plan",
      headers: { "idempotency-key": "concurrent-plan" },
      payload: { reason: "operator-restart" },
    };
    const concurrent = await Promise.all([
      daemon.app.inject(concurrentRequest),
      daemon.app.inject(concurrentRequest),
    ]);
    expect(concurrent.map((item) => item.statusCode)).toEqual([200, 200]);
    expect(
      concurrent.filter((item) => item.headers["idempotency-replayed"] === "true"),
    ).toHaveLength(1);

    const originalLifecycle = daemon.store.setProviderStateLifecycle.bind(daemon.store);
    vi.spyOn(daemon.store, "setProviderStateLifecycle")
      .mockImplementationOnce(() => {
        throw new Error("transient fault");
      })
      .mockImplementation(originalLifecycle);
    const failed = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/provider-states/missing/retain",
      headers: { "idempotency-key": "transient-retry" },
      payload: {},
    });
    expect(failed.statusCode).toBe(500);
    const replayedFailure = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/provider-states/missing/retain",
      headers: { "idempotency-key": "transient-retry" },
      payload: {},
    });
    expect(replayedFailure.statusCode).toBe(404);
    expect(replayedFailure.headers["idempotency-replayed"]).toBeUndefined();
    const providerStateTime = "2026-08-30T00:00:00.000Z";
    daemon.store.upsertProviderState({
      id: "missing",
      integrationId: "copilot",
      scope: "integration",
      storageReference: "/tmp/nanasa-provider-state",
      credentialReference: { kind: "provider-managed" },
      lifecycle: "active",
      createdAt: providerStateTime,
      updatedAt: providerStateTime,
    });
    const transientRetry = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/provider-states/missing/retain",
      headers: { "idempotency-key": "transient-retry" },
      payload: {},
    });
    expect(transientRetry.statusCode).toBe(200);
    expect(transientRetry.headers["idempotency-replayed"]).toBeUndefined();
    expect(transientRetry.json()).toMatchObject({ id: "missing", lifecycle: "retained" });

    const stableRequest = {
      method: "POST" as const,
      url: "/api/v1/service/restart-plan",
      headers: { "idempotency-key": "stable-validation" },
      payload: { reason: "not-a-reason" },
    };
    const stableFailure = await daemon.app.inject(stableRequest);
    const stableReplay = await daemon.app.inject(stableRequest);
    expect(stableFailure.statusCode).toBe(400);
    const stableFailurePayload = stableFailure.json();
    expect(Object.keys(stableFailurePayload).sort()).toEqual(["code", "details", "message"]);
    expect(stableFailurePayload).toMatchObject({
      message: "Request validation failed",
      details: { issues: expect.any(Array) },
      code: "validation_error",
    });
    expect(stableReplay.statusCode).toBe(400);
    expect(stableReplay.headers["idempotency-replayed"]).toBe("true");
    expect(stableReplay.json()).toEqual(stableFailure.json());
    await daemon.app.close();
  });

  it("enforces declared idempotency policy before state-changing handlers", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const required = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/agent-actions",
      payload: {
        kind: "prompt",
        groupId: "missing",
        memberId: "missing",
        prompt: "Must not reach domain validation",
      },
    });
    expect(required.statusCode).toBe(400);
    expect(required.json()).toMatchObject({ code: "idempotency_key_required" });

    const forbidden = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/auth/revoke",
      headers: { "idempotency-key": "unsupported-revoke-key" },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json()).toMatchObject({ code: "idempotency_not_supported" });
    const rawInterrupt = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/runs/missing/interrupt",
      headers: { "idempotency-key": "unsafe-effect" },
      payload: { operatorId: "operator", reason: "Stop" },
    });
    expect(rawInterrupt.statusCode).toBe(400);
    expect(rawInterrupt.json()).toMatchObject({ code: "idempotency_not_supported" });
    await daemon.app.close();
  });

  it("exposes config status and rejects unconfigured or arbitrary agent launch data", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const config = await daemon.app.inject({ method: "GET", url: "/api/config" });
    const status = await daemon.app.inject({ method: "GET", url: "/api/config/status" });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      integrations: {
        "claude-copilot": { command: ["make", "claude-copilot"] },
      },
    });
    expect(status.json()).toMatchObject({ state: "ready", revision: expect.any(String) });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Team" } })
    ).json<{ id: string }>();

    const unknown = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/agents`,
      payload: { name: "Unknown", integrationId: "not-configured" },
    });
    expect(unknown.statusCode).toBe(400);
    const arbitrary = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/agents`,
      payload: { name: "Unsafe", integrationId: "copilot", command: "sh" },
    });
    expect(arbitrary.statusCode).toBe(400);
    expect(
      (await daemon.app.inject({ method: "POST", url: "/api/agent-profiles" })).statusCode,
    ).toBe(404);
    await daemon.app.close();
  });

  it("returns policy and validation failures without accepting state", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Team" } })
    ).json<{ id: string }>();

    const invalidAgent = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/agents`,
      payload: { name: "", integrationId: "copilot" },
    });
    expect(invalidAgent.statusCode).toBe(400);

    const staleBroadcast = await daemon.app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/messages`,
      payload: {
        intent: "request",
        sender: { kind: "operator", operatorId: "operator_1" },
        audience: { kind: "group", membershipRevision: 1 },
        body: { contentType: "text/plain", text: "No recipients." },
        delivery: {},
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
        delivery: {},
      },
    });
    expect(unauthorizedControl.statusCode).toBe(400);
    expect(daemon.store.getSnapshot().messages).toHaveLength(0);
    await daemon.app.close();
  });
});

describe("custom launch consent operator API", () => {
  async function createPendingConsent(daemon: Awaited<ReturnType<typeof createDaemon>>) {
    const group = (
      await daemon.app.inject({
        method: "POST",
        url: "/api/v1/groups",
        payload: { name: "Consent Team" },
      })
    ).json<{ id: string }>();
    const membership = (
      await daemon.app.inject({
        method: "POST",
        url: `/api/v1/groups/${group.id}/agents`,
        payload: { name: "Consent Agent", integrationId: "copilot" },
      })
    ).json<GroupMembership>();
    const start = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/groups/${group.id}/agents/${membership.id}/run`,
      payload: { cols: 120, rows: 40 },
    });
    expect(start.statusCode).toBe(201);
    const result = start.json<StartAgentRunResult>();
    expect(result.status).toBe("approval-required");
    if (result.status !== "approval-required") throw new Error("Expected pending consent");
    return { group, membership, request: result.request };
  }

  function exact(request: CustomLaunchConsentRequest) {
    return {
      expectedSubjectDigest: request.subjectDigest,
      configRevision: request.configRevision,
    };
  }

  it("lists, inspects, approves, revokes, cancels, and denies without auto-starting", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const pending = await createPendingConsent(daemon);

    const listed = await daemon.app.inject({
      method: "GET",
      url: "/api/v1/launch-consents?state=pending",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<CustomLaunchConsentRequest[]>()).toEqual([
      expect.objectContaining({ id: pending.request.id, state: "pending" }),
    ]);
    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: `/api/v1/launch-consents/${pending.request.id}`,
        })
      ).json<CustomLaunchConsentRequest>(),
    ).toMatchObject({ id: pending.request.id, subjectDigest: pending.request.subjectDigest });

    const approval = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/launch-consents/${pending.request.id}/approve`,
      payload: exact(pending.request),
    });
    expect(approval.statusCode).toBe(200);
    const approved = approval.json<CustomLaunchConsentDecisionResult>();
    expect(approved).toMatchObject({
      request: { id: pending.request.id, state: "approved" },
      decision: { decision: "trusted", subjectDigest: pending.request.subjectDigest },
    });
    expect(daemon.store.getSnapshot().runs).toHaveLength(0);

    const revoked = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/trust/${approved.decision.id}/revoke`,
      payload: { expectedSubjectDigest: pending.request.subjectDigest },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ decision: "revoked" });

    const retry = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/groups/${pending.group.id}/agents/${pending.membership.id}/run`,
      payload: { cols: 120, rows: 40 },
    });
    const cancellable = retry.json<StartAgentRunResult>();
    expect(cancellable.status).toBe("approval-required");
    if (cancellable.status !== "approval-required") throw new Error("Expected replacement consent");
    const cancelled = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/launch-consents/${cancellable.request.id}/cancel`,
      payload: exact(cancellable.request),
    });
    expect(cancelled.json()).toMatchObject({ state: "cancelled" });

    const denyRetry = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/groups/${pending.group.id}/agents/${pending.membership.id}/run`,
      payload: { cols: 120, rows: 40 },
    });
    const deniable = denyRetry.json<StartAgentRunResult>();
    if (deniable.status !== "approval-required") throw new Error("Expected deniable consent");
    const denied = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/launch-consents/${deniable.request.id}/deny`,
      payload: exact(deniable.request),
    });
    expect(denied.json()).toMatchObject({
      request: { state: "denied" },
      decision: { decision: "denied" },
    });
    const deniedStart = (
      await daemon.app.inject({
        method: "POST",
        url: `/api/v1/groups/${pending.group.id}/agents/${pending.membership.id}/run`,
        payload: { cols: 120, rows: 40 },
      })
    ).json<StartAgentRunResult>();
    expect(deniedStart).toMatchObject({ status: "denied", request: { id: deniable.request.id } });

    const bounds = daemon.store.eventBounds();
    const consentEvents = daemon.store
      .listEventPage(0, bounds.highWater, 100)
      .filter((event) => event.type.startsWith("launch-consent."));
    expect(consentEvents.map((event) => event.type)).toEqual([
      "launch-consent.pending",
      "launch-consent.approved",
      "launch-consent.revoked",
      "launch-consent.pending",
      "launch-consent.cancelled",
      "launch-consent.pending",
      "launch-consent.denied",
    ]);
    expect(JSON.stringify(consentEvents.map((event) => event.payload))).not.toContain("command");
    expect(JSON.stringify(consentEvents.map((event) => event.payload))).not.toContain(
      "environment",
    );

    expect(
      (await daemon.app.inject({ method: "POST", url: "/api/v1/auth/revoke", payload: {} }))
        .statusCode,
    ).toBe(204);
    expect(
      (await daemon.app.inject({ method: "GET", url: "/api/v1/launch-consents" })).statusCode,
    ).toBe(401);
    await daemon.app.close();
  });

  it("marks approval stale when the current integration changes", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const pending = await createPendingConsent(daemon);
    const changed = await daemon.app.inject({
      method: "PATCH",
      url: `/api/v1/groups/${pending.group.id}/agents/${pending.membership.id}`,
      payload: { integrationId: "claude-copilot" },
    });
    expect(changed.statusCode).toBe(200);

    const stale = await daemon.app.inject({
      method: "POST",
      url: `/api/v1/launch-consents/${pending.request.id}/approve`,
      payload: exact(pending.request),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "launch_consent_stale" });
    expect(daemon.store.findLaunchConsentRequest(pending.request.id)?.state).toBe("stale");
    expect(daemon.store.getSnapshot().runs).toHaveLength(0);
    const bounds = daemon.store.eventBounds();
    expect(
      daemon.store
        .listEventPage(0, bounds.highWater, 100)
        .filter((event) => event.aggregateId === pending.request.id)
        .map((event) => event.type),
    ).toEqual(["launch-consent.pending", "launch-consent.stale"]);
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
    expect(JSON.parse(await eventFrame)).toMatchObject({
      type: "subscription.started",
      instanceId: daemon.guard.instanceId,
    });
    eventSocket.terminate();

    await daemon.app.close();
  });

  it("pages, clears, and bounds message history with helpful size errors", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const group = (
      await daemon.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Chat" } })
    ).json<{ id: string }>();
    const agent = (
      await daemon.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/agents`,
        payload: { name: "Agent", integrationId: "copilot" },
      })
    ).json<{ id: string; memberId: string }>();
    const submit = (text: string) =>
      daemon.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/messages`,
        payload: {
          intent: "request",
          sender: { kind: "operator", operatorId: "portal" },
          audience: { kind: "dm", memberId: agent.memberId },
          body: { contentType: "text/plain", text },
          delivery: {},
        },
      });

    for (const text of ["one", "two", "three"]) expect((await submit(text)).statusCode).toBe(201);
    const latest = await daemon.app.inject({
      method: "GET",
      url: `/api/groups/${group.id}/messages?limit=2`,
    });
    expect(latest.json()).toMatchObject({
      messages: [{ groupSeq: 2 }, { groupSeq: 3 }],
      pageInfo: { hasOlder: true, nextBefore: 2 },
    });
    const older = await daemon.app.inject({
      method: "GET",
      url: `/api/groups/${group.id}/messages?before=2&limit=2`,
    });
    expect(older.json()).toMatchObject({ messages: [{ groupSeq: 1 }] });
    expect((await daemon.app.inject({ method: "GET", url: "/api/snapshot" })).json()).toMatchObject(
      {
        messages: [],
        deliveryOutcomes: [],
        messageGroups: [{ groupId: group.id, retainedMessageCount: 3, latestGroupSeq: 3 }],
      },
    );

    const oversized = await submit("x".repeat(MAX_MESSAGE_TEXT_BYTES + 1));
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      details: {},
      code: "message_body_too_large",
    });
    expect(oversized.json().message).toContain("repository-relative path");

    const cleared = await daemon.app.inject({
      method: "DELETE",
      url: `/api/groups/${group.id}/messages`,
    });
    expect(cleared.json()).toMatchObject({ deletedMessages: 3, deletedDeliveries: 3 });
    expect((await submit("four")).json()).toMatchObject({ message: { groupSeq: 4 } });
    await daemon.app.close();
  });

  it("serves complete declarative extension lifecycle and generated references", async () => {
    const daemon = await createDaemon({ dataPath: ":memory:" });
    const catalog = await daemon.app.inject({ method: "GET", url: "/api/v1/extensions" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptor: expect.objectContaining({
            metadata: expect.objectContaining({ id: "nanasa.copilot" }),
          }),
          installed: true,
          enabled: true,
        }),
      ]),
    );
    const inspect = await daemon.app.inject({
      method: "GET",
      url: "/api/v1/extensions/nanasa.copilot",
    });
    expect(inspect.statusCode).toBe(200);
    const details = inspect.json<{
      plan: {
        planDigest: string;
        configRevision: string;
        lockRevision: number;
        requiresStoppedRuns: boolean;
      };
    }>();
    expect(details.plan).toMatchObject({ requiresStoppedRuns: false });
    expect(
      (
        await daemon.app.inject({
          method: "GET",
          url: "/api/v1/extensions/nanasa.copilot/health",
        })
      ).json(),
    ).toMatchObject({ extensionId: "nanasa.copilot", state: "current" });
    const reference = (
      await daemon.app.inject({ method: "GET", url: "/api/v1/schema/extensions.json" })
    ).json<{ strategies: { adapter: string[] }; permissions: string[]; descriptors: unknown[] }>();
    expect(reference.strategies.adapter).toContain("copilot-adapter-v1");
    expect(reference.permissions).toContain("runtime:launch-provider");
    expect(reference.descriptors).toHaveLength(4);

    const trust = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/extensions/nanasa.copilot/trust",
      payload: {
        planDigest: details.plan.planDigest,
        configRevision: details.plan.configRevision,
      },
    });
    expect(trust.statusCode).toBe(200);
    expect(trust.json()).not.toHaveProperty("token");
    const disabled = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/extensions/nanasa.copilot/disable",
      payload: { expectedLockRevision: details.plan.lockRevision },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ catalog: { health: { state: "disabled" } } });
    const afterDisable = disabled.json<{ plan: { lockRevision: number } }>();
    const repairPlan = (
      await daemon.app.inject({
        method: "GET",
        url: "/api/v1/extensions/nanasa.copilot/plan",
      })
    ).json<{ planDigest: string; configRevision: string; lockRevision: number }>();
    const repairTrust = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/extensions/nanasa.copilot/trust",
      payload: {
        planDigest: repairPlan.planDigest,
        configRevision: repairPlan.configRevision,
      },
    });
    expect(repairTrust.statusCode).toBe(200);
    const repaired = await daemon.app.inject({
      method: "POST",
      url: "/api/v1/extensions/nanasa.copilot/repair",
      payload: {
        planDigest: repairPlan.planDigest,
        configRevision: repairPlan.configRevision,
        expectedLockRevision: afterDisable.plan.lockRevision,
      },
    });
    expect(repaired.statusCode).toBe(200);
    const remove = await daemon.app.inject({
      method: "DELETE",
      url: "/api/v1/extensions/nanasa.copilot",
      payload: {
        expectedLockRevision: repaired.json<{ plan: { lockRevision: number } }>().plan.lockRevision,
      },
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json()).toMatchObject({ code: "extension_referenced" });
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
    daemon.store.createInternalAgentProfile({
      name: "Reviewer",
      agentType: "copilot",
      kind: "copilot",
      command: "copilot",
      args: [],
      environment: {},
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
          client.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as { type: string };
            if (frame.type === "domain.event") resolveReplay(data.toString());
          });
        },
      },
    );
    expect(JSON.parse(await replay)).toMatchObject({
      type: "domain.event",
      event: { sequence: 2, type: "agent-profile.created" },
    });

    const live = new Promise<string>((resolve) => {
      socket.once("message", (data) => resolve(data.toString()));
    });
    daemon.store.createGroup({ name: "Second" });
    expect(JSON.parse(await live)).toMatchObject({
      type: "domain.event",
      event: { sequence: 3, type: "group.created" },
    });

    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.terminate();
    });
    await daemon.app.close();
  });
});
