import { describe, expect, it } from "vitest";

import {
  AgentCapabilitySchema,
  AgentRunSchema,
  ConfigStatusSchema,
  CreateAgentProfileCommandSchema,
  DeliveryModeSchema,
  InterruptAgentRunCommandSchema,
  MessageSchema,
  NanasaConfigSchema,
  StartAgentRunCommandSchema,
  SubmitMessageCommandSchema,
  TerminalEndpointStatusSchema,
} from "../src/index.js";

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
  delivery: {
    mode: "steer",
  },
  hop: 0,
  createdAt: "2026-08-09T15:00:00Z",
} as const;

describe("message policy contracts", () => {
  it("accepts queue, steer, and terminal delivery without a caller-selected fallback", () => {
    expect(MessageSchema.safeParse(baseMessage).success).toBe(true);
    expect(DeliveryModeSchema.parse("terminal")).toBe("terminal");
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        delivery: { mode: "terminal" },
      }).success,
    ).toBe(true);
    expect(
      SubmitMessageCommandSchema.safeParse({
        ...baseMessage,
        id: undefined,
        groupId: undefined,
        groupSeq: undefined,
        createdAt: undefined,
      }).success,
    ).toBe(true);
  });

  it("defines interrupt as a separate privileged run command", () => {
    expect(
      InterruptAgentRunCommandSchema.parse({ operatorId: "operator_1", reason: "New priority" }),
    ).toEqual({ operatorId: "operator_1", reason: "New priority" });
  });

  it.each([
    ["inbox mode", { delivery: { mode: "inbox" } }],
    ["interrupt mode", { delivery: { mode: "interrupt" } }],
    ["fallback", { delivery: { mode: "steer", fallback: "queue" } }],
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

describe("agent run contracts", () => {
  it("creates profiles by configured agent type only", () => {
    expect(
      CreateAgentProfileCommandSchema.parse({
        name: "Claude reviewer",
        agentType: "claude-copilot",
      }),
    ).toEqual({
      name: "Claude reviewer",
      agentType: "claude-copilot",
    });
    expect(
      CreateAgentProfileCommandSchema.safeParse({
        name: "Unsafe",
        agentType: "copilot",
        command: "sh",
      }).success,
    ).toBe(false);
    expect(StartAgentRunCommandSchema.parse({})).toEqual({ cols: 120, rows: 40 });
  });

  it("tracks desired state, recovery phase, and adapter session metadata", () => {
    expect(
      AgentRunSchema.parse({
        id: "run_1",
        groupId: "group_1",
        memberId: "member_1",
        agentProfileId: "profile_1",
        generation: 1,
        status: "running",
        desiredState: "running",
        recoveryPhase: "recovered",
        adapterSession: {
          adapter: "copilot-cli",
          sessionId: "session_1",
          updatedAt: "2026-08-10T12:00:00Z",
        },
        startedAt: "2026-08-10T12:00:00Z",
      }),
    ).toMatchObject({ desiredState: "running", recoveryPhase: "recovered" });
  });
});

describe("configuration contracts", () => {
  const config = {
    version: 1,
    agentTypes: {
      copilot: {
        key: "copilot",
        name: "GitHub Copilot",
        kind: "copilot",
        adapter: "copilot-cli",
        command: ["copilot"],
        environment: {},
        recovery: "resume-or-restart",
        capabilities: ["queue"],
      },
      opencode: {
        key: "opencode",
        name: "OpenCode",
        kind: "opencode",
        adapter: "terminal",
        command: ["opencode"],
        environment: {},
        recovery: "restart",
        capabilities: ["queue"],
      },
    },
  } as const;

  it("accepts normalized agent types and rejects unsafe capability combinations", () => {
    expect(AgentCapabilitySchema.safeParse("terminal").success).toBe(false);
    expect(NanasaConfigSchema.parse(config)).toEqual(config);
    expect(
      NanasaConfigSchema.safeParse({
        ...config,
        agentTypes: {
          ...config.agentTypes,
          opencode: {
            ...config.agentTypes.opencode,
            capabilities: ["queue", "steer"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      NanasaConfigSchema.safeParse({
        ...config,
        agentTypes: {
          ...config.agentTypes,
          copilot: {
            ...config.agentTypes.copilot,
            capabilities: ["queue", "steer"],
          },
        },
      }).success,
    ).toBe(false);
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
