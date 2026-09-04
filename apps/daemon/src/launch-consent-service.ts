import { randomUUID } from "node:crypto";

import {
  ApproveCustomLaunchConsentCommandSchema,
  CancelCustomLaunchConsentCommandSchema,
  type CustomLaunchConsentDecision,
  CustomLaunchConsentDecisionSchema,
  CustomLaunchConsentLifecycleEventPayloadSchema,
  type CustomLaunchConsentRequest,
  CustomLaunchConsentRequestSchema,
  type CustomLaunchConsentRequestState,
  type CustomLaunchConsentSubject,
  CustomLaunchConsentSubjectSchema,
  DenyCustomLaunchConsentCommandSchema,
  type IntegrationCommandSource,
  RevokeCustomLaunchConsentCommandSchema,
} from "@nanasa/contracts";

import { customLaunchConsentSubjectDigest } from "./custom-launch-consent-subject.js";
import type { RepositoryTrustReceipt, TrustSubjectKind } from "./repository-trust-service.js";

const CUSTOM_LAUNCH_SUBJECT_KIND: TrustSubjectKind = "custom-provider-launch";

export interface LaunchConsentPersistence {
  findRepositoryTrust(
    repositoryIdentity: string,
    subjectDigest: string,
    subjectKind?: TrustSubjectKind,
  ): RepositoryTrustReceipt | undefined;
  saveRepositoryTrust(receipt: RepositoryTrustReceipt): RepositoryTrustReceipt;
  findLaunchConsentRequest(requestId: string): CustomLaunchConsentRequest | undefined;
  listLaunchConsentRequests(
    repositoryIdentity: string,
    state?: CustomLaunchConsentRequestState,
  ): CustomLaunchConsentRequest[];
  findPendingLaunchConsentRequest(
    repositoryIdentity: string,
    groupId: string,
    agentId: string,
    subjectDigest: string,
  ): CustomLaunchConsentRequest | undefined;
  findLatestLaunchConsentRequest(
    repositoryIdentity: string,
    groupId: string,
    agentId: string,
    subjectDigest: string,
  ): CustomLaunchConsentRequest | undefined;
  createOrReuseLaunchConsentRequest(
    request: CustomLaunchConsentRequest,
  ): CustomLaunchConsentRequest;
  reconcileLaunchConsentRequests(input: {
    repositoryIdentity: string;
    groupId: string;
    agentId: string;
    subjectDigest: string;
    configRevision: string;
    reconciledAt: string;
  }): CustomLaunchConsentRequest[];
  staleLaunchConsentRequest(requestId: string, decidedAt: string): CustomLaunchConsentRequest;
  decideLaunchConsentRequest(input: {
    requestId: string;
    subjectDigest: string;
    configRevision: string;
    state: "approved" | "denied" | "cancelled";
    decidedAt: string;
    decidedBy: string;
    receipt?: RepositoryTrustReceipt;
  }): CustomLaunchConsentRequest | undefined;
  recordRuntimeEvent(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): unknown;
}

export interface CurrentLaunchConsentSubject {
  readonly subject: CustomLaunchConsentSubject;
  readonly configRevision: string;
}

export type LaunchConsentSubjectResolver = (
  request: CustomLaunchConsentRequest,
) => CurrentLaunchConsentSubject | undefined | Promise<CurrentLaunchConsentSubject | undefined>;

export type ResolveLaunchConsentInput =
  | { readonly commandSource: Extract<IntegrationCommandSource, "builtin"> }
  | {
      readonly commandSource: Extract<IntegrationCommandSource, "custom">;
      readonly repositoryIdentity: string;
      readonly groupId: string;
      readonly agentId: string;
      readonly memberId: string;
      readonly integrationId: string;
      readonly subject: CustomLaunchConsentSubject;
      readonly configRevision: string;
    };

export type LaunchConsentResolution =
  | { readonly status: "built-in" }
  | { readonly status: "trusted"; readonly decision: CustomLaunchConsentDecision }
  | {
      readonly status: "denied";
      readonly decision: CustomLaunchConsentDecision;
      readonly request: CustomLaunchConsentRequest;
    }
  | { readonly status: "approval-required"; readonly request: CustomLaunchConsentRequest };

export type AutomaticLaunchConsentResolution =
  | { readonly status: "built-in" }
  | { readonly status: "trusted"; readonly decision: CustomLaunchConsentDecision }
  | { readonly status: "denied"; readonly decision: CustomLaunchConsentDecision }
  | { readonly status: "approval-required" };

export interface LaunchConsentDecisionResult {
  readonly request: CustomLaunchConsentRequest;
  readonly decision: CustomLaunchConsentDecision;
}

export class LaunchConsentServiceError extends Error {
  public constructor(
    public readonly code:
      | "launch_consent_not_found"
      | "launch_consent_not_pending"
      | "launch_consent_stale",
    message: string,
  ) {
    super(message);
    this.name = "LaunchConsentServiceError";
  }
}

export class LaunchConsentService {
  #lastTimestamp = 0;

  public constructor(
    private readonly persistence: LaunchConsentPersistence,
    private readonly resolveCurrentSubject: LaunchConsentSubjectResolver,
  ) {}

  public findDecision(
    repositoryIdentity: string,
    subjectDigest: string,
  ): CustomLaunchConsentDecision | undefined {
    const receipt = this.persistence.findRepositoryTrust(
      repositoryIdentity,
      subjectDigest,
      CUSTOM_LAUNCH_SUBJECT_KIND,
    );
    return receipt === undefined ? undefined : this.#decision(receipt);
  }

  public listRequests(
    repositoryIdentity: string,
    state?: CustomLaunchConsentRequestState,
  ): CustomLaunchConsentRequest[] {
    return this.persistence.listLaunchConsentRequests(repositoryIdentity, state);
  }

  public getRequest(repositoryIdentity: string, requestId: string): CustomLaunchConsentRequest {
    const request = this.persistence.findLaunchConsentRequest(requestId);
    if (request === undefined || request.repositoryIdentity !== repositoryIdentity) {
      throw new LaunchConsentServiceError(
        "launch_consent_not_found",
        "Launch consent request not found",
      );
    }
    return request;
  }

  public resolve(input: ResolveLaunchConsentInput): LaunchConsentResolution {
    if (input.commandSource === "builtin") return { status: "built-in" };

    const subject = CustomLaunchConsentSubjectSchema.parse(input.subject);
    const subjectDigest = customLaunchConsentSubjectDigest(subject);
    const reconciledAt = this.#nextTimestamp();
    const candidate = CustomLaunchConsentRequestSchema.parse({
      id: `launch-consent-${randomUUID()}`,
      repositoryIdentity: input.repositoryIdentity,
      groupId: input.groupId,
      agentId: input.agentId,
      memberId: input.memberId,
      integrationId: input.integrationId,
      subjectDigest,
      configRevision: input.configRevision,
      subject,
      state: "pending",
      requestedAt: reconciledAt,
    });
    const staleRequests = this.persistence.reconcileLaunchConsentRequests({
      repositoryIdentity: input.repositoryIdentity,
      groupId: input.groupId,
      agentId: input.agentId,
      subjectDigest,
      configRevision: input.configRevision,
      reconciledAt,
    });
    for (const staleRequest of staleRequests) this.#emitRequest(staleRequest);

    const decision = this.findDecision(input.repositoryIdentity, subjectDigest);
    if (decision?.decision === "trusted") return { status: "trusted", decision };
    if (decision?.decision === "denied") {
      const existing = this.persistence.findLatestLaunchConsentRequest(
        input.repositoryIdentity,
        input.groupId,
        input.agentId,
        subjectDigest,
      );
      if (existing?.state === "denied") return { status: "denied", decision, request: existing };

      const existingPending = this.persistence.findPendingLaunchConsentRequest(
        input.repositoryIdentity,
        input.groupId,
        input.agentId,
        subjectDigest,
      );
      const pending = this.persistence.createOrReuseLaunchConsentRequest(candidate);
      if (existingPending === undefined) this.#emitRequest(pending);
      const denied = this.persistence.decideLaunchConsentRequest({
        requestId: pending.id,
        subjectDigest: pending.subjectDigest,
        configRevision: pending.configRevision,
        state: "denied",
        decidedAt: reconciledAt,
        decidedBy: decision.principalId,
      });
      if (denied === undefined) this.#throwNoLongerPending(pending.id);
      return { status: "denied", decision, request: denied };
    }

    const existingPending = this.persistence.findPendingLaunchConsentRequest(
      input.repositoryIdentity,
      input.groupId,
      input.agentId,
      subjectDigest,
    );
    const request = this.persistence.createOrReuseLaunchConsentRequest(candidate);
    if (existingPending === undefined) this.#emitRequest(request);
    return { status: "approval-required", request };
  }

  public inspectForAutomaticRecovery(
    input: ResolveLaunchConsentInput,
  ): AutomaticLaunchConsentResolution {
    if (input.commandSource === "builtin") return { status: "built-in" };

    const subject = CustomLaunchConsentSubjectSchema.parse(input.subject);
    const subjectDigest = customLaunchConsentSubjectDigest(subject);
    const staleRequests = this.persistence.reconcileLaunchConsentRequests({
      repositoryIdentity: input.repositoryIdentity,
      groupId: input.groupId,
      agentId: input.agentId,
      subjectDigest,
      configRevision: input.configRevision,
      reconciledAt: this.#nextTimestamp(),
    });
    for (const staleRequest of staleRequests) this.#emitRequest(staleRequest);
    const decision = this.findDecision(input.repositoryIdentity, subjectDigest);
    if (decision?.decision === "trusted") return { status: "trusted", decision };
    if (decision?.decision === "denied") return { status: "denied", decision };
    return { status: "approval-required" };
  }

  public inspect(input: ResolveLaunchConsentInput): AutomaticLaunchConsentResolution {
    if (input.commandSource === "builtin") return { status: "built-in" };

    const subject = CustomLaunchConsentSubjectSchema.parse(input.subject);
    const decision = this.findDecision(
      input.repositoryIdentity,
      customLaunchConsentSubjectDigest(subject),
    );
    if (decision?.decision === "trusted") return { status: "trusted", decision };
    if (decision?.decision === "denied") return { status: "denied", decision };
    return { status: "approval-required" };
  }

  public async approve(
    requestId: string,
    command: unknown,
    principalId: string,
  ): Promise<LaunchConsentDecisionResult> {
    const expected = ApproveCustomLaunchConsentCommandSchema.parse(command);
    const request = this.#pendingRequest(requestId);
    this.#assertExpected(request, expected);

    const current = await this.resolveCurrentSubject(request);
    if (current === undefined) {
      const stale = this.persistence.staleLaunchConsentRequest(request.id, this.#nextTimestamp());
      this.#emitRequest(stale);
      throw new LaunchConsentServiceError(
        "launch_consent_stale",
        "Launch consent subject changed before approval",
      );
    }
    const currentSubject = CustomLaunchConsentSubjectSchema.parse(current.subject);
    const currentDigest = customLaunchConsentSubjectDigest(currentSubject);
    if (
      currentDigest !== request.subjectDigest ||
      current.configRevision !== request.configRevision
    ) {
      const stale = this.persistence.staleLaunchConsentRequest(request.id, this.#nextTimestamp());
      this.#emitRequest(stale);
      throw new LaunchConsentServiceError(
        "launch_consent_stale",
        "Launch consent subject changed before approval",
      );
    }

    return this.#decide(request, "approved", "trusted", principalId);
  }

  public deny(
    requestId: string,
    command: unknown,
    principalId: string,
  ): LaunchConsentDecisionResult {
    const expected = DenyCustomLaunchConsentCommandSchema.parse(command);
    const request = this.#pendingRequest(requestId);
    this.#assertExpected(request, expected);
    return this.#decide(request, "denied", "denied", principalId);
  }

  public cancel(
    requestId: string,
    command: unknown,
    principalId: string,
  ): CustomLaunchConsentRequest {
    const expected = CancelCustomLaunchConsentCommandSchema.parse(command);
    const request = this.#pendingRequest(requestId);
    this.#assertExpected(request, expected);
    const decided = this.persistence.decideLaunchConsentRequest({
      requestId: request.id,
      subjectDigest: request.subjectDigest,
      configRevision: request.configRevision,
      state: "cancelled",
      decidedAt: this.#nextTimestamp(),
      decidedBy: principalId,
    });
    if (decided === undefined) this.#throwNoLongerPending(request.id);
    this.#emitRequest(decided);
    return decided;
  }

  public revoke(
    repositoryIdentity: string,
    receiptId: string,
    command: unknown,
    principalId: string,
  ): CustomLaunchConsentDecision {
    const expected = RevokeCustomLaunchConsentCommandSchema.parse(command);
    const current = this.persistence.findRepositoryTrust(
      repositoryIdentity,
      expected.expectedSubjectDigest,
      CUSTOM_LAUNCH_SUBJECT_KIND,
    );
    if (current === undefined || current.id !== receiptId) {
      throw new LaunchConsentServiceError(
        "launch_consent_not_found",
        "Launch consent decision not found",
      );
    }
    if (current.decision === "revoked") return this.#decision(current);

    const decidedAt = this.#nextTimestamp();
    const decision = this.#decision(
      this.persistence.saveRepositoryTrust({
        id: `trust_${randomUUID()}`,
        repositoryIdentity,
        subjectKind: CUSTOM_LAUNCH_SUBJECT_KIND,
        subjectDigest: expected.expectedSubjectDigest,
        principalId,
        decision: "revoked",
        decidedAt,
        revokedAt: decidedAt,
      }),
    );
    this.persistence.recordRuntimeEvent(
      "launch-consent.revoked",
      "launch-consent",
      decision.id,
      CustomLaunchConsentLifecycleEventPayloadSchema.parse({
        state: "revoked",
        repositoryIdentity,
        subjectDigest: decision.subjectDigest,
        decisionId: decision.id,
      }),
    );
    return decision;
  }

  #decide(
    request: CustomLaunchConsentRequest,
    state: "approved" | "denied",
    decision: "trusted" | "denied",
    principalId: string,
  ): LaunchConsentDecisionResult {
    const decidedAt = this.#nextTimestamp();
    const receipt: RepositoryTrustReceipt = {
      id: `trust_${randomUUID()}`,
      repositoryIdentity: request.repositoryIdentity,
      subjectKind: CUSTOM_LAUNCH_SUBJECT_KIND,
      subjectDigest: request.subjectDigest,
      principalId,
      decision,
      decidedAt,
    };
    const decided = this.persistence.decideLaunchConsentRequest({
      requestId: request.id,
      subjectDigest: request.subjectDigest,
      configRevision: request.configRevision,
      state,
      decidedAt,
      decidedBy: principalId,
      receipt,
    });
    if (decided === undefined) this.#throwNoLongerPending(request.id);
    const parsedDecision = this.#decision(receipt);
    this.#emitRequest(decided, parsedDecision.id);
    return { request: decided, decision: parsedDecision };
  }

  #pendingRequest(requestId: string): CustomLaunchConsentRequest {
    const request = this.persistence.findLaunchConsentRequest(requestId);
    if (request === undefined) {
      throw new LaunchConsentServiceError(
        "launch_consent_not_found",
        "Launch consent request not found",
      );
    }
    if (request.state !== "pending") this.#throwNoLongerPending(request.id);
    return request;
  }

  #assertExpected(
    request: CustomLaunchConsentRequest,
    expected: { expectedSubjectDigest: string; configRevision: string },
  ): void {
    if (
      expected.expectedSubjectDigest !== request.subjectDigest ||
      expected.configRevision !== request.configRevision
    ) {
      throw new LaunchConsentServiceError(
        "launch_consent_stale",
        "Launch consent request does not match the expected subject and configuration revision",
      );
    }
  }

  #throwNoLongerPending(requestId: string): never {
    throw new LaunchConsentServiceError(
      "launch_consent_not_pending",
      `Launch consent request ${requestId} is no longer pending`,
    );
  }

  #decision(receipt: RepositoryTrustReceipt): CustomLaunchConsentDecision {
    return CustomLaunchConsentDecisionSchema.parse({
      id: receipt.id,
      repositoryIdentity: receipt.repositoryIdentity,
      subjectDigest: receipt.subjectDigest,
      principalId: receipt.principalId,
      decision: receipt.decision,
      decidedAt: receipt.decidedAt,
      revokedAt: receipt.revokedAt,
    });
  }

  #emitRequest(request: CustomLaunchConsentRequest, decisionId?: string): void {
    this.persistence.recordRuntimeEvent(
      `launch-consent.${request.state}`,
      "launch-consent",
      request.id,
      CustomLaunchConsentLifecycleEventPayloadSchema.parse({
        state: request.state,
        repositoryIdentity: request.repositoryIdentity,
        subjectDigest: request.subjectDigest,
        requestId: request.id,
        groupId: request.groupId,
        agentId: request.agentId,
        memberId: request.memberId,
        integrationId: request.integrationId,
        configRevision: request.configRevision,
        ...(decisionId === undefined ? {} : { decisionId }),
      }),
    );
  }

  #nextTimestamp(): string {
    this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1);
    return new Date(this.#lastTimestamp).toISOString();
  }
}
