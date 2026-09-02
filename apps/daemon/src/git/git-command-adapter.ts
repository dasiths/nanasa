import { spawn } from "node:child_process";

const DEFAULT_STDOUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly stdoutLimit?: number;
  readonly stderrLimit?: number;
  readonly allowFailure?: boolean;
  readonly signal?: AbortSignal;
}

export class GitCommandError extends Error {
  public constructor(
    public readonly code: string,
    public readonly result: GitCommandResult,
  ) {
    super(result.stderr.trim() || `git exited with status ${result.exitCode}`);
    this.name = "GitCommandError";
  }
}

export class GitCommandAdapter {
  public constructor(private readonly executable = "git") {}

  public run(
    arguments_: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    if (arguments_.length === 0 || arguments_.some((argument) => argument.includes("\0"))) {
      throw new Error("Git arguments must be nonempty and may not contain NUL characters");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...arguments_], {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let failureCode: string | undefined;
      const timeout = setTimeout(() => {
        failureCode = "git_timeout";
        child.kill("SIGKILL");
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref();

      const abort = () => {
        failureCode = "git_cancelled";
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      const collect = (
        chunk: Buffer,
        chunks: Buffer[],
        currentBytes: number,
        limit: number,
        code: string,
      ): number => {
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > limit) {
          failureCode = code;
          child.kill("SIGKILL");
          return nextBytes;
        }
        chunks.push(chunk);
        return nextBytes;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = collect(
          chunk,
          stdoutChunks,
          stdoutBytes,
          options.stdoutLimit ?? DEFAULT_STDOUT_LIMIT,
          "git_stdout_limit",
        );
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = collect(
          chunk,
          stderrChunks,
          stderrBytes,
          options.stderrLimit ?? DEFAULT_STDERR_LIMIT,
          "git_stderr_limit",
        );
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        const result = {
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        };
        if (failureCode !== undefined) {
          reject(new GitCommandError(failureCode, result));
          return;
        }
        if (result.exitCode !== 0 && options.allowFailure !== true) {
          reject(new GitCommandError("git_command_failed", result));
          return;
        }
        resolve(result);
      });
    });
  }
}
