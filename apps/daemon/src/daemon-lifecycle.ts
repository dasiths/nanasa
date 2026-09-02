export type DaemonLifecycleState = "starting" | "ready" | "draining" | "stopped";

export class DaemonLifecycle {
  #state: DaemonLifecycleState = "starting";

  public get state(): DaemonLifecycleState {
    return this.#state;
  }

  public markReady(): void {
    if (this.#state !== "starting") throw new Error(`Cannot become ready from ${this.#state}`);
    this.#state = "ready";
  }

  public beginDraining(): void {
    if (this.#state === "stopped") return;
    this.#state = "draining";
  }

  public markStopped(): void {
    this.#state = "stopped";
  }

  public assertMutationAllowed(): void {
    if (this.#state === "draining" || this.#state === "stopped") {
      const error = new Error("The daemon is draining and no longer accepts mutations") as Error & {
        code: string;
        statusCode: number;
      };
      error.code = "daemon_draining";
      error.statusCode = 503;
      throw error;
    }
  }
}
