import { createHash } from "node:crypto";
import type {
  ForemanActor,
  ForemanConfig,
  ForemanRun,
  ForemanWorkspace,
  StopForemanCommand,
} from "@nanasa/contracts";
import { canonicalJson, ForemanConfigSchema } from "@nanasa/contracts";
import { ConfigRepository } from "./config-repository.js";
import { resolveEffectiveForemanPrompt } from "./instruction-resolver.js";
import { resolveEffectiveForemanProviderPolicy } from "./provider-policy-resolver.js";
import type { ProviderRunBindingRepository } from "./providers/provider-run-binding-repository.js";
import type { ReporterRegistry } from "./reporter-registry.js";
import { DomainError, NanasaStore } from "./store.js";
import type { TmuxRuntime } from "./tmux-runtime.js";

export interface ForemanRuntimeServiceOptions {
  readonly store: NanasaStore;
  readonly config: ConfigRepository;
  readonly runtime: Pick<
    TmuxRuntime,
    "startForemanRun" | "stopForemanRun" | "observeRun" | "ensureViewSession"
  >;
  readonly bindings: Pick<ProviderRunBindingRepository, "requireForRecovery">;
  readonly mcpEnabled: boolean;
  readonly allowAutonomous: boolean;
  readonly allowProviderFiles: boolean;
  readonly reporters?: ReporterRegistry;
  readonly onRunAvailable?: (run: ForemanRun) => void;
  readonly onRunUnavailable?: (runId: string) => void;
}

export class ForemanRuntimeService {
  readonly #options: ForemanRuntimeServiceOptions;
  #tail: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #problem: string | undefined;

  public constructor(options: ForemanRuntimeServiceOptions) {
    this.#options = options;
  }

  public status(): ForemanWorkspace {
    const loaded = this.#options.config.load();
    const configuration = loaded.config.foreman;
    const result = {
      configRevision: loaded.status.revision,
      configuration,
      problem: this.#problem,
      inbox: this.#options.store.listForemanInbox(),
    };
    if (configuration === undefined) return result;
    let actor: ForemanActor;
    try {
      actor = this.#options.store.getForeman(configuration.id);
    } catch (error) {
      if (error instanceof DomainError && error.code === "foreman_not_found") return result;
      throw error;
    }
    return { ...result, actor, run: this.#options.store.getLatestForemanRun(actor.id) };
  }

  public configure(configuration: ForemanConfig, expectedRevision: string) {
    return this.#serialize(async () => {
      const parsed = ForemanConfigSchema.parse(configuration);
      for (const actor of this.#options.store.listForemen()) {
        if (this.#options.store.getActiveForemanRun(actor.id) !== undefined) {
          throw new DomainError(
            "foreman_must_stop",
            "Stop Foreman before changing configuration",
            409,
          );
        }
      }
      await this.#options.config.mutate(
        (current) => ({
          config: { ...current, foreman: parsed },
          result: undefined,
        }),
        expectedRevision,
      );
      return this.status();
    });
  }

  public start(
    expectedConfigRevision: string,
    size = { cols: 120, rows: 36 },
  ): Promise<ForemanRun> {
    return this.#serialize(async () => {
      const { store, config, runtime } = this.#options;
      const loaded = config.load();
      if (loaded.status.revision !== expectedConfigRevision)
        throw new DomainError(
          "config_revision_conflict",
          "Configuration changed; refresh before starting Foreman",
          409,
        );
      const foreman = loaded.config.foreman;
      if (foreman?.enabled !== true)
        throw new DomainError("foreman_not_enabled", "Enable Foreman before starting it", 409);
      if (!this.#options.mcpEnabled)
        throw new DomainError(
          "foreman_mcp_required",
          "Foreman requires the daemon MCP endpoint",
          409,
        );
      const integration = loaded.config.integrations[foreman.integrationId];
      if (integration === undefined)
        throw new DomainError("integration_not_found", "Foreman integration is unavailable", 409);
      if (integration.commandSource !== "builtin")
        throw new DomainError(
          "foreman_launch_consent_required",
          "Custom Foreman launchers require repository-owned launch consent",
          409,
        );
      for (const actor of store.listForemen()) {
        const existing = store.getActiveForemanRun(actor.id);
        if (existing !== undefined)
          throw new DomainError("run_already_active", "Foreman already has an active run", 409);
        if (actor.id !== foreman.id && actor.enabled)
          store.upsertForeman({ ...actor, enabled: false });
      }
      const prompt = resolveEffectiveForemanPrompt({
        repoRoot: loaded.repoRoot,
        config: loaded.config,
      });
      const providerPolicy = resolveEffectiveForemanProviderPolicy({
        repoRoot: loaded.repoRoot,
        config: loaded.config,
        configRevision: expectedConfigRevision,
        allowAutonomous: this.#options.allowAutonomous,
        allowProviderFiles: this.#options.allowProviderFiles,
      });
      const profileInput = {
        name: foreman.name,
        agentType: foreman.integrationId,
        kind: integration.kind,
        command: integration.command[0]!,
        args: integration.command.slice(1),
        workingDirectory: integration.cwd ?? loaded.repoRoot,
        environment: integration.environment,
      };
      const profile = store.createInternalAgentProfile(
        profileInput,
        `foreman-profile-${createHash("sha256")
          .update(canonicalJson({ id: foreman.id, profileInput }))
          .digest("hex")}`,
      );
      store.upsertForeman({ id: foreman.id, agentProfileId: profile.id, enabled: true });
      const run = await runtime.startForemanRun(
        {
          id: foreman.id,
          name: foreman.name,
          prompt,
          providerPolicy,
          ...(foreman.desiredModel === undefined ? {} : { desiredModel: foreman.desiredModel }),
        },
        size,
      );
      if (config.load().status.revision !== expectedConfigRevision) {
        await runtime.stopForemanRun(foreman.id);
        throw new DomainError(
          "config_revision_conflict",
          "Configuration changed while Foreman was starting",
          409,
        );
      }
      await runtime.ensureViewSession(run);
      await this.observeReporterProcess(run);
      this.#options.onRunAvailable?.(run);
      return run;
    });
  }

  public stop(expected?: StopForemanCommand): Promise<ForemanRun | undefined> {
    return this.#serialize(async () => {
      let stopped: ForemanRun | undefined;
      for (const actor of this.#options.store.listForemen()) {
        const active = this.#options.store.getActiveForemanRun(actor.id);
        if (active === undefined) continue;
        if (
          expected !== undefined &&
          (active.id !== expected.runId || active.generation !== expected.generation)
        ) {
          throw new DomainError(
            "foreman_run_changed",
            "Foreman run changed; refresh before stopping it",
            409,
          );
        }
        this.#options.onRunUnavailable?.(active.id);
        stopped = await this.#options.runtime.stopForemanRun(actor.id);
      }
      return stopped;
    });
  }

  public reconcile(): Promise<void> {
    return this.#serialize(async () => {
      const { store, config, runtime } = this.#options;
      const loaded = config.load();
      for (const actor of store.listForemen()) {
        const run = store.getActiveForemanRun(actor.id);
        if (run === undefined) continue;
        const configured = loaded.config.foreman;
        if (
          configured?.enabled !== true ||
          configured.id !== actor.id ||
          !this.#options.mcpEnabled
        ) {
          this.#options.onRunUnavailable?.(run.id);
          store.upsertForeman({ ...actor, enabled: false });
          await runtime.stopForemanRun(actor.id);
          continue;
        }
        const bound = await this.#options.bindings.requireForRecovery(run.id, run.generation);
        if (bound.binding.launchPlan.configRevision !== loaded.status.revision) {
          this.#options.onRunUnavailable?.(run.id);
          await runtime.stopForemanRun(actor.id);
          continue;
        }
        const observed = await runtime.observeRun(run);
        await this.#recordObservation(run, observed);
        if (observed.state === "dead" || observed.state === "missing") {
          this.#options.onRunUnavailable?.(run.id);
          store.updateRuntimeRunStatus(run.id, "failed", {
            reason: `foreman_process_${observed.state}`,
          });
        } else if (
          observed.state === "present" &&
          observed.process?.expectedProviderMatch === "match"
        ) {
          await runtime.ensureViewSession(run);
          this.#options.onRunAvailable?.(run);
        }
      }
    });
  }

  public async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#tail;
  }

  public async observeReporterProcess(run: ForemanRun): Promise<void> {
    await this.#recordObservation(run, await this.#options.runtime.observeRun(run));
  }

  async #recordObservation(
    run: ForemanRun,
    observation: Awaited<ReturnType<TmuxRuntime["observeRun"]>>,
  ): Promise<void> {
    if (observation.state === "present" && observation.process?.expectedProviderMatch === "match") {
      await this.#options.reporters?.observeProcess(run, observation.process);
      this.#options.store.recordRuntimeProcessStatus(run.id, {
        event: "process.alive",
        eventId: observation.id,
        observedAt: observation.observedAt,
        process: observation.process,
      });
    } else {
      this.#options.store.recordRuntimeProcessStatus(run.id, {
        event:
          observation.state === "dead"
            ? "process.exited"
            : observation.state === "missing"
              ? "process.missing"
              : "process.indeterminate",
        eventId: observation.id,
        observedAt: observation.observedAt,
      });
    }
  }

  public startMonitoring(): void {
    if (this.#closed || this.#timer !== undefined) return;
    const tick = () => {
      void this.reconcile()
        .then(
          () => {
            this.#problem = undefined;
          },
          () => {
            this.#problem =
              "Foreman runtime reconciliation is unavailable; automatic recovery is blocked";
          },
        )
        .finally(() => {
          if (!this.#closed) {
            let seconds: number;
            try {
              seconds =
                this.#options.config.load().config.foreman?.supervision.reconcileIntervalSeconds ??
                30;
            } catch {
              seconds = 30;
            }
            this.#timer = setTimeout(tick, seconds * 1000);
            this.#timer.unref();
          }
        });
    };
    this.#timer = setTimeout(tick, 0);
    this.#timer.unref();
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#closed)
      return Promise.reject(
        new DomainError("foreman_service_closed", "Foreman service is shutting down", 503),
      );
    const pending = this.#tail.then(operation);
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
}
