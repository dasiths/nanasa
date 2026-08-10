import type {
  AdapterKind,
  AgentAdapterStatus,
  AgentProfile,
  AgentRun,
  DeliveryMode,
  Message,
} from "@nanasa/contracts";

export type AdapterReadiness = AgentAdapterStatus["readiness"];

export interface AdapterLifecycleState {
  readiness: AdapterReadiness;
  reason?: string;
}

export interface AdapterStartContext {
  run: AgentRun;
  profile: AgentProfile;
}

export interface AdapterDelivery {
  message: Message;
  run: AgentRun;
  profile: AgentProfile;
  mode: DeliveryMode;
}

export interface AdapterSettlement {
  status: "processed" | "failed";
  reason?: string;
}

export interface AdapterDeliveryResult {
  appliedMode: DeliveryMode;
  adapterSessionId?: string;
  adapterMessageId?: string;
  settlement?: Promise<AdapterSettlement>;
}

export interface AgentAdapter {
  readonly kind: AdapterKind;
  readonly capabilities: ReadonlySet<DeliveryMode>;
  readonly state: AdapterLifecycleState;
  start(context: AdapterStartContext): Promise<void>;
  reconcile(context: AdapterStartContext): Promise<void>;
  deliver(delivery: AdapterDelivery): Promise<AdapterDeliveryResult>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

export type AgentAdapterFactory = (context: AdapterStartContext) => AgentAdapter;
