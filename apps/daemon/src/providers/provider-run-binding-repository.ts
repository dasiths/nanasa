import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunProviderBindingSchema,
  type RunProviderBinding,
  type RunProviderLaunchSelection,
} from "@nanasa/contracts";
import type { ProviderRuntimeIndex } from "./provider-runtime-index.js";
import type { ProviderSnapshotRepository } from "./provider-snapshot-repository.js";
import type { ResolvedProviderAdapter } from "./resolved-provider-adapter.js";

export interface CreateRunProviderBindingInput {
  readonly runId: string;
  readonly generation: number;
  readonly integrationId: string;
  readonly providerId: string;
  readonly snapshotDigest: string;
  readonly providerStateId: string;
  readonly overlayId: string;
  readonly credentialSlots: Readonly<Record<string, string>>;
  readonly launchPlan: RunProviderLaunchSelection;
  readonly launchDigest: string;
  readonly permissionFloorDigest: string;
  readonly repositoryTrustDigest: string;
  readonly createdAt?: string;
}

export interface RecoveredRunProviderBinding {
  readonly binding: RunProviderBinding;
  readonly snapshot: NonNullable<
    Awaited<ReturnType<ProviderSnapshotRepository["getResolvedSnapshot"]>>
  >;
}

interface BindingRow {
  readonly id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly integration_id: string;
  readonly provider_id: string;
  readonly adapter_id: string;
  readonly snapshot_digest: string;
  readonly activation_id: string;
  readonly process_recognition_digest: string;
  readonly status_policy_digest: string;
  readonly provider_state_id: string;
  readonly overlay_id: string;
  readonly credential_slots_json: string;
  readonly launch_plan_json: string;
  readonly launch_digest: string;
  readonly permission_floor_digest: string;
  readonly repository_trust_digest: string;
  readonly provider_binary_json: string;
  readonly created_at: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function capabilityPayload(
  capabilities: readonly { readonly id: string; readonly payload: unknown }[],
  id: string,
): unknown {
  const selected = capabilities.find((capability) => capability.id === id);
  if (selected === undefined) throw new Error(`Provider snapshot is missing ${id} capability`);
  return selected.payload;
}

function bindingFromRow(row: BindingRow): RunProviderBinding {
  return RunProviderBindingSchema.parse({
    id: row.id,
    runId: row.run_id,
    generation: row.generation,
    integrationId: row.integration_id,
    providerId: row.provider_id,
    adapterId: row.adapter_id,
    snapshotDigest: row.snapshot_digest,
    activationId: row.activation_id,
    processRecognitionDigest: row.process_recognition_digest,
    statusPolicyDigest: row.status_policy_digest,
    providerStateId: row.provider_state_id,
    overlayId: row.overlay_id,
    credentialSlots: JSON.parse(row.credential_slots_json),
    launchPlan: JSON.parse(row.launch_plan_json),
    launchDigest: row.launch_digest,
    permissionFloorDigest: row.permission_floor_digest,
    repositoryTrustDigest: row.repository_trust_digest,
    providerBinary: JSON.parse(row.provider_binary_json),
    createdAt: row.created_at,
  });
}

function assertRetryMatches(
  existing: RunProviderBinding,
  input: CreateRunProviderBindingInput,
): void {
  const requested = {
    runId: input.runId,
    generation: input.generation,
    integrationId: input.integrationId,
    providerId: input.providerId,
    snapshotDigest: input.snapshotDigest,
    providerStateId: input.providerStateId,
    overlayId: input.overlayId,
    credentialSlots: input.credentialSlots,
    launchPlan: input.launchPlan,
    launchDigest: input.launchDigest,
    permissionFloorDigest: input.permissionFloorDigest,
    repositoryTrustDigest: input.repositoryTrustDigest,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
  const persisted = {
    runId: existing.runId,
    generation: existing.generation,
    integrationId: existing.integrationId,
    providerId: existing.providerId,
    snapshotDigest: existing.snapshotDigest,
    providerStateId: existing.providerStateId,
    overlayId: existing.overlayId,
    credentialSlots: existing.credentialSlots,
    launchPlan: existing.launchPlan,
    launchDigest: existing.launchDigest,
    permissionFloorDigest: existing.permissionFloorDigest,
    repositoryTrustDigest: existing.repositoryTrustDigest,
    ...(input.createdAt === undefined ? {} : { createdAt: existing.createdAt }),
  };
  if (canonicalJson(requested) !== canonicalJson(persisted)) {
    throw new Error("Run provider binding retry does not match immutable persisted selection");
  }
}

export class ProviderRunBindingRepository {
  readonly #database: DatabaseSync;
  readonly #index: ProviderRuntimeIndex;
  readonly #snapshots: ProviderSnapshotRepository;

  public constructor(
    database: DatabaseSync,
    index: ProviderRuntimeIndex,
    snapshots: ProviderSnapshotRepository,
  ) {
    this.#database = database;
    this.#index = index;
    this.#snapshots = snapshots;
  }

  public getForRun(runId: string, generation: number): RunProviderBinding | undefined {
    const row = this.#database
      .prepare("SELECT * FROM run_provider_bindings WHERE run_id = ? AND generation = ?")
      .get(runId, generation) as BindingRow | undefined;
    return row === undefined ? undefined : bindingFromRow(row);
  }

  public async resolveActiveSnapshot(providerId: string): Promise<ResolvedProviderAdapter> {
    const indexEntry = this.#index.get(providerId);
    const snapshot = await this.#snapshots.getResolvedSnapshot(indexEntry.snapshotDigest);
    if (snapshot === undefined) throw new Error("Active provider snapshot is unavailable");
    if (snapshot.body.providerId !== providerId) {
      throw new Error("Active provider snapshot identity does not match the requested provider");
    }
    if (snapshot.body.providerBinaryCompatibility.state === "unavailable") {
      throw new Error("Active provider snapshot is unavailable for the observed provider binary");
    }
    return snapshot;
  }

  public async create(input: CreateRunProviderBindingInput): Promise<RunProviderBinding> {
    const existing = this.getForRun(input.runId, input.generation);
    if (existing !== undefined) {
      assertRetryMatches(existing, input);
      return existing;
    }

    const indexEntry = this.#index.get(input.providerId);
    if (indexEntry.snapshotDigest !== input.snapshotDigest) {
      throw new Error("Active provider snapshot changed before run binding persistence");
    }
    const snapshot = await this.#snapshots.getSnapshot(indexEntry.snapshotDigest);
    if (snapshot === undefined) throw new Error("Active provider snapshot is unavailable");
    if (snapshot.body.providerId !== input.providerId) {
      throw new Error("Active provider snapshot identity does not match the requested provider");
    }
    if (snapshot.body.providerBinaryCompatibility.state === "unavailable") {
      throw new Error("Active provider snapshot is unavailable for the observed provider binary");
    }
    const processRecognitionDigest = digest(
      capabilityPayload(snapshot.body.capabilities, "recognition"),
    );
    const statusPolicyDigest = digest(
      capabilityPayload(snapshot.body.capabilities, "semantic-status"),
    );
    const binding = RunProviderBindingSchema.parse({
      id: `binding-${digest({ runId: input.runId, generation: input.generation, snapshotDigest: snapshot.digest }).slice(0, 48)}`,
      runId: input.runId,
      generation: input.generation,
      integrationId: input.integrationId,
      providerId: snapshot.body.providerId,
      adapterId: snapshot.body.adapterId,
      snapshotDigest: snapshot.digest,
      activationId: this.#activeActivationId(input.providerId, snapshot.digest),
      processRecognitionDigest,
      statusPolicyDigest,
      providerStateId: input.providerStateId,
      overlayId: input.overlayId,
      credentialSlots: input.credentialSlots,
      launchPlan: input.launchPlan,
      launchDigest: input.launchDigest,
      permissionFloorDigest: input.permissionFloorDigest,
      repositoryTrustDigest: input.repositoryTrustDigest,
      providerBinary: snapshot.body.providerBinaryCompatibility,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.getForRun(binding.runId, binding.generation);
      if (raced !== undefined) {
        assertRetryMatches(raced, input);
        this.#database.exec("COMMIT");
        return raced;
      }
      if (
        this.#activeActivationId(binding.providerId, binding.snapshotDigest) !==
        binding.activationId
      ) {
        throw new Error("Provider activation changed while the run binding was prepared");
      }
      this.#database
        .prepare(
          `INSERT INTO run_provider_bindings
            (id,run_id,generation,integration_id,provider_id,adapter_id,snapshot_digest,
             activation_id,process_recognition_digest,status_policy_digest,provider_state_id,
             overlay_id,credential_slots_json,launch_plan_json,launch_digest,permission_floor_digest,
             repository_trust_digest,provider_binary_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          binding.id,
          binding.runId,
          binding.generation,
          binding.integrationId,
          binding.providerId,
          binding.adapterId,
          binding.snapshotDigest,
          binding.activationId,
          binding.processRecognitionDigest,
          binding.statusPolicyDigest,
          binding.providerStateId,
          binding.overlayId,
          canonicalJson(binding.credentialSlots),
          canonicalJson(binding.launchPlan),
          binding.launchDigest,
          binding.permissionFloorDigest,
          binding.repositoryTrustDigest,
          canonicalJson(binding.providerBinary),
          binding.createdAt,
        );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return binding;
  }

  public async requireForRecovery(
    runId: string,
    generation: number,
  ): Promise<RecoveredRunProviderBinding> {
    const binding = this.getForRun(runId, generation);
    if (binding === undefined) throw new Error("Run provider binding is unavailable for recovery");
    const authority = this.#database
      .prepare(
        `SELECT activation.state AS activation_state, package.state AS package_state
         FROM provider_activations AS activation
         JOIN provider_snapshots AS snapshot ON snapshot.digest = activation.snapshot_digest
         JOIN provider_packages AS package
           ON package.extension_generation = snapshot.extension_generation
         WHERE activation.id = ? AND activation.snapshot_digest = ?`,
      )
      .get(binding.activationId, binding.snapshotDigest) as
      | { activation_state: string; package_state: string }
      | undefined;
    if (
      authority === undefined ||
      authority.activation_state === "revoked" ||
      authority.package_state === "revoked" ||
      authority.package_state === "rejected"
    ) {
      throw new Error("Pinned provider authority is revoked or unavailable for recovery");
    }
    const snapshot = await this.#snapshots.getResolvedSnapshot(binding.snapshotDigest);
    if (snapshot === undefined)
      throw new Error("Pinned provider snapshot is unavailable for recovery");
    const expectedRecognitionDigest = digest(
      capabilityPayload(snapshot.body.capabilities, "recognition"),
    );
    const expectedStatusPolicyDigest = digest(
      capabilityPayload(snapshot.body.capabilities, "semantic-status"),
    );
    if (
      snapshot.body.providerId !== binding.providerId ||
      snapshot.body.adapterId !== binding.adapterId ||
      expectedRecognitionDigest !== binding.processRecognitionDigest ||
      expectedStatusPolicyDigest !== binding.statusPolicyDigest ||
      canonicalJson(snapshot.body.providerBinaryCompatibility) !==
        canonicalJson(binding.providerBinary)
    ) {
      throw new Error("Pinned provider snapshot does not match its immutable run binding");
    }
    return Object.freeze({ binding: Object.freeze(binding), snapshot: Object.freeze(snapshot) });
  }

  #activeActivationId(providerId: string, snapshotDigest: string): string {
    const activation = this.#database
      .prepare(
        `SELECT id FROM provider_activations
         WHERE provider_id = ? AND snapshot_digest = ? AND state = 'active'`,
      )
      .get(providerId, snapshotDigest) as { id: string } | undefined;
    if (activation === undefined) {
      throw new Error("Active provider activation does not match the runtime index");
    }
    return activation.id;
  }
}
