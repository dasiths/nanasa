import { z } from "zod";
import {
  OperationIdSchema,
  ProcessIncarnationDigestSchema,
  ProviderAuthorityFenceSchema,
  SnapshotDigestSchema,
} from "./provider-runtime-v2.js";

export const PROVIDER_RPC_PROTOCOL = "nanasa-provider-rpc.v2" as const;
export const PROVIDER_RPC_MAX_FRAME_BYTES = 1_048_576;

const ProviderRpcScalarSchema = z.union([
  z.string().max(4_096),
  z.number().int().safe(),
  z.boolean(),
  z.null(),
]);
const ProviderRpcDataSchema = z.record(
  z.string().min(1).max(128),
  z.union([ProviderRpcScalarSchema, z.array(ProviderRpcScalarSchema).max(128)]),
);

const RpcEnvelopeSchema = z
  .object({
    protocol: z.literal(PROVIDER_RPC_PROTOCOL),
    requestId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
  })
  .strict();

export const ProviderRpcInitializeRequestSchema = RpcEnvelopeSchema.extend({
  type: z.literal("initialize"),
  snapshotDigest: SnapshotDigestSchema,
  operationIds: z.array(OperationIdSchema).max(64),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();

export const ProviderRpcResolveSnapshotRequestSchema = RpcEnvelopeSchema.extend({
  type: z.literal("resolve-snapshot"),
  packageDigest: SnapshotDigestSchema,
  manifestDigest: SnapshotDigestSchema,
  sanitizedInputDigest: SnapshotDigestSchema,
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();

export const ProviderRpcOperationRequestSchema = RpcEnvelopeSchema.extend({
  type: z.literal("execute-operation"),
  operationId: OperationIdSchema,
  idempotencyKey: z.string().min(1).max(256),
  fence: ProviderAuthorityFenceSchema,
  deadlineAt: z.string().datetime({ offset: true }),
  targetHandles: z.array(z.string().min(1).max(128)).max(32),
  input: ProviderRpcDataSchema,
}).strict();

export const ProviderRpcCancelRequestSchema = RpcEnvelopeSchema.extend({
  type: z.literal("cancel"),
  cancelledRequestId: z.string().min(1).max(128),
}).strict();

export const ProviderRpcShutdownRequestSchema = RpcEnvelopeSchema.extend({
  type: z.literal("shutdown"),
}).strict();

export const ProviderRpcRequestSchema = z.discriminatedUnion("type", [
  ProviderRpcInitializeRequestSchema,
  ProviderRpcResolveSnapshotRequestSchema,
  ProviderRpcOperationRequestSchema,
  ProviderRpcCancelRequestSchema,
  ProviderRpcShutdownRequestSchema,
]);
export type ProviderRpcRequest = z.infer<typeof ProviderRpcRequestSchema>;

export const ProviderRpcSuccessResponseSchema = RpcEnvelopeSchema.extend({
  type: z.literal("result"),
  requestType: z.enum([
    "initialize",
    "resolve-snapshot",
    "execute-operation",
    "cancel",
    "shutdown",
  ]),
  resultDigest: SnapshotDigestSchema.optional(),
  result: ProviderRpcDataSchema,
}).strict();
export const ProviderRpcErrorResponseSchema = RpcEnvelopeSchema.extend({
  type: z.literal("error"),
  code: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  message: z.string().min(1).max(1_000),
  retryable: z.boolean(),
}).strict();
export const ProviderRpcResponseSchema = z.discriminatedUnion("type", [
  ProviderRpcSuccessResponseSchema,
  ProviderRpcErrorResponseSchema,
]);

export const ProviderOperationAuditSchema = z
  .object({
    id: z.string().min(1).max(128),
    operationId: OperationIdSchema,
    idempotencyKey: z.string().min(1).max(256),
    snapshotDigest: SnapshotDigestSchema,
    processIncarnationDigest: ProcessIncarnationDigestSchema.optional(),
    targetHandles: z.array(z.string().min(1).max(128)).max(32),
    state: z.enum(["started", "succeeded", "failed", "cancelled", "timed-out", "uncertain"]),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    safeErrorCode: z.string().min(1).max(100).optional(),
    inputDigest: SnapshotDigestSchema,
    outputDigest: SnapshotDigestSchema.optional(),
  })
  .strict();
export type ProviderOperationAudit = z.infer<typeof ProviderOperationAuditSchema>;
