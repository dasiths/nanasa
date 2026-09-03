import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentActionAttemptSchema,
  AgentActionSchema,
  AgentActionStateSchema,
  AgentProfileSchema,
  AgentProgressReportCommandSchema,
  AgentRunSchema,
  AgentStatusDetailSchema,
  AgentStatusEventInputSchema,
  AgentStatusStateSchema,
  CheckoutSchema,
  ConfigStatusSchema,
  ControlMetadataSchema,
  CreateGroupAgentCommandSchema,
  CreateWorktreeCommandSchema,
  CredentialProfileReferenceSchema,
  CustomLaunchConsentDecisionResultSchema,
  CustomLaunchConsentDecisionSchema,
  CustomLaunchConsentErrorCodeSchema,
  CustomLaunchConsentLifecycleEventPayloadSchema,
  CustomLaunchConsentRequestSchema,
  CustomLaunchConsentSubjectSchema,
  DeleteGroupResultSchema,
  DeliveryOutcomeSchema,
  ErrorPayloadSchema,
  EventServerFrameSchema,
  ExtensionLockSchema,
  InstructionPathSchema,
  InterruptAgentRunCommandSchema,
  MAX_MESSAGE_TEXT_BYTES,
  MessageSchema,
  NanasaConfigSchema,
  NativeRecoveryPolicySchema,
  NativeSessionReferenceSchema,
  OpenWaitSchema,
  PortalSnapshotSchema,
  ProviderExtensionDescriptorSchema,
  REQUIRED_PROVIDER_EXTENSION_PERMISSIONS,
  RemoveGroupAgentResultSchema,
  RemoveWorktreeCommandSchema,
  ReorderGroupAgentsCommandSchema,
  ReorderGroupAgentsResultSchema,
  ReplyOpenWaitCommandSchema,
  RepositorySchema,
  StartAgentRunCommandSchema,
  StartAgentRunResultSchema,
  SubmitMessageCommandSchema,
  TerminalCheckpointSchema,
  TerminalEndpointStatusSchema,
  TerminalServerFrameSchema,
  UpdateGroupAgentCommandSchema,
  UpdateGroupCommandSchema,
  WorktreeSchema,
} from "../src/index.js";

const customLaunchSubject = {
  repositoryIdentity: "repo_1234567890abcdef",
  integrationId: "claude-wrapper",
  providerKind: "claude-code",
  adapterId: "nanasa.claude-code-v2",
  adapterSecurityVersion: "2.0.0",
  configuredCommand: ["sh", "bin/claude-wrapper"],
  launcher: "append",
  launcherFiles: [{ path: "bin/claude-wrapper", digest: "a".repeat(64) }],
  workingDirectory: "/repository",
  environmentNames: ["ANTHROPIC_BASE_URL", "NANASA_MCP_URL"],
  credentialReference: { kind: "provider-managed" },
  permissionFloor: "inherit",
} as const;

describe("custom launch consent contracts", () => {
  it("accepts redacted stable subjects and rejects duplicate set members or runtime data", () => {
    expect(CustomLaunchConsentSubjectSchema.parse(customLaunchSubject)).toEqual(
      customLaunchSubject,
    );
    expect(
      CustomLaunchConsentSubjectSchema.safeParse({
        ...customLaunchSubject,
        environmentNames: ["NANASA_MCP_URL", "NANASA_MCP_URL"],
      }).success,
    ).toBe(false);
    expect(
      CustomLaunchConsentSubjectSchema.safeParse({
        ...customLaunchSubject,
        runId: "run-specific",
      }).success,
    ).toBe(false);
  });

  it("defines exact pending-request, decision, and approval-required start results", () => {
    const request = CustomLaunchConsentRequestSchema.parse({
      id: "consent-one",
      repositoryIdentity: customLaunchSubject.repositoryIdentity,
      groupId: "group-one",
      agentId: "agent-one",
      memberId: "claude.reviewer",
      integrationId: customLaunchSubject.integrationId,
      subjectDigest: "b".repeat(64),
      configRevision: "c".repeat(64),
      subject: customLaunchSubject,
      state: "pending",
      requestedAt: "2026-09-02T12:00:00.000Z",
    });

    expect(StartAgentRunResultSchema.parse({ status: "approval-required", request })).toMatchObject(
      { status: "approval-required", request: { id: "consent-one" } },
    );
    expect(
      CustomLaunchConsentDecisionResultSchema.parse({
        request: {
          ...request,
          state: "approved",
          decidedAt: "2026-09-02T12:01:00.000Z",
          decidedBy: "operator-one",
        },
        decision: CustomLaunchConsentDecisionSchema.parse({
          id: "receipt-one",
          repositoryIdentity: customLaunchSubject.repositoryIdentity,
          subjectDigest: request.subjectDigest,
          principalId: "operator-one",
          decision: "trusted",
          decidedAt: "2026-09-02T12:01:00.000Z",
        }),
      }),
    ).toMatchObject({
      request: { state: "approved" },
      decision: { id: "receipt-one", decision: "trusted" },
    });
    expect(CustomLaunchConsentErrorCodeSchema.parse("launch_consent_stale")).toBe(
      "launch_consent_stale",
    );
    expect(
      CustomLaunchConsentLifecycleEventPayloadSchema.parse({
        state: "pending",
        repositoryIdentity: request.repositoryIdentity,
        subjectDigest: request.subjectDigest,
        requestId: request.id,
        groupId: request.groupId,
        agentId: request.agentId,
        memberId: request.memberId,
        integrationId: request.integrationId,
        configRevision: request.configRevision,
      }),
    ).not.toHaveProperty("subject");
  });
});

describe("versioned control-plane contracts", () => {
  it("normalizes public errors to message, details, and code", () => {
    expect(
      ErrorPayloadSchema.parse({
        message: "The configured command is unsupported",
        code: "provider_command_unrecognized",
      }),
    ).toEqual({
      message: "The configured command is unsupported",
      details: {},
      code: "provider_command_unrecognized",
    });
    expect(
      ErrorPayloadSchema.safeParse({
        message: "Invalid error code",
        details: {},
        code: "Invalid Code",
      }).success,
    ).toBe(false);
  });

  it("requires daemon identity, epoch, versions, and explicit loopback-only metadata", () => {
    expect(
      ControlMetadataSchema.parse({
        apiVersion: 1,
        eventProtocolVersion: 1,
        productVersion: "0.1.0-next.11.0",
        buildCommit: "a".repeat(40),
        releaseChannel: "next",
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
  it("derives causal depth on the server instead of accepting caller-owned hops", () => {
    const command = {
      intent: baseMessage.intent,
      sender: baseMessage.sender,
      audience: baseMessage.audience,
      body: baseMessage.body,
      delivery: baseMessage.delivery,
    };
    expect(SubmitMessageCommandSchema.safeParse(command).success).toBe(true);
    expect(
      SubmitMessageCommandSchema.safeParse({
        ...command,
        hop: 2,
      }).success,
    ).toBe(false);
  });
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

describe("durable action contracts", () => {
  it("defines every distinct exact-work lifecycle state", () => {
    expect(AgentActionStateSchema.options).toEqual([
      "created",
      "deferred",
      "submitted",
      "accepted",
      "started",
      "blocked",
      "completed",
      "settled-unverified",
      "failed",
      "stalled",
      "timed-out",
      "cancelled",
      "expired",
      "superseded",
      "rejected",
    ]);
  });

  it("requires complete runtime, daemon, reporter, revision, and terminal attempt pins", () => {
    const target = {
      groupId: "group_1",
      memberId: "member_1",
      runId: "run_1",
      generation: 2,
      daemonEpoch: 4,
      reporterSessionId: "reporter_session_1",
      reporterId: "claude-hooks",
      reporterEpoch: "reporter_epoch_1",
      nativeSessionId: "native_1",
      baselineStatusRevision: 9,
      baselineCompletionRevision: 3,
    };
    expect(
      AgentActionSchema.parse({
        version: 1,
        id: "action_1",
        kind: "prompt",
        principal: { kind: "operator", operatorId: "operator_1" },
        target,
        idempotencyKey: "action-key",
        requestDigest: "a".repeat(64),
        prompt: "Review this",
        allowWorking: false,
        state: "created",
        queueDeadlineAt: "2026-08-29T12:05:00Z",
        createdAt: "2026-08-29T12:00:00Z",
        updatedAt: "2026-08-29T12:00:00Z",
      }).target,
    ).toEqual(target);
    expect(
      AgentActionAttemptSchema.safeParse({
        id: "attempt_1",
        actionId: "action_1",
        attempt: 1,
        effect: "terminal-injection",
        state: "submitting",
        ...target,
        terminalBinding: {
          serverName: "nanasa",
          sessionId: "session_1",
          windowId: "@1",
          paneId: "%1",
        },
        terminalBindingFingerprint: "b".repeat(64),
        leaseOwner: "scheduler_1",
        leaseExpiresAt: "2026-08-29T12:01:00Z",
        createdAt: "2026-08-29T12:00:00Z",
        updatedAt: "2026-08-29T12:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("models exact question, permission, plan approval, and elicitation replies", () => {
    for (const kind of ["question", "permission", "plan_approval", "elicitation"] as const) {
      expect(
        OpenWaitSchema.parse({
          id: `wait_${kind}`,
          groupId: "group_1",
          memberId: "member_1",
          runId: "run_1",
          generation: 1,
          reporterSessionId: "reporter_1",
          reporterId: "claude-hooks",
          reporterEpoch: "epoch_1",
          providerRequestId: `request_${kind}`,
          kind,
          summary: "Exact provider request",
          replyChannel: "terminal",
          openedStatusRevision: 2,
          state: "open",
          openedAt: "2026-08-29T12:00:00Z",
          updatedAt: "2026-08-29T12:00:00Z",
        }).kind,
      ).toBe(kind);
    }
    expect(
      ReplyOpenWaitCommandSchema.safeParse({
        expectedRunId: "run_1",
        expectedGeneration: 1,
        expectedReporterEpoch: "epoch_1",
        expectedStatusRevision: 2,
        reply: { kind: "keys", keys: ["Enter"] },
      }).success,
    ).toBe(false);
  });
});

describe("terminal endpoint status contracts", () => {
  it.each(["starting", "unavailable", "stopped"] as const)(
    "accepts the %s state without a stream URL",
    (state) => {
      expect(
        TerminalEndpointStatusSchema.parse({
          runId: "run_1",
          provider: "nanasa-terminal.v1",
          state,
        }),
      ).toEqual({
        runId: "run_1",
        provider: "nanasa-terminal.v1",
        state,
      });
    },
  );

  it("accepts a ready endpoint with final protocol limits", () => {
    const endpoint = {
      runId: "run_1",
      provider: "nanasa-terminal.v1",
      state: "ready" as const,
      streamUrl: "/api/v1/terminal-stream/run_1",
      protocol: "nanasa-terminal.v1",
      limits: {
        maxFrameBytes: 262_144,
        maxInputBytes: 65_536,
        maxPasteBytes: 196_608,
        maxOutputQueueBytes: 1_048_576,
        maxViewers: 4,
        maxObservers: 3,
        maxReadLines: 5_000,
        maxReadBytes: 1_048_576,
        heartbeatMs: 5_000,
        leaseMs: 15_000,
        reconnectHistoryFrames: 256,
      },
      observers: 0,
    };
    expect(TerminalEndpointStatusSchema.parse(endpoint)).toEqual(endpoint);
  });

  it.each([
    [
      "a non-ready endpoint URL",
      {
        runId: "run_1",
        provider: "nanasa-terminal.v1",
        state: "starting",
        streamUrl: "/api/v1/terminal-stream/run_1",
      },
    ],
    [
      "a ready endpoint without a descriptor",
      { runId: "run_1", provider: "nanasa-terminal.v1", state: "ready" },
    ],
    ["a missing provider", { runId: "run_1", state: "unavailable" }],
    ["a different provider", { runId: "run_1", provider: "custom", state: "unavailable" }],
    [
      "an absolute ready endpoint URL",
      {
        runId: "run_1",
        provider: "nanasa-terminal.v1",
        state: "ready",
        streamUrl: "https://example.com/api/v1/terminal-stream/run_1",
      },
    ],
    [
      "an endpoint key with the wrong shape",
      {
        runId: "run_1",
        provider: "nanasa-terminal.v1",
        state: "ready",
        streamUrl: "/terminals/not-a-valid-endpoint-key/",
      },
    ],
    [
      "an upstream port",
      { runId: "run_1", provider: "nanasa-terminal.v1", state: "unavailable", upstreamPort: 7681 },
    ],
    [
      "an upstream host",
      {
        runId: "run_1",
        provider: "nanasa-terminal.v1",
        state: "unavailable",
        upstreamHost: "127.0.0.1",
      },
    ],
  ])("rejects %s", (_name, status) => {
    expect(TerminalEndpointStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe("terminal input state contracts", () => {
  const welcome = {
    type: "welcome",
    version: 1,
    daemonEpoch: 1,
    streamId: "stream_1",
    streamGeneration: 1,
    runId: "run_1",
    runGeneration: 1,
    binding: { serverName: "nanasa", sessionId: "$1", windowId: "@1", paneId: "%1" },
    role: "controller",
    inputState: "automated",
    limits: {
      maxFrameBytes: 262_144,
      maxInputBytes: 65_536,
      maxPasteBytes: 196_608,
      maxOutputQueueBytes: 1_048_576,
      maxViewers: 4,
      maxObservers: 3,
      maxReadLines: 5_000,
      maxReadBytes: 1_048_576,
      heartbeatMs: 5_000,
      leaseMs: 15_000,
      reconnectHistoryFrames: 256,
    },
    capabilities: {
      input: true,
      paste: true,
      focus: true,
      resize: true,
      effects: true,
      read: true,
      checkpoints: true,
    },
  } as const;

  it("requires current input state during terminal handshake", () => {
    expect(TerminalServerFrameSchema.parse(welcome)).toMatchObject({ inputState: "automated" });
    expect(TerminalServerFrameSchema.safeParse({ ...welcome, inputState: undefined }).success).toBe(
      false,
    );
  });

  it("accepts only strict interactive and automated transition frames", () => {
    expect(TerminalServerFrameSchema.parse({ type: "input-state", state: "interactive" })).toEqual({
      type: "input-state",
      state: "interactive",
    });
    expect(
      TerminalServerFrameSchema.safeParse({ type: "input-state", state: "paused" }).success,
    ).toBe(false);
    expect(
      TerminalServerFrameSchema.safeParse({
        type: "input-state",
        state: "automated",
        messageId: "secret",
      }).success,
    ).toBe(false);
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
      contentDigest: "a".repeat(64),
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

describe("Git ownership contracts", () => {
  it("separates common repository identity from checkout identity", () => {
    const repository = RepositorySchema.parse({
      id: "repo_one",
      commonDirectory: "/repos/one/.git",
      displayName: "one",
      objectFormat: "sha1",
      refStorage: "files",
      primaryCheckoutId: "checkout_main",
      revision: 1,
      createdAt: "2026-08-29T12:00:00Z",
      updatedAt: "2026-08-29T12:00:00Z",
    });
    const checkout = CheckoutSchema.parse({
      id: "checkout_main",
      repositoryId: repository.id,
      checkoutKey: "a".repeat(64),
      path: "/repos/one",
      gitDirectory: "/repos/one/.git",
      kind: "primary",
      branch: "main",
      dirty: false,
      observedAt: "2026-08-29T12:00:00Z",
    });
    expect(checkout.repositoryId).toBe(repository.id);
    expect(checkout.id).not.toBe(repository.id);
  });

  it("requires persisted provenance and operation generation for managed deletion", () => {
    expect(
      WorktreeSchema.parse({
        id: "worktree_one",
        repositoryId: "repo_one",
        checkoutId: "checkout_one",
        sourceCheckoutId: "checkout_main",
        path: "/repos/worktrees/one",
        branch: "feature/one",
        base: "HEAD",
        provenanceToken: "b".repeat(64),
        operationGeneration: 3,
        state: "ready",
        createdAt: "2026-08-29T12:00:00Z",
        updatedAt: "2026-08-29T12:00:00Z",
      }),
    ).toMatchObject({ operationGeneration: 3, state: "ready" });
    expect(
      RemoveWorktreeCommandSchema.parse({ force: true, expectedOperationGeneration: 3 }),
    ).toEqual({ force: true, expectedOperationGeneration: 3 });
    expect(
      CreateWorktreeCommandSchema.parse({
        sourceCheckoutId: "checkout_main",
        branch: "feature/one",
      }),
    ).toMatchObject({ base: "HEAD", assignAgentIds: [] });
  });
});

describe("agent status contracts", () => {
  const reporter = {
    version: 2 as const,
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code" as const,
    protocolVersion: 2 as const,
    reporterVersion: "2",
    runId: "run_1",
    generation: 1,
    reporterEpoch: "epoch_1",
  };

  it("defines exactly the nine canonical semantic states", () => {
    expect(AgentStatusStateSchema.options).toEqual([
      "starting",
      "idle",
      "working",
      "waiting",
      "blocked",
      "suspected_stuck",
      "stopped",
      "failed",
      "unknown",
    ]);
  });

  it("accepts normalized correlated tool and wait events", () => {
    expect(
      AgentStatusEventInputSchema.parse({
        ...reporter,
        eventId: "event_1",
        sourceSequence: 1,
        event: "tool.started",
        operationId: "tool_1",
        data: { tool: "Bash" },
      }),
    ).toMatchObject({ event: "tool.started", operationId: "tool_1" });
    expect(
      AgentStatusEventInputSchema.parse({
        ...reporter,
        eventId: "event_2",
        sourceSequence: 2,
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
        ...reporter,
        eventId: "event_1",
        sourceSequence: 1,
        event: "tool.started",
      }).success,
    ).toBe(false);
    expect(
      AgentStatusEventInputSchema.safeParse({
        ...reporter,
        eventId: "event_2",
        sourceSequence: 2,
        event: "session.ready",
        unknownIdentity: "forged",
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
        statusRevision: 4,
        completionRevision: 1,
        operatorAcknowledgedCompletionRevision: 0,
        completionPending: false,
        interactiveReady: true,
        staleAuthority: false,
        authorityKind: "reporter",
        authorityId: "reporter_session_1",
        evidenceConfidence: "high",
        processState: "present",
        reporterEpoch: "epoch_1",
        reporterLeaseExpiresAt: "2026-08-11T12:00:45Z",
        readinessCoverage: "full",
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
        commandSource: "builtin",
      },
      opencode: {
        id: "opencode",
        name: "OpenCode",
        kind: "opencode",
        command: ["opencode"],
        commandSource: "builtin",
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
            commandSource: "builtin",
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
          commandSource: "builtin",
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
          commandSource: "builtin",
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

describe("declarative provider extension contracts", () => {
  const descriptor = {
    apiVersion: "nanasa.dev/provider-extension/v1",
    kind: "ProviderExtension",
    metadata: {
      id: "example.copilot",
      name: "Example Copilot",
      version: "1.2.3",
      publisher: "Example",
      description: "A data-only provider descriptor",
    },
    compatibility: { minNanasaVersion: "0.0.0", reporterProtocol: 2 },
    providers: [
      {
        id: "example-copilot",
        displayName: "Example Copilot",
        commandNames: ["copilot"],
        strategies: {
          adapter: "copilot-adapter-v1",
          home: "copilot-home-v1",
          prompt: "copilot-agent-v1",
          mcp: "copilot-mcp-v1",
          reporter: "copilot-hooks-v2",
          control: "copilot-terminal-v1",
          nativeResume: "copilot-resume-v1",
          provisioning: ["owned-file-v1", "managed-json-object-v1"],
        },
      },
    ],
    permissions: [...REQUIRED_PROVIDER_EXTENSION_PERMISSIONS],
    assets: [
      {
        path: "metadata/provider.json",
        mediaType: "application/json",
        bytes: 3,
        sha256: "a".repeat(64),
      },
    ],
  } as const;

  it("accepts strict data-only descriptors and complete reproducible locks", () => {
    const parsed = ProviderExtensionDescriptorSchema.parse(descriptor);
    expect(parsed.providers[0]?.strategies.adapter).toBe("copilot-adapter-v1");
    expect(
      ExtensionLockSchema.parse({
        version: 1,
        revision: 1,
        extensions: {
          "example.copilot": {
            descriptor: parsed,
            descriptorDigest: "b".repeat(64),
            packageDigest: "c".repeat(64),
            source: { kind: "uploaded", label: "reviewed fixture" },
            signature: {
              algorithm: "ed25519",
              keyId: "fixture-key",
              signature: "A".repeat(86),
            },
            grantedPermissions: [...REQUIRED_PROVIDER_EXTENSION_PERMISSIONS],
            packageReference: ".nanasa/state/extensions/packages/example.copilot/1.2.3/digest",
            enabled: true,
            installedAt: "2026-08-30T00:00:00.000Z",
          },
        },
      }).extensions["example.copilot"]?.enabled,
    ).toBe(true);
  });

  it.each([
    [
      "mixed strategy families",
      {
        providers: [
          {
            ...descriptor.providers[0],
            strategies: { ...descriptor.providers[0].strategies, reporter: "pi-events-v2" },
          },
        ],
      },
    ],
    ["missing derived permission", { permissions: descriptor.permissions.slice(1) }],
    ["wildcard permission", { permissions: ["*"] }],
    ["JavaScript asset", { assets: [{ ...descriptor.assets[0], path: "assets/hook.mjs" }] }],
    ["traversing asset", { assets: [{ ...descriptor.assets[0], path: "../provider.json" }] }],
    ["executable declaration", { build: ["node", "build.js"] }],
    ["portal declaration", { portal: { component: "index.js" } }],
  ])("rejects %s", (_name, override) => {
    expect(
      ProviderExtensionDescriptorSchema.safeParse({ ...descriptor, ...override }).success,
    ).toBe(false);
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
      expectedOrderRevision: 3,
    };
    expect(ReorderGroupAgentsCommandSchema.parse(reordered)).toEqual(reordered);
    expect(
      ReorderGroupAgentsCommandSchema.safeParse({
        agentIds: ["agent_one", "agent_one"],
        expectedOrderRevision: 3,
      }).success,
    ).toBe(false);
    expect(
      ReorderGroupAgentsResultSchema.parse({
        groupId: "group_1",
        agentIds: reordered.agentIds,
        orderRevision: 4,
      }),
    ).toEqual({ groupId: "group_1", agentIds: reordered.agentIds, orderRevision: 4 });
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
