import { z } from "zod";
import { ErrorPayloadSchema, IdentifierSchema, TimestampSchema } from "./control.js";
import { CustomLaunchConsentRequestSchema } from "./launch-consent.js";
import { AgentWaitKindSchema } from "./status.js";

export const MAX_MESSAGE_TEXT_BYTES = 1_048_576;
export const MAX_MESSAGE_REQUEST_BYTES = 6_356_992;
export const DEFAULT_MESSAGE_PAGE_SIZE = 20;
export const MAX_MESSAGE_PAGE_SIZE = 100;
export const OVERSIZED_MESSAGE_GUIDANCE =
  "Save large content in a file inside the repository checkout shared by the recipients, then send its repository-relative path. Do not send an absolute path or a path outside the repository.";

export const StartAgentRunCommandSchema = z
  .object({
    cols: z.number().int().min(20).max(1_000).default(120),
    rows: z.number().int().min(5).max(1_000).default(40),
  })
  .strict();
export type StartAgentRunCommand = z.infer<typeof StartAgentRunCommandSchema>;
export const StartGroupRunsCommandSchema = StartAgentRunCommandSchema;
export type StartGroupRunsCommand = z.infer<typeof StartGroupRunsCommandSchema>;
export const StartGroupRunOutcomeSchema = z
  .object({
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    status: z.enum(["started", "already-running", "approval-required", "denied", "failed"]),
    runId: IdentifierSchema.optional(),
    request: CustomLaunchConsentRequestSchema.optional(),
    reason: z.string().min(1).optional(),
    error: ErrorPayloadSchema.optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (["approval-required", "denied"].includes(outcome.status) && outcome.request === undefined) {
      context.addIssue({
        code: "custom",
        message: `${outcome.status} outcomes require a launch consent request`,
        path: ["request"],
      });
    }
  });
export const StartGroupRunsResultSchema = z
  .object({ groupId: IdentifierSchema, outcomes: z.array(StartGroupRunOutcomeSchema) })
  .strict();
export type StartGroupRunOutcome = z.infer<typeof StartGroupRunOutcomeSchema>;
export type StartGroupRunsResult = z.infer<typeof StartGroupRunsResultSchema>;
export const StopAgentRunCommandSchema = z.object({ force: z.boolean().default(false) }).strict();
export type StopAgentRunCommand = z.infer<typeof StopAgentRunCommandSchema>;
export const InterruptAgentRunCommandSchema = z
  .object({
    operatorId: IdentifierSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type InterruptAgentRunCommand = z.infer<typeof InterruptAgentRunCommandSchema>;

export const MAX_MESSAGE_FAN_OUT = 32;
export const MAX_MESSAGE_CAUSAL_DEPTH = 8;
export const MAX_AUTOMATED_REPLIES_PER_CONVERSATION = 16;

export const AgentActionKindSchema = z.enum(["prompt", "wait", "wait-reply", "cancel"]);
export const AgentActionStateSchema = z.enum([
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
export type AgentActionState = z.infer<typeof AgentActionStateSchema>;
export const AgentActionPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), operatorId: IdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      groupId: IdentifierSchema,
      memberId: IdentifierSchema,
      runId: IdentifierSchema,
      generation: z.number().int().positive(),
    })
    .strict(),
]);
export type AgentActionPrincipal = z.infer<typeof AgentActionPrincipalSchema>;
export const AgentActionTargetSchema = z
  .object({
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    daemonEpoch: z.number().int().positive(),
    reporterSessionId: IdentifierSchema,
    reporterId: IdentifierSchema,
    reporterEpoch: IdentifierSchema,
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    baselineStatusRevision: z.number().int().nonnegative(),
    baselineCompletionRevision: z.number().int().nonnegative(),
  })
  .strict();
export type AgentActionTarget = z.infer<typeof AgentActionTargetSchema>;
export const AgentActionErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict();
export const AgentActionSchema = z
  .object({
    version: z.literal(1),
    id: IdentifierSchema,
    kind: AgentActionKindSchema,
    principal: AgentActionPrincipalSchema,
    target: AgentActionTargetSchema,
    messageId: IdentifierSchema.optional(),
    conversationId: IdentifierSchema.optional(),
    replyToActionId: IdentifierSchema.optional(),
    causationId: IdentifierSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(256),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    prompt: z.string().min(1).max(MAX_MESSAGE_TEXT_BYTES).optional(),
    allowWorking: z.boolean(),
    state: AgentActionStateSchema,
    queueDeadlineAt: TimestampSchema,
    acceptanceDeadlineAt: TimestampSchema.optional(),
    completionDeadlineAt: TimestampSchema.optional(),
    acceptedProviderTurnId: IdentifierSchema.optional(),
    acceptedProviderRequestId: IdentifierSchema.optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: AgentActionErrorSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((action, context) => {
    if (action.kind === "prompt" && action.prompt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Prompt actions require prompt text",
        path: ["prompt"],
      });
    }
  });
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentActionAttemptStateSchema = z.enum([
  "submitting",
  "submitted",
  "failed",
  "stalled",
  "cancelled",
  "superseded",
  "rejected",
]);
export const AgentActionAttemptSchema = z
  .object({
    id: IdentifierSchema,
    actionId: IdentifierSchema,
    attempt: z.number().int().positive(),
    effect: z.enum(["provider-api", "terminal-injection", "logical-reply"]),
    state: AgentActionAttemptStateSchema,
    daemonEpoch: z.number().int().positive(),
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterSessionId: IdentifierSchema,
    reporterId: IdentifierSchema,
    reporterEpoch: IdentifierSchema,
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    baselineStatusRevision: z.number().int().nonnegative(),
    baselineCompletionRevision: z.number().int().nonnegative(),
    terminalBinding: z
      .object({
        serverName: z.string().trim().min(1),
        sessionId: z.string().trim().min(1),
        windowId: z.string().regex(/^@[0-9]+$/),
        paneId: z.string().regex(/^%[0-9]+$/),
      })
      .strict(),
    terminalBindingFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    providerTurnId: IdentifierSchema.optional(),
    providerRequestId: IdentifierSchema.optional(),
    leaseOwner: IdentifierSchema,
    leaseExpiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    submittedAt: TimestampSchema.optional(),
    failureCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type AgentActionAttempt = z.infer<typeof AgentActionAttemptSchema>;
export const AgentActionAcknowledgementKindSchema = z.enum([
  "accepted",
  "started",
  "blocked",
  "completed",
  "settled-unverified",
  "failed",
  "cancelled",
]);
export const AgentActionAcknowledgementSchema = z
  .object({
    id: IdentifierSchema,
    actionId: IdentifierSchema,
    attemptId: IdentifierSchema,
    kind: AgentActionAcknowledgementKindSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterSessionId: IdentifierSchema,
    reporterId: IdentifierSchema,
    reporterEpoch: IdentifierSchema,
    sourceSequence: z.number().int().positive(),
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    providerTurnId: IdentifierSchema.optional(),
    providerRequestId: IdentifierSchema.optional(),
    completionRevision: z.number().int().nonnegative(),
    acknowledgedAt: TimestampSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AgentActionAcknowledgement = z.infer<typeof AgentActionAcknowledgementSchema>;
export const AgentActionAcknowledgementCommandSchema = AgentActionAcknowledgementSchema.omit({
  id: true,
  actionId: true,
  attemptId: true,
  runId: true,
  generation: true,
  reporterSessionId: true,
  reporterId: true,
  reporterEpoch: true,
  nativeSessionId: true,
  acknowledgedAt: true,
});
export type AgentActionAcknowledgementCommand = z.infer<
  typeof AgentActionAcknowledgementCommandSchema
>;

export const OpenWaitStateSchema = z.enum([
  "open",
  "replying",
  "answered",
  "expired",
  "cancelled",
  "superseded",
]);
export const OpenWaitSchema = z
  .object({
    id: IdentifierSchema,
    actionId: IdentifierSchema.optional(),
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterSessionId: IdentifierSchema,
    reporterId: IdentifierSchema,
    reporterEpoch: IdentifierSchema,
    nativeSessionId: z.string().trim().min(1).max(4_096).optional(),
    providerRequestId: IdentifierSchema,
    kind: AgentWaitKindSchema,
    summary: z.string().trim().min(1).max(512),
    replyChannel: z.enum(["terminal", "hook", "rpc", "acp", "api"]),
    openedStatusRevision: z.number().int().nonnegative(),
    state: OpenWaitStateSchema,
    expiresAt: TimestampSchema.optional(),
    openedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    answeredAt: TimestampSchema.optional(),
  })
  .strict();
export type OpenWait = z.infer<typeof OpenWaitSchema>;

export const OpenWaitReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), text: z.string().trim().min(1).max(8_192) }).strict(),
  z.object({ kind: z.literal("allow-once") }).strict(),
  z.object({ kind: z.literal("deny") }).strict(),
  z.object({ kind: z.literal("approve-plan") }).strict(),
  z.object({ kind: z.literal("reject-plan") }).strict(),
  z.object({ kind: z.literal("select"), option: z.string().trim().min(1).max(256) }).strict(),
]);
export type OpenWaitReply = z.infer<typeof OpenWaitReplySchema>;
export const ReplyOpenWaitCommandSchema = z
  .object({
    expectedRunId: IdentifierSchema,
    expectedGeneration: z.number().int().positive(),
    expectedReporterEpoch: IdentifierSchema,
    expectedStatusRevision: z.number().int().nonnegative(),
    reply: OpenWaitReplySchema,
  })
  .strict();
export type ReplyOpenWaitCommand = z.infer<typeof ReplyOpenWaitCommandSchema>;

export const CreateAgentActionCommandSchema = z
  .object({
    kind: z.enum(["prompt", "wait"]).default("prompt"),
    groupId: IdentifierSchema,
    memberId: IdentifierSchema,
    prompt: z.string().trim().min(1).max(MAX_MESSAGE_TEXT_BYTES).optional(),
    messageId: IdentifierSchema.optional(),
    conversationId: IdentifierSchema.optional(),
    replyToActionId: IdentifierSchema.optional(),
    causationId: IdentifierSchema.optional(),
    allowWorking: z.boolean().default(false),
    expectedRunId: IdentifierSchema.optional(),
    expectedGeneration: z.number().int().positive().optional(),
    expectedStatusRevision: z.number().int().nonnegative().optional(),
    queueTimeoutMs: z.number().int().min(1_000).max(86_400_000).default(300_000),
    acceptanceTimeoutMs: z.number().int().min(1_000).max(86_400_000).default(30_000),
    completionTimeoutMs: z.number().int().min(1_000).max(604_800_000).default(3_600_000),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.kind === "prompt" && command.prompt === undefined) {
      context.addIssue({
        code: "custom",
        message: "Prompt actions require prompt text",
        path: ["prompt"],
      });
    }
  });
export type CreateAgentActionCommand = z.input<typeof CreateAgentActionCommandSchema>;
export const WaitForAgentActionCommandSchema = z
  .object({
    states: z.array(AgentActionStateSchema).min(1).max(16),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  })
  .strict();
export type WaitForAgentActionCommand = z.input<typeof WaitForAgentActionCommandSchema>;
export const AgentActionWorkspaceSchema = z
  .object({
    groupId: IdentifierSchema,
    actions: z.array(AgentActionSchema),
    attempts: z.array(AgentActionAttemptSchema),
    acknowledgements: z.array(AgentActionAcknowledgementSchema),
    openWaits: z.array(OpenWaitSchema),
  })
  .strict();
export type AgentActionWorkspace = z.infer<typeof AgentActionWorkspaceSchema>;

export const MessageIntentSchema = z.enum(["inform", "request", "response", "control"]);
export type MessageIntent = z.infer<typeof MessageIntentSchema>;
const DirectAudienceSchema = z
  .object({ kind: z.literal("dm"), memberId: IdentifierSchema })
  .strict();
const MulticastAudienceSchema = z
  .object({ kind: z.literal("multicast"), memberIds: z.array(IdentifierSchema).min(2) })
  .strict();
const GroupBroadcastAudienceSchema = z
  .object({
    kind: z.literal("group"),
    membershipRevision: z.number().int().nonnegative(),
  })
  .strict();
export const AudienceSchema = z
  .discriminatedUnion("kind", [
    DirectAudienceSchema,
    MulticastAudienceSchema,
    GroupBroadcastAudienceSchema,
  ])
  .superRefine((audience, context) => {
    if (
      audience.kind === "multicast" &&
      new Set(audience.memberIds).size !== audience.memberIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Multicast recipients must be unique",
        path: ["memberIds"],
      });
    }
  });
export type Audience = z.infer<typeof AudienceSchema>;

export const DeliveryPolicySchema = z.object({ expiresAt: TimestampSchema.optional() }).strict();
export type DeliveryPolicy = z.infer<typeof DeliveryPolicySchema>;
export const MessageSenderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), operatorId: IdentifierSchema }).strict(),
  z
    .object({ kind: z.literal("agent"), memberId: IdentifierSchema, runId: IdentifierSchema })
    .strict(),
]);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const MessageBodySchema = z
  .object({ contentType: z.enum(["text/plain", "text/markdown"]), text: z.string().min(1) })
  .strict()
  .superRefine((body, context) => {
    if (!isWellFormedUnicode(body.text)) {
      context.addIssue({
        code: "custom",
        message: "Message text must contain well-formed Unicode",
        path: ["text"],
      });
      return;
    }
    if (new TextEncoder().encode(body.text).byteLength > MAX_MESSAGE_TEXT_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Message text exceeds the ${MAX_MESSAGE_TEXT_BYTES}-byte UTF-8 limit. ${OVERSIZED_MESSAGE_GUIDANCE}`,
        path: ["text"],
      });
    }
  });
export type MessageBody = z.infer<typeof MessageBodySchema>;

const MessageFields = {
  conversationId: IdentifierSchema,
  intent: MessageIntentSchema,
  sender: MessageSenderSchema,
  audience: AudienceSchema,
  body: MessageBodySchema,
  delivery: DeliveryPolicySchema,
  replyTo: IdentifierSchema.optional(),
  rootId: IdentifierSchema.optional(),
  causationId: IdentifierSchema.optional(),
  hop: z.number().int().nonnegative().max(MAX_MESSAGE_CAUSAL_DEPTH),
};
export const MessageSchema = z
  .object({
    id: IdentifierSchema,
    groupId: IdentifierSchema,
    groupSeq: z.number().int().positive(),
    ...MessageFields,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.intent === "control" && message.sender.kind !== "operator") {
      context.addIssue({
        code: "custom",
        message: "Only operators can send control messages",
        path: ["intent"],
      });
    }
  });
export type Message = z.infer<typeof MessageSchema>;

export const SubmitMessageCommandSchema = z
  .object({
    conversationId: IdentifierSchema.optional(),
    intent: MessageIntentSchema,
    sender: MessageSenderSchema,
    audience: AudienceSchema,
    body: MessageBodySchema,
    delivery: DeliveryPolicySchema,
    replyTo: IdentifierSchema.optional(),
    causationId: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.intent === "control" && message.sender.kind !== "operator") {
      context.addIssue({
        code: "custom",
        message: "Only operators can send control messages",
        path: ["intent"],
      });
    }
  });
export type SubmitMessageCommand = z.infer<typeof SubmitMessageCommandSchema>;

export const DeliveryStatusSchema = z.enum([
  "queued",
  "received",
  "delivering",
  "terminal_injected",
  "processed",
  "retrying",
  "dead-letter",
  "revoked",
  "rejected",
  "failed",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
export const DeliveryOutcomeSchema = z
  .object({
    messageId: IdentifierSchema,
    recipientMemberId: IdentifierSchema,
    reason: z.string().min(1).optional(),
    status: DeliveryStatusSchema,
    attempts: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type DeliveryOutcome = z.infer<typeof DeliveryOutcomeSchema>;
export const MessageSubmissionResultSchema = z
  .object({ message: MessageSchema, deliveryOutcomes: z.array(DeliveryOutcomeSchema) })
  .strict();
export type MessageSubmissionResult = z.infer<typeof MessageSubmissionResultSchema>;

export const GroupMessageStateSchema = z
  .object({
    groupId: IdentifierSchema,
    latestGroupSeq: z.number().int().nonnegative(),
    oldestRetainedGroupSeq: z.number().int().positive().optional(),
    retainedMessageCount: z.number().int().nonnegative(),
    activeDeliveryCount: z.number().int().nonnegative(),
    failedRecipientMemberIds: z.array(IdentifierSchema),
  })
  .strict();
export type GroupMessageState = z.infer<typeof GroupMessageStateSchema>;
export const MessagePageInfoSchema = z
  .object({
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    nextBefore: z.number().int().positive().optional(),
    nextAfter: z.number().int().positive().optional(),
  })
  .strict();
export const MessagePageSchema = z
  .object({
    groupId: IdentifierSchema,
    messages: z.array(MessageSchema),
    deliveryOutcomes: z.array(DeliveryOutcomeSchema),
    state: GroupMessageStateSchema,
    pageInfo: MessagePageInfoSchema,
  })
  .strict();
export type MessagePage = z.infer<typeof MessagePageSchema>;
export const ClearMessageHistoryResultSchema = z
  .object({
    groupId: IdentifierSchema,
    deletedMessages: z.number().int().nonnegative(),
    deletedDeliveries: z.number().int().nonnegative(),
    state: GroupMessageStateSchema,
  })
  .strict();
export type ClearMessageHistoryResult = z.infer<typeof ClearMessageHistoryResultSchema>;
