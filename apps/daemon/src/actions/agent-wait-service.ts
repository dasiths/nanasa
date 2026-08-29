import type {
  AgentAction,
  AgentActionPrincipal,
  WaitForAgentActionCommand,
} from "@nanasa/contracts";
import { WaitForAgentActionCommandSchema } from "@nanasa/contracts";
import type { NanasaStore } from "../store.js";
import { PeerCapabilityPolicy } from "./peer-capability-policy.js";

export interface AgentActionWaitResult {
  action: AgentAction;
  matched: boolean;
  timedOut: boolean;
}

export class AgentWaitService {
  public constructor(
    private readonly store: NanasaStore,
    private readonly policy = new PeerCapabilityPolicy(),
  ) {}

  public async wait(
    principal: AgentActionPrincipal,
    actionId: string,
    command: WaitForAgentActionCommand,
  ): Promise<AgentActionWaitResult> {
    const input = WaitForAgentActionCommandSchema.parse(command);
    const initial = this.store.getAgentAction(actionId);
    this.policy.assertRead(principal, initial);
    if (input.states.includes(initial.state)) {
      return { action: initial, matched: true, timedOut: false };
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: AgentActionWaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const inspect = () => {
        const action = this.store.getAgentAction(actionId);
        this.policy.assertRead(principal, action);
        if (input.states.includes(action.state)) {
          finish({ action, matched: true, timedOut: false });
        }
      };
      const unsubscribe = this.store.onEvent((event) => {
        if (event.aggregateType === "agent-action" && event.aggregateId === actionId) inspect();
      });
      const timer = setTimeout(() => {
        finish({ action: this.store.getAgentAction(actionId), matched: false, timedOut: true });
      }, input.timeoutMs);
      timer.unref();
      inspect();
    });
  }
}
