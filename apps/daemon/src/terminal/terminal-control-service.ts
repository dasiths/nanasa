import { randomUUID } from "node:crypto";
import type { AgentRun, TerminalLease, TerminalRole } from "@nanasa/contracts";
import { DomainError, type NanasaStore } from "../store.js";
import { TERMINAL_LIMITS } from "./terminal-transport-limits.js";

interface Viewer {
  readonly viewerId: string;
  readonly streamId: string;
  readonly streamGeneration: number;
  role: TerminalRole;
  lease?: TerminalLease;
  heartbeatAt: number;
  readonly close: (code: number, reason: string) => void;
}

interface RunControl {
  run: AgentRun;
  streamGeneration: number;
  viewers: Map<string, Viewer>;
  controllerStreamId?: string;
}

export class TerminalControlService {
  readonly #store: NanasaStore;
  readonly #now: () => Date;
  readonly #runs = new Map<string, RunControl>();
  readonly #expiry: NodeJS.Timeout;

  public constructor(store: NanasaStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
    this.#expiry = setInterval(() => this.expire(), TERMINAL_LIMITS.heartbeatMs);
    this.#expiry.unref();
  }

  public register(run: AgentRun): void {
    if (run.terminal === undefined) throw new Error("Terminal binding is required");
    const existing = this.#runs.get(run.id);
    if (existing !== undefined && existing.run.generation === run.generation) {
      existing.run = run;
      return;
    }
    if (existing !== undefined) this.unregister(run.id, "binding_changed");
    this.#runs.set(run.id, {
      run,
      streamGeneration: (existing?.streamGeneration ?? 0) + 1,
      viewers: new Map(),
    });
  }

  public unregister(runId: string, reason = "terminal_stopped"): void {
    const control = this.#runs.get(runId);
    if (control === undefined) return;
    this.#runs.delete(runId);
    for (const viewer of control.viewers.values()) viewer.close(1012, reason);
    this.#audit("terminal.endpoint.removed", runId, { reason });
  }

  public connect(input: {
    runId: string;
    runGeneration: number;
    viewerId: string;
    requestedRole: TerminalRole;
    takeover: boolean;
    close: (code: number, reason: string) => void;
  }): { viewer: Viewer; run: AgentRun } {
    const control = this.#runs.get(input.runId);
    if (control === undefined)
      throw new DomainError("terminal_unavailable", "Terminal is unavailable", 503);
    if (control.run.generation !== input.runGeneration)
      throw new DomainError("terminal_generation_stale", "Terminal generation is stale", 409);
    if (control.viewers.size >= TERMINAL_LIMITS.maxViewers)
      throw new DomainError("terminal_viewer_limit", "Terminal viewer limit reached", 429);
    if ([...control.viewers.values()].some((viewer) => viewer.viewerId === input.viewerId))
      throw new DomainError("terminal_viewer_duplicate", "Viewer is already connected", 409);
    const streamId = `stream_${randomUUID()}`;
    const viewer: Viewer = {
      viewerId: input.viewerId,
      streamId,
      streamGeneration: control.streamGeneration,
      role: "observer",
      heartbeatAt: this.#now().getTime(),
      close: input.close,
    };
    control.viewers.set(streamId, viewer);
    if (
      input.requestedRole === "controller" &&
      (control.controllerStreamId === undefined || input.takeover)
    )
      this.#grant(control, viewer, input.takeover);
    const observers = [...control.viewers.values()].filter(
      (candidate) => candidate.role === "observer",
    ).length;
    if (viewer.role === "observer" && observers > TERMINAL_LIMITS.maxObservers) {
      control.viewers.delete(streamId);
      throw new DomainError("terminal_observer_limit", "Terminal observer limit reached", 429);
    }
    this.#audit("terminal.viewer.connected", input.runId, {
      viewerId: input.viewerId,
      role: viewer.role,
    });
    return { viewer, run: control.run };
  }

  public takeover(runId: string, streamId: string, expectedLeaseId?: string): TerminalLease {
    const { control, viewer } = this.#viewer(runId, streamId);
    const current =
      control.controllerStreamId === undefined
        ? undefined
        : control.viewers.get(control.controllerStreamId);
    if (expectedLeaseId !== undefined && current?.lease?.id !== expectedLeaseId)
      throw new DomainError("terminal_lease_conflict", "Controller lease changed", 409);
    this.#grant(control, viewer, true);
    return viewer.lease as TerminalLease;
  }

  public heartbeat(runId: string, streamId: string, leaseId?: string): TerminalLease | undefined {
    const { viewer } = this.#viewer(runId, streamId);
    viewer.heartbeatAt = this.#now().getTime();
    if (viewer.lease !== undefined) {
      if (leaseId !== viewer.lease.id)
        throw new DomainError("terminal_lease_stale", "Controller lease is stale", 409);
      viewer.lease = {
        ...viewer.lease,
        expiresAt: new Date(viewer.heartbeatAt + TERMINAL_LIMITS.leaseMs).toISOString(),
      };
    }
    return viewer.lease;
  }

  public assertController(runId: string, streamId: string, leaseId: string): Viewer {
    const { control, viewer } = this.#viewer(runId, streamId);
    if (
      control.controllerStreamId !== streamId ||
      viewer.role !== "controller" ||
      viewer.lease?.id !== leaseId ||
      Date.parse(viewer.lease.expiresAt) <= this.#now().getTime()
    )
      throw new DomainError(
        "terminal_controller_required",
        "An active controller lease is required",
        403,
      );
    return viewer;
  }

  public disconnect(runId: string, streamId: string): void {
    const control = this.#runs.get(runId);
    const viewer = control?.viewers.get(streamId);
    if (control === undefined || viewer === undefined) return;
    control.viewers.delete(streamId);
    if (control.controllerStreamId === streamId) delete control.controllerStreamId;
    this.#audit("terminal.viewer.disconnected", runId, {
      viewerId: viewer.viewerId,
      role: viewer.role,
    });
  }

  public hasController(runId: string): boolean {
    const control = this.#runs.get(runId);
    if (control?.controllerStreamId === undefined) return false;
    const viewer = control.viewers.get(control.controllerStreamId);
    return (
      viewer?.lease !== undefined && Date.parse(viewer.lease.expiresAt) > this.#now().getTime()
    );
  }

  public status(runId: string) {
    const control = this.#runs.get(runId);
    if (control === undefined) {
      const run = this.#store.getRun(runId);
      return {
        runId,
        provider: "nanasa-terminal.v1" as const,
        state:
          run.status === "stopped" || run.status === "failed"
            ? ("stopped" as const)
            : ("unavailable" as const),
      };
    }
    const controller =
      control.controllerStreamId === undefined
        ? undefined
        : control.viewers.get(control.controllerStreamId);
    return {
      runId,
      provider: "nanasa-terminal.v1" as const,
      state: "ready" as const,
      streamUrl: `/api/v1/terminal-stream/${encodeURIComponent(runId)}`,
      protocol: "nanasa-terminal.v1" as const,
      limits: TERMINAL_LIMITS,
      ...(controller === undefined ? {} : { controllerViewerId: controller.viewerId }),
      observers: [...control.viewers.values()].filter((viewer) => viewer.role === "observer")
        .length,
    };
  }

  public expire(): void {
    const now = this.#now().getTime();
    for (const [runId, control] of this.#runs) {
      for (const viewer of control.viewers.values()) {
        if (now - viewer.heartbeatAt <= TERMINAL_LIMITS.leaseMs) continue;
        viewer.close(1008, "terminal_lease_expired");
        this.disconnect(runId, viewer.streamId);
        this.#audit("terminal.lease.expired", runId, { viewerId: viewer.viewerId });
      }
    }
  }

  public close(): void {
    clearInterval(this.#expiry);
    for (const runId of [...this.#runs.keys()]) this.unregister(runId, "server_restart");
  }

  #grant(control: RunControl, viewer: Viewer, takeover: boolean): void {
    const previous =
      control.controllerStreamId === undefined
        ? undefined
        : control.viewers.get(control.controllerStreamId);
    if (previous !== undefined && previous.streamId !== viewer.streamId) {
      previous.role = "observer";
      delete previous.lease;
      previous.close(4001, "terminal_controller_taken_over");
    }
    const acquiredAt = this.#now();
    viewer.role = "controller";
    viewer.lease = {
      id: `lease_${randomUUID()}`,
      runId: control.run.id,
      viewerId: viewer.viewerId,
      role: "controller",
      runGeneration: control.run.generation,
      streamGeneration: control.streamGeneration,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + TERMINAL_LIMITS.leaseMs).toISOString(),
    };
    control.controllerStreamId = viewer.streamId;
    this.#audit(
      takeover ? "terminal.lease.taken-over" : "terminal.lease.acquired",
      control.run.id,
      { viewerId: viewer.viewerId },
    );
  }

  #viewer(runId: string, streamId: string): { control: RunControl; viewer: Viewer } {
    const control = this.#runs.get(runId);
    const viewer = control?.viewers.get(streamId);
    if (control === undefined || viewer === undefined)
      throw new DomainError("terminal_stream_inactive", "Terminal stream is inactive", 409);
    return { control, viewer };
  }

  #audit(type: string, runId: string, payload: Record<string, unknown>): void {
    this.#store.recordRuntimeEvent(type, "run", runId, payload);
  }
}

export type TerminalViewer = Viewer;
