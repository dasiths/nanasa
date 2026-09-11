import type {
  AgentAction,
  AgentActionPrincipal,
  CreateAgentActionCommand,
  OpenWait,
  OpenWaitReply,
} from "@nanasa/contracts";
import { DomainError } from "../store.js";

export class PeerCapabilityPolicy {
  public constructor(
    private readonly missionAuthorization?: (
      principal: Extract<AgentActionPrincipal, { kind: "foreman" }>,
      command: CreateAgentActionCommand,
    ) => void,
  ) {}

  public assertCreate(principal: AgentActionPrincipal, command: CreateAgentActionCommand): void {
    if (principal.kind === "operator") return;
    if (principal.kind === "foreman") {
      if (
        this.missionAuthorization === undefined ||
        command.kind !== "prompt" ||
        command.allowWorking
      )
        this.#forbidden("unapproved mission actions");
      this.missionAuthorization(principal, command);
      return;
    }
    if (principal.groupId !== command.groupId) this.#forbidden("another group");
    if (principal.memberId === command.memberId) this.#forbidden("its own runtime");
    if (command.allowWorking) this.#forbidden("working-target overrides");
  }

  public assertRead(principal: AgentActionPrincipal, action: AgentAction): void {
    if (principal.kind === "operator") return;
    if (principal.kind === "foreman") {
      if (
        action.principal.kind !== "foreman" ||
        action.principal.foremanId !== principal.foremanId ||
        action.principal.missionId !== principal.missionId ||
        action.principal.taskId !== principal.taskId
      )
        this.#forbidden("another mission's action");
      return;
    }
    if (
      action.principal.kind !== "agent" ||
      action.principal.runId !== principal.runId ||
      action.principal.generation !== principal.generation
    ) {
      this.#forbidden("another principal's action");
    }
  }

  public assertCancel(principal: AgentActionPrincipal, action: AgentAction): void {
    this.assertRead(principal, action);
  }

  public assertOwnWaits(principal: AgentActionPrincipal, groupId: string, memberId: string): void {
    if (principal.kind === "operator") return;
    if (principal.kind === "foreman") this.#forbidden("unapproved worker waits");
    if (principal.groupId !== groupId || principal.memberId !== memberId) {
      this.#forbidden("another agent's waits");
    }
  }

  public assertReply(principal: AgentActionPrincipal, wait: OpenWait, reply: OpenWaitReply): void {
    if (principal.kind === "operator") return;
    if (principal.kind === "foreman") this.#forbidden("unapproved worker wait replies");
    if (principal.groupId !== wait.groupId || principal.memberId !== wait.memberId) {
      this.#forbidden("another agent's wait");
    }
    if (wait.kind === "permission" || wait.kind === "plan_approval") {
      this.#forbidden("permission or plan approval");
    }
    if (reply.kind !== "answer" && reply.kind !== "select") {
      this.#forbidden("privileged wait decisions");
    }
  }

  public assertNoPeerTerminalOrRunControl(principal: AgentActionPrincipal): void {
    if (principal.kind !== "operator") {
      this.#forbidden("arbitrary keys, unrestricted terminal reads, or peer run control");
    }
  }

  #forbidden(subject: string): never {
    throw new DomainError(
      "peer_capability_forbidden",
      `Peer agents cannot control ${subject} by default`,
      403,
    );
  }
}
