import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentProfileSchema,
  AgentProgressReportCommandSchema,
  AgentRunSchema,
  AgentStatusDetailSchema,
  AgentStatusEventInputSchema,
  ConfigStatusSchema,
  ControlMetadataSchema,
  CredentialProfileReferenceSchema,
  CreateGroupAgentCommandSchema,
  DeleteGroupResultSchema,
  DeliveryOutcomeSchema,
  EventServerFrameSchema,
  InstructionPathSchema,
  InterruptAgentRunCommandSchema,
  MAX_MESSAGE_TEXT_BYTES,
  MessageSchema,
  NanasaConfigSchema,
  NativeRecoveryPolicySchema,
  NativeSessionReferenceSchema,
  PortalSnapshotSchema,
  RemoveGroupAgentResultSchema,
  ReorderGroupAgentsCommandSchema,
  ReorderGroupAgentsResultSchema,
  StartAgentRunCommandSchema,
  SubmitMessageCommandSchema,
  TerminalCheckpointSchema,
  TerminalEndpointStatusSchema,
  UpdateGroupAgentCommandSchema,
  UpdateGroupCommandSchema,
} from "../src/index.js";

describe("versioned control-plane contracts", () => {
  it("requires daemon identity, epoch, versions, and explicit loopback-only metadata", () => {
    expect(
      ControlMetadataSchema.parse({
        apiVersion: 1,
        eventProtocolVersion: 1,
        productVersion: "0.0.0",
        configVersion: 2,
        databaseSchemaVersion: 5,
        repositoryId: "repo-one",
        instanceId: "daemon-one",
        daemonEpoch: 2,
        lifecycle: "ready",
        remoteAccess: "loopback-only",
        limits: { eventPendingBytes: 1_048_576 },
      }),
    ).toMatchObject({ instanceId: "daemon-one", daemonEpoch: 2 });
  });

  it("accepts only typed replay, heartbeat, reset, slow-consumer, and restart frames", () => {
    expect(
      EventServerFrameSchema.parse({
        type: "subscription.reset-required",
        reason: "cursor_expired",
        cursor: 10,
        snapshotUrl: "/api/v1/snapshot",
      }),
    ).toMatchObject({ type: "subscription.reset-required" });
    expect(EventServerFrameSchema.safeParse({ type: "event", sequence: 11 }).success).toBe(false);
  });

  it("fences portal snapshots by daemon instance and event sequence", () => {
    expect(
      PortalSnapshotSchema.parse({
        instanceId: "daemon-one",
        daemonEpoch: 2,
        sequence: 10,
        generatedAt: "2026-08-29T12:00:00.000Z",
        groups: [],
        agentProfiles: [],
        memberships: [],
        runs: [],
        messages: [],
        deliveryOutcomes: [],
      }),
    ).toMatchObject({ instanceId: "daemon-one", sequence: 10 });
  });
});

const baseMessage = {
  id: "msg_1",
  groupId: "grp_1",
  groupSeq: 1,
  conversationId: "conv_1",
  intent: "request",
  sender: {
    kind: "agent",
    memberId: "reviewer",
    runId: "run_1",
  },
  audience: {
    kind: "multicast",
    memberIds: ["builder", "tester"],
  },
  body: {
    contentType: "text/markdown",
    text: "Review the proposed API.",
  },
  delivery: {},
  hop: 0,
  createdAt: "2026-08-09T15:00:00Z",
} as const;

describe("message policy contracts", () => {
  it("generates only final delivery status names", () => {
    const schema = JSON.stringify(z.toJSONSchema(DeliveryOutcomeSchema));
    expect(schema).toContain("terminal_injected");
    expect(schema).not.toContain('"consumed"');
  });

  it("enforces message size in UTF-8 bytes and rejects malformed Unicode", () => {
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        body: { contentType: "text/plain", text: "a".repeat(MAX_MESSAGE_TEXT_BYTES) },
      }).success,
    ).toBe(true);
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        body: { contentType: "text/plain", text: "a".repeat(MAX_MESSAGE_TEXT_BYTES + 1) },
      }).success,
    ).toBe(false);
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        body: { contentType: "text/plain", text: "é".repeat(MAX_MESSAGE_TEXT_BYTES / 2) },
      }).success,
    ).toBe(true);
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        body: { contentType: "text/plain", text: "é".repeat(MAX_MESSAGE_TEXT_BYTES / 2 + 1) },
      }).success,
    ).toBe(false);
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        body: { contentType: "text/plain", text: "\ud800" },
      }).success,
    ).toBe(false);
  });

  it("uses one final delivery policy and rejects discarded delivery modes", () => {
    expect(MessageSchema.parse(baseMessage).delivery).toEqual({});
    const command = {
      conversationId: baseMessage.conversationId,
      intent: baseMessage.intent,
      sender: baseMessage.sender,
      audience: baseMessage.audience,
      body: baseMessage.body,
      delivery: baseMessage.delivery,
      hop: baseMessage.hop,
    };
    expect(
      SubmitMessageCommandSchema.parse({
        ...command,
      }).delivery,
    ).toEqual({});
    expect(
      MessageSchema.safeParse({ ...baseMessage, delivery: { mode: "terminal" } }).success,
    ).toBe(false);
    expect(
      SubmitMessageCommandSchema.parse({
        ...command,
        delivery: {},
      }).delivery,
    ).toEqual({});
  });

  it("defines interrupt as a separate privileged run command", () => {
    expect(
      InterruptAgentRunCommandSchema.parse({ operatorId: "operator_1", reason: "New priority" }),
    ).toEqual({ operatorId: "operator_1", reason: "New priority" });
  });

  it.each([
    ["queue mode", { delivery: { mode: "queue" } }],
    ["interrupt mode", { delivery: { mode: "interrupt" } }],
    ["fallback", { delivery: { fallback: "queue" } }],
    ["agent control message", { intent: "control" }],
    [
      "duplicate multicast recipients",
      {
        audience: { kind: "multicast", memberIds: ["builder", "builder"] },
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(MessageSchema.safeParse({ ...baseMessage, ...overrides }).success).toBe(false);
  });
});

describe("terminal endpoint status contracts", () => {
  it.each(["starting", "backoff", "unavailable", "stopped"] as const)(
    "accepts the %s state without a URL",
    (state) => {
      expect(
        TerminalEndpointStatusSchema.parse({ runId: "run_1", provider: "ttyd", state }),
      ).toEqual({
        runId: "run_1",
        provider: "ttyd",
        state,
      });
    },
  );

  it("accepts a ready endpoint with a same-origin URL", () => {
    expect(
      TerminalEndpointStatusSchema.parse({
        runId: "run_1",
        provider: "ttyd",
        state: "ready",
        url: "/terminals/0123456789abcdef0123456789abcdef/",
      }),
    ).toEqual({
      runId: "run_1",
      provider: "ttyd",
      state: "ready",
      url: "/terminals/0123456789abcdef0123456789abcdef/",
    });
  });

  it("accepts retry and error metadata without exposing an upstream", () => {
    expect(
      TerminalEndpointStatusSchema.parse({
        runId: "run_1",
        provider: "ttyd",
        state: "backoff",
        retryAfterMs: 2_000,
        error: { code: "ttyd_exited", message: "Terminal provider exited" },
      }),
    ).toMatchObject({
      provider: "ttyd",
      retryAfterMs: 2_000,
      error: { code: "ttyd_exited" },
    });
  });

  it.each([
    [
      "a non-ready endpoint URL",
      { runId: "run_1", provider: "ttyd", state: "starting", url: "/terminals/x/" },
    ],
    ["a ready endpoint without a URL", { runId: "run_1", provider: "ttyd", state: "ready" }],
    ["a missing provider", { runId: "run_1", state: "unavailable" }],
    ["a different provider", { runId: "run_1", provider: "custom", state: "unavailable" }],
    [
      "an absolute ready endpoint URL",
      {
        runId: "run_1",
        provider: "ttyd",
        state: "ready",
        url: "https://example.com/terminals/0123456789abcdef0123456789abcdef/",
      },
    ],
    [
      "an endpoint key with the wrong shape",
      {
        runId: "run_1",
        provider: "ttyd",
        state: "ready",
        url: "/terminals/not-a-valid-endpoint-key/",
      },
    ],
    [
      "an upstream port",
      { runId: "run_1", provider: "ttyd", state: "unavailable", upstreamPort: 7681 },
    ],
    [
      "an upstream host",
      { runId: "run_1", provider: "ttyd", state: "unavailable", upstreamHost: "127.0.0.1" },
    ],
  ])("rejects %s", (_name, status) => {
    expect(TerminalEndpointStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe("terminal checkpoint contracts", () => {
  it("accepts owner-bound metadata without raw terminal content", () => {
    const checkpoint = TerminalCheckpointSchema.parse({
      id: "checkpoint_1",
      ownerPrincipalId: "operator_1",
      runId: "run_1",
      generation: 2,
      terminalBinding: {
        serverName: "nanasa",
        sessionId: "session_1",
        windowId: "@1",
        paneId: "%1",
      },
      capturedAt: "2026-08-29T12:00:00Z",
      lineCount: 10,
      byteCount: 200,
      truncated: false,
      sensitivity: "repository-private",
      storageReference: ".nanasa/state/checkpoints/checkpoint_1.enc",
      expiresAt: "2026-08-30T12:00:00Z",
    });
    expect(checkpoint.ownerPrincipalId).toBe("operator_1");
    expect(
      TerminalCheckpointSchema.safeParse({ ...checkpoint, rawBytes: "secret terminal output" })
        .success,
    ).toBe(false);
  });
});

describe("agent run contracts", () => {
  it("applies run viewport defaults", () => {
    expect(StartAgentRunCommandSchema.parse({})).toEqual({ cols: 120, rows: 40 });
  });

  it("tracks desired state and recovery phase and rejects adapter sessions", () => {
    const run = {
      id: "run_1",
      groupId: "group_1",
      memberId: "member_1",
      agentProfileId: "profile_1",
      generation: 1,
      status: "running",
      desiredState: "running",
      recoveryPhase: "recovered",
      startedAt: "2026-08-10T12:00:00Z",
    } as const;
    expect(AgentRunSchema.parse(run)).toMatchObject({ recoveryPhase: "recovered" });
    expect(
      AgentRunSchema.safeParse({ ...run, adapterSession: { sessionId: "session_1" } }).success,
    ).toBe(false);
  });

  it("rejects discarded adapter metadata on canonical profiles", () => {
    expect(
      AgentProfileSchema.safeParse({
        id: "profile_1",
        name: "Reviewer",
        agentType: "copilot",
        kind: "copilot",
        adapter: "copilot-cli",
        capabilities: ["queue"],
        command: "copilot",
        args: [],
        environment: {},
        createdAt: "2026-08-10T12:00:00Z",
        updatedAt: "2026-08-10T12:00:00Z",
      }).success,
    ).toBe(false);
  });
});

describe("agent status contracts", () => {
  it("accepts normalized correlated tool and wait events", () => {
    expect(
      AgentStatusEventInputSchema.parse({
        version: 1,
        eventId: "event_1",
        source: "claude-code",
        reporterVersion: "1",
        event: "tool.started",
        operationId: "tool_1",
        data: { tool: "Bash" },
      }),
    ).toMatchObject({ event: "tool.started", operationId: "tool_1" });
    expect(
      AgentStatusEventInputSchema.parse({
        version: 1,
        eventId: "event_2",
        source: "opencode",
        reporterVersion: "1",
        event: "wait.opened",
        requestId: "request_1",
        data: {
          waitKind: "permission",
          summary: "Permission required",
          replyChannel: "terminal",
        },
      }),
    ).toMatchObject({ event: "wait.opened", requestId: "request_1" });
  });

  it("rejects missing correlation, caller identity, and unknown metadata", () => {
    expect(
      AgentStatusEventInputSchema.safeParse({
        version: 1,
        eventId: "event_1",
        source: "pi",
        reporterVersion: "1",
        event: "tool.started",
      }).success,
    ).toBe(false);
    expect(
      AgentStatusEventInputSchema.safeParse({
        version: 1,
        eventId: "event_2",
        source: "copilot",
        reporterVersion: "1",
        event: "session.ready",
        runId: "forged",
      }).success,
    ).toBe(false);
  });

  it("accepts bounded cooperative progress and status details", () => {
    expect(
      AgentProgressReportCommandSchema.parse({
        stage: "validation",
        summary: "Focused tests pass",
        nextStep: "Run typecheck",
      }),
    ).toMatchObject({ stage: "validation" });
    expect(
      AgentStatusDetailSchema.parse({
        groupId: "group_1",
        memberId: "member_1",
        alias: "Reviewer",
        agentType: "claude-code",
        runId: "run_1",
        generation: 1,
        runStatus: "running",
        state: "waiting",
        phase: "permission",
        outcome: "unknown",
        confidence: "high",
        attention: "decision_required",
        observedAt: "2026-08-11T12:00:00Z",
        stateChangedAt: "2026-08-11T12:00:00Z",
        openWait: {
          requestId: "request_1",
          kind: "permission",
          summary: "Permission required",
          replyChannel: "terminal",
          openedAt: "2026-08-11T12:00:00Z",
        },
        cleanEndSeen: false,
        evidence: [],
        recentTransitions: [],
      }),
    ).toMatchObject({ state: "waiting", attention: "decision_required" });
  });
});

describe("configuration contracts", () => {
  it("stores credential references and rejects raw secrets", () => {
    expect(
      CredentialProfileReferenceSchema.parse({ kind: "broker-profile", profileId: "work" }),
    ).toEqual({
      kind: "broker-profile",
      profileId: "work",
    });
    expect(
      CredentialProfileReferenceSchema.safeParse({
        kind: "broker-profile",
        profileId: "work",
        token: "secret",
      }).success,
    ).toBe(false);
  });

  it("bounds confirmed native recovery and validates opaque native references", () => {
    expect(
      NativeRecoveryPolicySchema.parse({
        mode: "resume-only",
        confirmationTimeoutSeconds: 30,
      }),
    ).toEqual({ mode: "resume-only", confirmationTimeoutSeconds: 30 });
    expect(
      NativeRecoveryPolicySchema.safeParse({
        mode: "resume-or-restart",
        confirmationTimeoutSeconds: 4,
      }).success,
    ).toBe(false);
    expect(
      NativeRecoveryPolicySchema.safeParse({
        mode: "resume-or-restart",
        confirmationTimeoutSeconds: 301,
      }).success,
    ).toBe(false);
    expect(
      NativeSessionReferenceSchema.parse({
        provider: "copilot",
        source: "copilot",
        referenceKind: "id",
        referenceValue: "session-one",
        dedupeHash: "a".repeat(64),
      }),
    ).toMatchObject({ referenceValue: "session-one" });
  });

  const config = {
    version: 2,
    integrations: {
      copilot: {
        id: "copilot",
        name: "GitHub Copilot",
        kind: "copilot",
        command: ["copilot"],
      },
      opencode: {
        id: "opencode",
        name: "OpenCode",
        kind: "opencode",
        command: ["opencode"],
      },
    },
  } as const;

  it("requires version 2 and emits final canonical defaults", () => {
    const parsed = NanasaConfigSchema.parse(config);
    expect(parsed.version).toBe(2);
    expect(parsed.repository).toEqual({ path: ".", checkout: { kind: "current" } });
    expect(parsed.terminal.checkpoints).toMatchObject({
      enabled: false,
      sensitivity: "repository-private",
    });
    expect(parsed.integrations.copilot).toMatchObject({
      providerState: { scope: "membership" },
      credentials: { kind: "provider-managed" },
      model: { resumePolicy: "preserve-session" },
      nativeRecovery: { mode: "resume-or-restart", confirmationTimeoutSeconds: 30 },
      extensions: [],
    });
    expect(NanasaConfigSchema.safeParse({ ...config, version: undefined }).success).toBe(false);
    expect(NanasaConfigSchema.safeParse({ ...config, version: 1 }).success).toBe(false);
    expect(
      NanasaConfigSchema.safeParse({
        ...config,
        integrations: {
          ...config.integrations,
          copilot: { ...config.integrations.copilot, adapter: "copilot-cli" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a minimal terminal-only integration", () => {
    expect(
      NanasaConfigSchema.parse({
        version: 2,
        integrations: {
          pi: {
            id: "pi",
            name: "Pi",
            kind: "pi",
            command: ["pi"],
          },
        },
      }),
    ).toMatchObject({
      version: 2,
      integrations: { pi: { providerState: { scope: "membership" } } },
    });
  });

  it("validates flattened agents, integration and role references, and defaults", () => {
    const parsed = NanasaConfigSchema.parse({
      version: 2,
      integrations: config.integrations,
      instructions: [".nanasa/instructions/team.md"],
      roles: {
        reviewer: {
          name: "Reviewer",
          instructions: [".nanasa/instructions/reviewer.md"],
          permissionPolicy: "read-only",
          presentation: {
            icon: "shield-check",
            color: "amber",
            shortName: "Review",
          },
        },
      },
      groups: {
        group_one: {
          name: "Team",
          agents: {
            agent_one: {
              memberId: "copilot.reviewer",
              name: "Reviewer",
              integrationId: "copilot",
              roleId: "reviewer",
              order: 0,
            },
          },
        },
      },
    });

    expect(parsed.roles.reviewer).toMatchObject({
      permissionPolicy: "read-only",
      instructions: [".nanasa/instructions/reviewer.md"],
      presentation: {
        icon: "shield-check",
        color: "amber",
        shortName: "Review",
      },
    });
    expect(parsed.groups.group_one?.agents.agent_one).toMatchObject({
      memberId: "copilot.reviewer",
      name: "Reviewer",
      integrationId: "copilot",
      roleId: "reviewer",
      instructions: [],
      order: 0,
    });
    expect(
      NanasaConfigSchema.safeParse({
        ...parsed,
        roles: {
          ...parsed.roles,
          reviewer: {
            ...parsed.roles.reviewer,
            presentation: { icon: "sparkles", color: "gold" },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      NanasaConfigSchema.safeParse({
        ...parsed,
        groups: {
          group_one: {
            ...parsed.groups.group_one,
            agents: {
              agent_one: {
                ...parsed.groups.group_one?.agents.agent_one,
                integrationId: "missing-integration",
              },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      NanasaConfigSchema.safeParse({
        ...parsed,
        groups: {
          group_one: {
            ...parsed.groups.group_one,
            agents: {
              agent_one: {
                ...parsed.groups.group_one?.agents.agent_one,
                roleId: "missing-role",
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate configured agent IDs globally and member IDs within a group", () => {
    const agent = {
      memberId: "copilot.builder",
      name: "Builder",
      integrationId: "copilot",
    };
    expect(
      NanasaConfigSchema.safeParse({
        integrations: config.integrations,
        groups: {
          first: { name: "First", agents: { shared_agent: agent } },
          second: {
            name: "Second",
            agents: { shared_agent: { ...agent, memberId: "copilot.reviewer" } },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      NanasaConfigSchema.safeParse({
        integrations: config.integrations,
        groups: {
          first: {
            name: "First",
            agents: {
              agent_one: agent,
              agent_two: { ...agent, name: "Reviewer" },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["missing version", { ...config, version: undefined }],
    ["version 1", { ...config, version: 1 }],
    ["agentTypes", { ...config, agentTypes: config.integrations }],
    ["agentProfiles", { ...config, agentProfiles: {} }],
    [
      "memberships",
      {
        ...config,
        groups: { group_one: { name: "Team", memberships: {} } },
      },
    ],
  ])("rejects the legacy %s vocabulary", (_name, legacyConfig) => {
    expect(NanasaConfigSchema.safeParse(legacyConfig).success).toBe(false);
  });

  it("accepts membership and custom provider state scopes", () => {
    const agent = NanasaConfigSchema.parse({
      version: 2,
      integrations: {
        pi: {
          id: "pi",
          name: "Pi",
          kind: "pi",
          command: ["pi"],
          providerState: { scope: "membership" },
        },
      },
    });
    expect(agent.integrations.pi.providerState).toEqual({ scope: "membership" });

    const custom = NanasaConfigSchema.parse({
      version: 2,
      integrations: {
        copilot: {
          id: "copilot",
          name: "Copilot",
          kind: "copilot",
          command: ["copilot"],
          providerState: { scope: "custom", path: "homes/{integrationId}/{agentId}" },
        },
      },
    });
    expect(custom.integrations.copilot.providerState).toEqual({
      scope: "custom",
      path: "homes/{integrationId}/{agentId}",
    });
  });

  it("accepts only Markdown instruction paths", () => {
    expect(InstructionPathSchema.parse(".nanasa/instructions/team.md")).toBe(
      ".nanasa/instructions/team.md",
    );
    expect(InstructionPathSchema.safeParse(".nanasa/instructions/team.txt").success).toBe(false);
  });

  it("validates source-aware config status", () => {
    expect(
      ConfigStatusSchema.parse({
        state: "ready",
        repoRoot: "/repo",
        configPath: "/repo/.nanasa/config.yaml",
        revision: "a".repeat(64),
        diagnostics: [],
      }),
    ).toMatchObject({ state: "ready", revision: "a".repeat(64) });
  });
});

describe("group CRUD contracts", () => {
  it("trims group and agent names", () => {
    expect(UpdateGroupCommandSchema.parse({ name: "  Builders  " })).toEqual({
      name: "Builders",
    });
    expect(UpdateGroupAgentCommandSchema.parse({ name: "  Reviewer  " })).toEqual({
      name: "Reviewer",
    });
  });

  it.each([
    [UpdateGroupCommandSchema, { name: "" }],
    [UpdateGroupCommandSchema, { name: "x".repeat(101) }],
    [UpdateGroupCommandSchema, { name: "Builders", unknown: true }],
    [UpdateGroupAgentCommandSchema, { name: "" }],
    [UpdateGroupAgentCommandSchema, { name: "x".repeat(101) }],
    [UpdateGroupAgentCommandSchema, { name: "Reviewer", unknown: true }],
  ])("rejects invalid or unknown rename fields", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("validates direct agent create, update, remove, and order contracts", () => {
    expect(
      CreateGroupAgentCommandSchema.parse({
        name: "Builder",
        integrationId: "copilot",
        roleId: "implementor",
      }),
    ).toEqual({ name: "Builder", integrationId: "copilot", roleId: "implementor" });
    expect(UpdateGroupAgentCommandSchema.parse({ roleId: null })).toEqual({ roleId: null });
    expect(UpdateGroupAgentCommandSchema.safeParse({}).success).toBe(false);

    const removed = {
      groupId: "group_1",
      agentId: "agent_one",
      deletedRuns: 1,
      revokedDeliveries: 2,
    };
    expect(RemoveGroupAgentResultSchema.parse(removed)).toEqual(removed);

    const reordered = {
      agentIds: ["agent_one", "agent_two"],
      expectedAgentRevision: 3,
    };
    expect(ReorderGroupAgentsCommandSchema.parse(reordered)).toEqual(reordered);
    expect(
      ReorderGroupAgentsCommandSchema.safeParse({
        agentIds: ["agent_one", "agent_one"],
        expectedAgentRevision: 3,
      }).success,
    ).toBe(false);
    expect(
      ReorderGroupAgentsResultSchema.parse({
        groupId: "group_1",
        agentIds: reordered.agentIds,
        agentRevision: 4,
      }),
    ).toEqual({ groupId: "group_1", agentIds: reordered.agentIds, agentRevision: 4 });
  });

  it("validates strict delete counts", () => {
    const result = {
      groupId: "group_1",
      deletedMemberships: 2,
      deletedRuns: 1,
      deletedMessages: 3,
      deletedDeliveries: 4,
    };
    expect(DeleteGroupResultSchema.parse(result)).toEqual(result);
    expect(DeleteGroupResultSchema.safeParse({ ...result, deletedRuns: -1 }).success).toBe(false);
    expect(DeleteGroupResultSchema.safeParse({ ...result, unknown: 0 }).success).toBe(false);
  });

  it("rejects discarded delivery adapter metadata", () => {
    expect(
      DeliveryOutcomeSchema.safeParse({
        messageId: "message_1",
        recipientMemberId: "member_1",
        requestedMode: "steer",
        appliedMode: "queue",
        fallbackApplied: true,
        adapter: "pi-rpc",
        adapterSessionId: "session_1",
        adapterMessageId: "adapter_message_1",
        reason: "requested_mode_not_supported",
        status: "queued",
        attempts: 0,
        updatedAt: "2026-08-10T12:00:00Z",
      }).success,
    ).toBe(false);
  });
});
