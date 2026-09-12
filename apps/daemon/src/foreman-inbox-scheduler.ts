import type { ForemanRun } from "@nanasa/contracts";
import type { ForemanRuntimeService } from "./foreman-runtime-service.js";
import { DomainError, NanasaStore } from "./store.js";
import type { TerminalInputArbiter } from "./terminal/terminal-input-arbiter.js";
import type { TmuxRuntime } from "./tmux-runtime.js";

interface InboxRow {
  id: string;
  prompt: string;
}

export class ForemanInboxScheduler {
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> | undefined;
  #closed = false;
  public constructor(
    private readonly store: NanasaStore,
    private readonly foreman: Pick<ForemanRuntimeService, "status" | "observeReporterProcess">,
    private readonly runtime: Pick<TmuxRuntime, "pasteToRun">,
    private readonly arbiter: Pick<TerminalInputArbiter, "dispatchAutomated">,
    private readonly hasController: (runId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
    private readonly authorizeGoalInput?: (inboxId: string) => void,
  ) {}

  public start(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.store.database
      .prepare(
        "UPDATE foreman_inbox SET state = 'ambiguous', updated_at = ? WHERE state = 'writing'",
      )
      .run(this.now().toISOString());
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1000);
    this.#timer.unref();
  }

  public tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#pending !== undefined) return this.#pending;
    this.#pending = this.#dispatch().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#pending;
  }

  #ready(run: ForemanRun): boolean {
    const current = this.store.getActiveForemanRun(run.foremanId);
    const actor = this.store.getForeman(run.foremanId);
    const state = this.store.getRuntimeStatusState(run.id);
    const reporter = this.store.getCurrentReporterSession(run.id, run.generation);
    const now = this.now().getTime();
    return (
      actor.enabled &&
      current?.id === run.id &&
      current.generation === run.generation &&
      current.status === "running" &&
      ["idle", "recovered"].includes(current.recoveryPhase) &&
      current.desiredState === "running" &&
      !this.hasController(run.id) &&
      state.state === "idle" &&
      state.interactiveReady &&
      !state.staleAuthority &&
      state.processState === "present" &&
      state.authorityKind === "reporter" &&
      reporter !== undefined &&
      reporter.reporterEpoch === state.reporterEpoch &&
      reporter.processFingerprint === state.processFingerprint &&
      Date.parse(reporter.leaseExpiresAt) > now &&
      Date.parse(state.reporterLeaseExpiresAt ?? "") > now &&
      Date.parse(state.transportLeaseExpiresAt ?? "") > now
    );
  }

  async #dispatch(): Promise<void> {
    const view = this.foreman.status();
    const run = view.run;
    if (
      run === undefined ||
      view.configuration?.enabled !== true ||
      run.status !== "running" ||
      !this.#ready(run)
    )
      return;
    const blocked = this.store.database
      .prepare(
        "SELECT id FROM foreman_inbox WHERE state IN ('writing', 'submitted', 'ambiguous') LIMIT 1",
      )
      .get();
    if (blocked !== undefined) return;
    const item = this.store.database
      .prepare("SELECT * FROM foreman_inbox WHERE state = 'queued' ORDER BY created_at, id LIMIT 1")
      .get() as unknown as InboxRow | undefined;
    if (item === undefined) return;
    try {
      this.authorizeGoalInput?.(item.id);
    } catch {
      this.store.database
        .prepare(
          "UPDATE foreman_inbox SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued'",
        )
        .run(this.now().toISOString(), item.id);
      return;
    }
    await this.arbiter.dispatchAutomated(run.id, async () => {
      await this.foreman.observeReporterProcess(run);
      if (!this.#ready(run)) return;
      const initial = this.store.getRuntimeStatusState(run.id);
      const actor = this.store.getForeman(run.foremanId);
      const target = {
        runId: run.id,
        generation: run.generation,
        reporterEpoch: initial.reporterEpoch,
        statusRevision: initial.statusRevision,
        stateChangedAt: initial.stateChangedAt,
        completionRevision: initial.completionRevision,
        processFingerprint: initial.processFingerprint,
        authorityRevision: actor.authorityRevision,
      };
      const claimed =
        this.store.database
          .prepare(
            "UPDATE foreman_inbox SET state = 'writing', target_json = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
          )
          .run(JSON.stringify(target), this.now().toISOString(), item.id).changes === 1;
      if (!claimed) return;
      try {
        await this.runtime.pasteToRun(run, item.prompt, () => {
          this.authorizeGoalInput?.(item.id);
          const state = this.store.getRuntimeStatusState(run.id);
          const view = this.foreman.status();
          if (
            this.#closed ||
            view.configuration?.enabled !== true ||
            view.actor?.authorityRevision !== target.authorityRevision ||
            !this.#ready(run) ||
            state.reporterEpoch !== target.reporterEpoch ||
            state.stateChangedAt !== target.stateChangedAt ||
            state.completionRevision !== target.completionRevision ||
            state.processFingerprint !== target.processFingerprint
          ) {
            throw new DomainError("foreman_input_fenced", "Foreman input target changed", 409);
          }
        });
        this.store.database
          .prepare(
            "UPDATE foreman_inbox SET state = 'submitted', updated_at = ? WHERE id = ? AND state = 'writing'",
          )
          .run(this.now().toISOString(), item.id);
      } catch {
        this.store.database
          .prepare(
            "UPDATE foreman_inbox SET state = 'ambiguous', updated_at = ? WHERE id = ? AND state = 'writing'",
          )
          .run(this.now().toISOString(), item.id);
      }
    });
  }
}
