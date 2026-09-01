import { randomUUID } from "node:crypto";
import type {
  AgentStatusEventInput,
  DurableNativeSession,
  NativeSessionReference,
} from "@nanasa/contracts";
import { DurableNativeSessionSchema } from "@nanasa/contracts";

export interface NativeSessionPersistence {
  saveNativeSession(session: DurableNativeSession): DurableNativeSession;
  latestNativeSession(memberId: string, integrationId: string): DurableNativeSession | undefined;
  reservedNativeSession(memberId: string, integrationId: string): DurableNativeSession | undefined;
  reserveNativeSession(sessionId: string, resumeRunId: string, reservedAt: string): boolean;
  confirmNativeSession(sessionId: string, resumeRunId: string, confirmedAt: string): boolean;
  invalidateNativeSession(sessionId: string): void;
  isNativeSessionConfirmed(sessionId: string, resumeRunId: string): boolean;
}

export interface NativeSessionObservation {
  readonly memberId: string;
  readonly integrationId: string;
  readonly runId: string;
  readonly generation: number;
  readonly reference: NativeSessionReference;
  readonly event: AgentStatusEventInput;
}

export interface ReservedNativeSession {
  readonly session: DurableNativeSession;
  readonly reference: NativeSessionReference;
}

export class NativeSessionService {
  public constructor(private readonly persistence: NativeSessionPersistence) {}

  public observe(input: NativeSessionObservation): DurableNativeSession | undefined {
    if (input.event.event !== "session.ready") return undefined;
    const reference = input.reference;
    if (input.event.source !== reference.source) {
      throw new Error("Native session report does not match the normalized provider reference");
    }
    const previous =
      this.persistence.reservedNativeSession(input.memberId, input.integrationId) ??
      this.persistence.latestNativeSession(input.memberId, input.integrationId);
    const confirmsReservation =
      previous?.status === "reserved" && previous.dedupeHash === reference.dedupeHash;
    const session = DurableNativeSessionSchema.parse({
      ...reference,
      id: previous?.dedupeHash === reference.dedupeHash ? previous.id : `native_${randomUUID()}`,
      memberId: input.memberId,
      integrationId: input.integrationId,
      runId: input.runId,
      generation: input.generation,
      effectiveModel: input.event.data.effectiveModel,
      status: confirmsReservation ? "resumed" : "ready",
      reportedAt: input.event.occurredAt ?? new Date().toISOString(),
      ...(confirmsReservation ? { lastResumedAt: new Date().toISOString() } : {}),
    });
    const saved = this.persistence.saveNativeSession(session);
    if (confirmsReservation)
      this.persistence.confirmNativeSession(previous.id, input.runId, new Date().toISOString());
    return saved;
  }

  public reserve(
    memberId: string,
    integrationId: string,
    resumeRunId: string,
  ): ReservedNativeSession | undefined {
    const session = this.persistence.latestNativeSession(memberId, integrationId);
    if (session === undefined || !["ready", "resumed"].includes(session.status)) return undefined;
    if (!this.persistence.reserveNativeSession(session.id, resumeRunId, new Date().toISOString()))
      return undefined;
    return Object.freeze({
      session: Object.freeze({ ...session, status: "reserved" as const }),
      reference: Object.freeze({
        provider: session.provider,
        source: session.source,
        referenceKind: session.referenceKind,
        referenceValue: session.referenceValue,
        dedupeHash: session.dedupeHash,
      }),
    });
  }

  public isConfirmed(sessionId: string, resumeRunId: string): boolean {
    return this.persistence.isNativeSessionConfirmed(sessionId, resumeRunId);
  }

  public invalidate(sessionId: string): void {
    this.persistence.invalidateNativeSession(sessionId);
  }
}
