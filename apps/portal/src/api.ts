import {
  type AddGroupMembershipCommand,
  AddGroupMembershipCommandSchema,
  type AgentProfile,
  AgentProfileSchema,
  type AgentRun,
  AgentRunSchema,
  type CreateAgentProfileCommand,
  CreateAgentProfileCommandSchema,
  type CreateGroupCommand,
  CreateGroupCommandSchema,
  type EffectiveDeliveryModes,
  type EffectiveDeliveryModesCommand,
  EffectiveDeliveryModesCommandSchema,
  EffectiveDeliveryModesSchema,
  type Group,
  type GroupMembership,
  GroupMembershipSchema,
  GroupSchema,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type NanasaConfig,
  NanasaConfigSchema,
  type PortalSnapshot,
  PortalSnapshotSchema,
  type StartGroupRunsResult,
  StartGroupRunsResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
  type TerminalEndpointStatus,
  TerminalEndpointStatusSchema,
} from "@nanasa/contracts";

interface Schema<T> {
  parse(value: unknown): T;
}

export class ApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface PortalClient {
  loadSnapshot(): Promise<PortalSnapshot>;
  loadConfig(): Promise<NanasaConfig>;
  createGroup(command: CreateGroupCommand): Promise<Group>;
  createAgentProfile(command: CreateAgentProfileCommand): Promise<AgentProfile>;
  addMembership(groupId: string, command: AddGroupMembershipCommand): Promise<GroupMembership>;
  startRun(groupId: string, memberId: string): Promise<AgentRun>;
  startAllRuns(groupId: string, idempotencyKey: string): Promise<StartGroupRunsResult>;
  stopRun(groupId: string, memberId: string): Promise<AgentRun>;
  submitMessage(groupId: string, command: SubmitMessageCommand): Promise<MessageSubmissionResult>;
  getEffectiveDeliveryModes(
    groupId: string,
    command: EffectiveDeliveryModesCommand,
  ): Promise<EffectiveDeliveryModes>;
  getTerminalEndpointStatus(runId: string): Promise<TerminalEndpointStatus>;
  createEventsSocket(afterSequence: number): WebSocket;
}

function websocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String(payload.message)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return schema.parse(payload);
}

function commandInit(
  method: "POST" | "DELETE",
  body: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  };
}

export const api: PortalClient = {
  loadSnapshot: () => request("/api/snapshot", PortalSnapshotSchema),
  loadConfig: () => request("/api/config", NanasaConfigSchema),
  createGroup: (command) =>
    request(
      "/api/groups",
      GroupSchema,
      commandInit("POST", CreateGroupCommandSchema.parse(command)),
    ),
  createAgentProfile: (command) =>
    request(
      "/api/agent-profiles",
      AgentProfileSchema,
      commandInit("POST", CreateAgentProfileCommandSchema.parse(command)),
    ),
  addMembership: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships`,
      GroupMembershipSchema,
      commandInit("POST", AddGroupMembershipCommandSchema.parse(command)),
    ),
  startRun: (groupId, memberId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(memberId)}/run`,
      AgentRunSchema,
      commandInit("POST", {}),
    ),
  startAllRuns: (groupId, idempotencyKey) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/runs/start-all`,
      StartGroupRunsResultSchema,
      commandInit("POST", {}, idempotencyKey),
    ),
  stopRun: (groupId, memberId) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(memberId)}/run`,
      AgentRunSchema,
      commandInit("DELETE", {}),
    ),
  submitMessage: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/messages`,
      MessageSubmissionResultSchema,
      commandInit("POST", SubmitMessageCommandSchema.parse(command)),
    ),
  getEffectiveDeliveryModes: (groupId, command) =>
    request(
      `/api/groups/${encodeURIComponent(groupId)}/delivery-modes`,
      EffectiveDeliveryModesSchema,
      commandInit("POST", EffectiveDeliveryModesCommandSchema.parse(command)),
    ),
  getTerminalEndpointStatus: (runId) =>
    request(`/api/runs/${encodeURIComponent(runId)}/terminal`, TerminalEndpointStatusSchema),
  createEventsSocket: (afterSequence) =>
    new WebSocket(websocketUrl(`/api/events?after=${afterSequence}`)),
};
