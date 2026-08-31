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
    this.store.beginOpenWaitReply(wait.id, {
      runId: input.expectedRunId,
      generation: input.expectedGeneration,
      reporterEpoch: input.expectedReporterEpoch,
      statusRevision: input.expectedStatusRevision,
    });
    try {
      const terminalInput = strategy.waitReplyInput(wait.kind, input.reply);
      await this.arbiter.dispatchAutomated(run.id, async () => {
        const currentWait = this.store.getOpenWait(wait.id);
        const currentRun = this.store.getActiveRun(wait.groupId, wait.memberId);
        const status = this.store.getAgentStatus(wait.groupId, wait.memberId);
        const reporter = this.store.getCurrentReporterSession(run.id, run.generation);
        const now = Date.now();
        if (
          currentWait.state !== "replying" ||
          currentRun?.id !== wait.runId ||
          currentRun.generation !== wait.generation ||
          reporter?.id !== wait.reporterSessionId ||
          reporter.reporterEpoch !== wait.reporterEpoch ||
          status.authorityKind !== "reporter" ||
          status.staleAuthority ||
          status.reporterEpoch !== wait.reporterEpoch ||
          status.reporterLeaseExpiresAt === undefined ||
          Date.parse(status.reporterLeaseExpiresAt) <= now ||
          status.transportLeaseExpiresAt === undefined ||
          Date.parse(status.transportLeaseExpiresAt) <= now
        ) {
          throw new DomainError("open_wait_replaced", "The exact wait target was replaced", 409);
        }
        const observation = await this.runtime.observeRun(run);
        if (
          observation.state !== "present" ||
          observation.process?.expectedProviderMatch !== "match" ||
          observation.process.processFingerprint !== status.processFingerprint ||
          observation.process.processFingerprint !== reporter.processFingerprint
        ) {
          throw new DomainError(
            observation.state === "indeterminate"
              ? "open_wait_process_indeterminate"
              : "open_wait_replaced",
            "The exact wait target process is not current",
            409,
          );
        }
        const finalWait = this.store.getOpenWait(wait.id);
        const finalStatus = this.store.getAgentStatus(wait.groupId, wait.memberId);
        const finalReporter = this.store.getCurrentReporterSession(run.id, run.generation);
        const finalNow = Date.now();
        if (
          finalWait.state !== "replying" ||
          finalReporter?.id !== wait.reporterSessionId ||
          finalReporter.reporterEpoch !== wait.reporterEpoch ||
          finalReporter.processFingerprint !== observation.process.processFingerprint ||
          finalStatus.authorityKind !== "reporter" ||
          finalStatus.staleAuthority ||
          finalStatus.reporterEpoch !== wait.reporterEpoch ||
          finalStatus.reporterLeaseExpiresAt === undefined ||
          Date.parse(finalStatus.reporterLeaseExpiresAt) <= finalNow ||
          finalStatus.transportLeaseExpiresAt === undefined ||
          Date.parse(finalStatus.transportLeaseExpiresAt) <= finalNow
        ) {
          throw new DomainError(
            "open_wait_replaced",
            "The exact wait target changed during process verification",
            409,
          );
        }
        await this.runtime.pasteToRun(run, terminalInput);
      });
      const completed = this.store.getOpenWait(wait.id);
      if (completed.state !== "replying") {
        throw new DomainError(
          "open_wait_replaced",
          "The exact wait changed after terminal input began",
          409,
        );
      }
      return completed;
    } catch (error) {
      this.store.resetOpenWaitReply(wait.id);
      throw error;
    }
  }
}
