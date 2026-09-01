import { createHash } from "node:crypto";
import type { AgentKind, AgentWaitKind, OpenWaitReply } from "@nanasa/contracts";
import { describe, expect, it } from "vitest";
import type { EffectiveAgentPrompt } from "../src/instruction-resolver.js";
import { appendProviderArguments } from "../src/providers/provider-adapter.js";
import { ProviderAdapterRegistry } from "../src/providers/provider-adapter-registry.js";

const registry = ProviderAdapterRegistry.builtIn({
  piMcpAdapterPath: "/runtime/pi-mcp-adapter/index.ts",
});

const prompt: EffectiveAgentPrompt = {
  roleId: "reviewer",
  role: {
    name: "Reviewer",
    instructions: [],
    permissionPolicy: "read-only",
  },
  text: "Coordinate through Nanasa.\nReview without editing.\n",
  revision: "a".repeat(64),
  sources: [{ scope: "builtin", reference: "builtin:nanasa-coordination-v1" }],
};

const providers = [
  { id: "copilot", command: ["copilot"] },
  { id: "claude-code", command: ["claude"] },
  { id: "pi", command: ["pi"] },
  { id: "opencode", command: ["opencode"] },
] as const satisfies ReadonlyArray<{ id: AgentKind; command: readonly string[] }>;

const waitReplies = [
  ["permission", { kind: "allow-once" }],
  ["question", { kind: "answer", text: "answer" }],
  ["elicitation", { kind: "select", option: "choice" }],
  ["plan_approval", { kind: "approve-plan" }],
] as const satisfies ReadonlyArray<readonly [AgentWaitKind, OpenWaitReply]>;

function digest(content: string): string {
  return createHash("sha256").update(content.replaceAll(process.execPath, "<NODE>")).digest("hex");
}

describe("table-driven built-in launch characterization", () => {
  it.each(providers)("freezes the complete $id launch plan", ({ id, command }) => {
    const adapter = registry.get(id);
    const stateRoot = `/state/${id}`;
    const overlayRoot = `/overlay/${id}`;
    const full = adapter.planOverlay({
      membershipId: "membership-one",
      memberAlias: "Reviewer One",
      stateRoot,
      overlayRoot,
      mcpEndpointUrl: "https://127.0.0.1:3210/mcp",
      statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
      prompt,
      readOnly: true,
    });
    const noMcp = adapter.planOverlay({
      membershipId: "membership-one",
      memberAlias: "Reviewer One",
      stateRoot,
      overlayRoot,
      statusEndpointUrl: "http://127.0.0.1:3210/api/v1/agent-status/events",
      prompt,
      readOnly: true,
    });
    const nativeSession = adapter.normalizeNativeSession(
      {
        source: adapter.reporter.source,
        referenceKind: "id",
        referenceValue: "session-one",
      },
      stateRoot,
    );
    const model = "provider/model-one";
    const plan = {
      provider: id,
      recognition: {
        direct: adapter.recognizeCommand(command),
        path: adapter.recognizeCommand([`/opt/bin/${command[0]}`]),
        claudeMakeWrapper: adapter.recognizeCommand(["make", "claude-copilot"]),
        unrelated: adapter.recognizeCommand(["node", "worker.mjs"]),
      },
      freshCommand: appendProviderArguments(command, [
        ...full.commandArguments,
        ...adapter.modelArguments(model),
      ]),
      preserveSessionCommand: appendProviderArguments(command, [
        ...full.commandArguments,
        ...adapter.resumeArguments(nativeSession),
      ]),
      enforceConfiguredSessionCommand: appendProviderArguments(command, [
        ...full.commandArguments,
        ...adapter.resumeArguments(nativeSession, model),
      ]),
      wrapperCommand:
        id === "claude-code"
          ? appendProviderArguments(
              ["make", "claude-copilot"],
              [...full.commandArguments, ...adapter.modelArguments(model)],
            )
          : undefined,
      stateEnvironment: adapter.stateEnvironment(stateRoot),
      overlayEnvironment: full.environment,
      environmentNames: Object.keys({
        ...adapter.stateEnvironment(stateRoot),
        ...full.environment,
      }).sort(),
      credentialEnvironmentNames: adapter.credentialEnvironmentNames(),
      reporter: adapter.reporter,
      controls: {
        ...adapter.control,
        waitReplyInput: waitReplies.map(([kind, reply]) => [
          kind,
          reply.kind,
          adapter.control.waitReplyInput(kind, reply),
        ]),
      },
      nativeSession: {
        referenceKind: nativeSession.referenceKind,
        referenceValue: nativeSession.referenceValue,
        resumeArguments: adapter.resumeArguments(nativeSession),
        enforceConfiguredResumeArguments: adapter.resumeArguments(nativeSession, model),
      },
      piContainedPath:
        id === "pi"
          ? adapter.normalizeNativeSession(
              {
                source: "pi",
                referenceKind: "path",
                referenceValue: `${stateRoot}/sessions/one.jsonl`,
              },
              stateRoot,
            ).referenceValue
          : undefined,
      fullOverlay: {
        commandArguments: full.commandArguments,
        generatedIdentities: full.generatedIdentities,
        files: full.files.map((file) => ({
          relativePath: file.relativePath,
          mode: file.mode ?? 0o600,
          ownerKind: file.ownerKind,
          bytes: Buffer.byteLength(file.content),
          sha256: digest(file.content),
        })),
      },
      mcpDisabledOverlay: {
        commandArguments: noMcp.commandArguments,
        environment: noMcp.environment,
        generatedIdentities: noMcp.generatedIdentities,
        files: noMcp.files.map((file) => ({
          relativePath: file.relativePath,
          mode: file.mode ?? 0o600,
          ownerKind: file.ownerKind,
          bytes: Buffer.byteLength(file.content),
          sha256: digest(file.content),
        })),
      },
    };

    expect(plan).toMatchSnapshot();
  });
});
