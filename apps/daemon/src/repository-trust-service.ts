import { createHash, randomUUID } from "node:crypto";
import type { CredentialProfileReference, ModelResumePolicy } from "@nanasa/contracts";

export interface RepositoryLaunchManifest {
  readonly repositoryIdentity: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly command: readonly string[];
  readonly workingDirectory?: string;
  readonly environmentNames: readonly string[];
  readonly credentialReference: CredentialProfileReference;
  readonly generatedIdentities: readonly string[];
  readonly permissionFloor: "inherit" | "read-only";
  readonly desiredModel?: string;
  readonly modelResumePolicy: ModelResumePolicy;
}

export interface RepositoryTrustReceipt {
  readonly id: string;
  readonly repositoryIdentity: string;
  readonly subjectDigest: string;
  readonly principalId: string;
  readonly decision: "trusted" | "denied" | "revoked";
  readonly decidedAt: string;
  readonly revokedAt?: string;
}

export interface RepositoryTrustPersistence {
  findRepositoryTrust(
    repositoryIdentity: string,
    subjectDigest: string,
  ): RepositoryTrustReceipt | undefined;
  saveRepositoryTrust(receipt: RepositoryTrustReceipt): RepositoryTrustReceipt;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class RepositoryTrustService {
  #lastDecisionTime = 0;

  public constructor(private readonly persistence: RepositoryTrustPersistence) {}

  public digest(manifest: RepositoryLaunchManifest): string {
    const safeManifest = {
      repositoryIdentity: manifest.repositoryIdentity,
      adapterId: manifest.adapterId,
      adapterVersion: manifest.adapterVersion,
      command: [...manifest.command],
      workingDirectory: manifest.workingDirectory,
      environmentNames: [...manifest.environmentNames].sort(),
      credentialReference: manifest.credentialReference,
      generatedIdentities: [...manifest.generatedIdentities].sort(),
      permissionFloor: manifest.permissionFloor,
      desiredModel: manifest.desiredModel,
      modelResumePolicy: manifest.modelResumePolicy,
    };
    return createHash("sha256").update(canonical(safeManifest)).digest("hex");
  }

  public trust(manifest: RepositoryLaunchManifest, principalId: string): RepositoryTrustReceipt {
    const decidedAt = this.#nextDecisionTimestamp();
    return this.persistence.saveRepositoryTrust(
      Object.freeze({
        id: `trust_${randomUUID()}`,
        repositoryIdentity: manifest.repositoryIdentity,
        subjectDigest: this.digest(manifest),
        principalId,
        decision: "trusted",
        decidedAt,
      }),
    );
  }

  public isTrusted(manifest: RepositoryLaunchManifest): boolean {
    return (
      this.persistence.findRepositoryTrust(manifest.repositoryIdentity, this.digest(manifest))
        ?.decision === "trusted"
    );
  }

  public assertTrusted(manifest: RepositoryLaunchManifest): void {
    if (!this.isTrusted(manifest))
      throw new Error(
        `Repository launch is not trusted for manifest ${this.digest(manifest).slice(0, 12)}`,
      );
  }

  public revoke(manifest: RepositoryLaunchManifest, principalId: string): RepositoryTrustReceipt {
    const decidedAt = this.#nextDecisionTimestamp();
    return this.persistence.saveRepositoryTrust(
      Object.freeze({
        id: `trust_${randomUUID()}`,
        repositoryIdentity: manifest.repositoryIdentity,
        subjectDigest: this.digest(manifest),
        principalId,
        decision: "revoked",
        decidedAt,
        revokedAt: decidedAt,
      }),
    );
  }

  #nextDecisionTimestamp(): string {
    this.#lastDecisionTime = Math.max(Date.now(), this.#lastDecisionTime + 1);
    return new Date(this.#lastDecisionTime).toISOString();
  }
}
