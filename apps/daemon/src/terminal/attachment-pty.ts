import type { AgentRun } from "@nanasa/contracts";
import { spawn, type IPty } from "node-pty";
import { terminalViewSessionName } from "./terminal-input-arbiter.js";

export interface AttachmentPtyOptions {
  tmuxPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class AttachmentPty {
  readonly #pty: IPty;
  #closed = false;

  public constructor(
    run: AgentRun,
    role: "controller" | "observer",
    size: { cols: number; rows: number },
    options: AttachmentPtyOptions = {},
  ) {
    if (run.terminal === undefined) throw new Error("Terminal binding is required");
    const attachArguments = [
      "-L",
      run.terminal.serverName,
      "-f",
      "/dev/null",
      "attach-session",
      "-t",
      `=${terminalViewSessionName(run.id)}`,
    ];
    if (role === "observer") attachArguments.push("-r", "-f", "read-only,ignore-size");
    this.#pty = spawn(options.tmuxPath ?? "tmux", attachArguments, {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: { ...process.env, ...options.env, TERM: "xterm-256color" },
    });
  }

  public get pid(): number {
    return this.#pty.pid;
  }

  public onData(listener: (data: string) => void): { dispose(): void } {
    return this.#pty.onData(listener);
  }

  public onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    return this.#pty.onExit(listener);
  }

  public write(data: string): void {
    if (!this.#closed) this.#pty.write(data);
  }

  public resize(cols: number, rows: number): void {
    if (!this.#closed) this.#pty.resize(cols, rows);
  }

  public close(signal: string = "SIGHUP"): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#pty.kill(signal);
    } catch {
      // The PTY may have already reaped its tmux attachment.
    }
  }
}
