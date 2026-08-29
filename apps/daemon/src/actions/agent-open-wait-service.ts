import type { AgentActionPrincipal, OpenWait, ReplyOpenWaitCommand } from "@nanasa/contracts";
import { ReplyOpenWaitCommandSchema } from "@nanasa/contracts";
import { ProviderAdapterRegistry } from "../providers/provider-adapter-registry.js";
import type { RuntimeObservation } from "../runtime-observation.js";
import { DomainError, type NanasaStore } from "../store.js";
import type { TerminalInputArbiter } from "../terminal/terminal-input-arbiter.js";
import { PeerCapabilityPolicy } from "./peer-capability-policy.js";

interface WaitReplyRuntime {
  observeRun(run: Parameters<NanasaStore["createRun"]>[0]): Promise<RuntimeObservation>;
  pasteToRun(run: Parameters<NanasaStore["createRun"]>[0], text: string): Promise<void>;
}

export class AgentOpenWaitService {
  public constructor(
    private readonly store: NanasaStore,
    private readonly runtime: WaitReplyRuntime,
    private readonly arbiter: TerminalInputArbiter,
    private readonly adapters = ProviderAdapterRegistry.builtIn(),
    private readonly policy = new PeerCapabilityPolicy(),
  ) {}

  public list(principal: AgentActionPrincipal, groupId: string, memberId?: string): OpenWait[] {
    if (memberId !== undefined) this.policy.assertOwnWaits(principal, groupId, memberId);
    else if (principal.kind === "agent")
      this.policy.assertOwnWaits(principal, groupId, principal.memberId);
    return this.store
      .listOpenWaits(
        groupId,
        memberId ?? (principal.kind === "agent" ? principal.memberId : undefined),
      )
      .filter((wait) => ["open", "replying"].includes(wait.state));
  }

  public async reply(
    principal: AgentActionPrincipal,
    waitId: string,
    command: ReplyOpenWaitCommand,
  ): Promise<OpenWait> {
    const input = ReplyOpenWaitCommandSchema.parse(command);
    const wait = this.store.getOpenWait(waitId);
    this.policy.assertReply(principal, wait, input.reply);
    const run = this.store.getActiveRun(wait.groupId, wait.memberId);
    if (
      run?.id !== wait.runId ||
      run.generation !== wait.generation ||
      run.terminal === undefined
    ) {
      throw new DomainError("open_wait_replaced", "The wait target run was replaced", 409);
    }
    const profile = this.store.getAgentProfile(run.agentProfileId);
    const strategy = this.adapters.get(profile.kind).control;
    if (
      !strategy.waitReplyChannels.includes(wait.replyChannel) &&
      !strategy.waitReplyChannels.includes("terminal")
    ) {
      throw new DomainError(
        "open_wait_reply_channel_unsupported",
        "The provider does not expose a reviewed reply channel for this wait",
        409,
      );
    }
    const replying = this.store.beginOpenWaitReply(wait.id, {
      runId: input.expectedRunId,
      generation: input.expectedGeneration,
      reporterEpoch: input.expectedReporterEpoch,
      statusRevision: input.expectedStatusRevision,
    });
    try {
      const observation = await this.runtime.observeRun(run);
      if (observation.state !== "present") {
        throw new DomainError(
          observation.state === "indeterminate"
            ? "open_wait_process_indeterminate"
            : "open_wait_replaced",
          "The exact wait target process is not current",
          409,
        );
      }
      const terminalInput = strategy.waitReplyInput(wait.kind, input.reply);
      await this.arbiter.dispatchAutomated(run.id, () =>
        this.runtime.pasteToRun(run, terminalInput),
      );
      return replying;
    } catch (error) {
      this.store.resetOpenWaitReply(wait.id);
      throw error;
    }
  }
}
