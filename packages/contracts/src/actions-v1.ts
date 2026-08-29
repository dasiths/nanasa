import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "./control-v1.js";
import { AgentWaitKindSchema } from "./status-v2.js";

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
    status: z.enum(["started", "already-running", "failed"]),
    runId: IdentifierSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();
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

export const AgentActionKindSchema = z.enum([
  "prompt",
  "interrupt",
  "keys",
  "wait-reply",
  "cancel",
]);
export const AgentActionStateSchema = z.enum([
  "submitted",
  "accepted",
  "started",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
export const AgentActionSchema = z
  .object({
    version: z.literal(1),
    id: IdentifierSchema,
    kind: AgentActionKindSchema,
    memberId: IdentifierSchema,
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterSessionId: IdentifierSchema.optional(),
    baselineStatusRevision: z.number().int().nonnegative(),
    deadline: TimestampSchema,
    state: AgentActionStateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentActionAttemptSchema = z
  .object({
    id: IdentifierSchema,
    actionId: IdentifierSchema,
    attempt: z.number().int().positive(),
    effect: z.enum(["provider-api", "terminal-injection", "logical-keys"]),
    state: z.enum(["pending", "applied", "failed", "indeterminate"]),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    failureCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const AgentActionAcknowledgementSchema = z
  .object({
    id: IdentifierSchema,
    actionId: IdentifierSchema,
    attemptId: IdentifierSchema,
    state: AgentActionStateSchema.exclude(["submitted"]),
    providerTurnId: IdentifierSchema.optional(),
    completionRevision: z.number().int().nonnegative(),
    acknowledgedAt: TimestampSchema,
  })
  .strict();
export const OpenWaitSchema = z
  .object({
    id: IdentifierSchema,
    actionId: IdentifierSchema.optional(),
    runId: IdentifierSchema,
    generation: z.number().int().positive(),
    reporterSessionId: IdentifierSchema,
    kind: AgentWaitKindSchema,
    summary: z.string().trim().min(1).max(512),
    deadline: TimestampSchema,
    openedAt: TimestampSchema,
  })
  .strict();

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
  hop: z.number().int().nonnegative().max(8).default(0),
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
    rootId: IdentifierSchema.optional(),
    causationId: IdentifierSchema.optional(),
    hop: z.number().int().nonnegative().max(8).default(0),
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
