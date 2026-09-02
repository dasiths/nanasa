import { spawn, spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { PROVIDER_RPC_MAX_FRAME_BYTES } from "@nanasa/contracts";

export interface ProviderCompilerSandboxStatus {
  readonly available: boolean;
  readonly code:
    | "available"
    | "manual-compilation-required"
    | "binary-unavailable"
    | "namespace-unavailable";
}

export type ProviderCompilerMode = "manual" | "sandboxed";

export interface ProviderCompilerRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly input: unknown;
  readonly timeoutMs?: number;
}

export interface ProviderCompilerResult {
  readonly output: unknown;
  readonly stderrCode?: "compiler-stderr";
}

export interface ProviderCompilerSupervisorOptions {
  readonly mode?: ProviderCompilerMode;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sandboxPath?: string;
  readonly prlimitPath?: string;
  readonly probe?: () => ProviderCompilerSandboxStatus;
}

const MAX_STDERR_BYTES = 64 * 1_024;

export class ProviderCompilerSupervisor {
  readonly #mode: ProviderCompilerMode;
  readonly #sandboxPath: string;
  readonly #prlimitPath: string;
  readonly #probeOverride: ProviderCompilerSupervisorOptions["probe"];

  public constructor(options: ProviderCompilerSupervisorOptions = {}) {
    const environment = options.environment ?? process.env;
    const mode = options.mode ?? environment.NANASA_PROVIDER_COMPILER_MODE ?? "manual";
    if (mode !== "manual" && mode !== "sandboxed") {
      throw new Error("NANASA_PROVIDER_COMPILER_MODE must be manual or sandboxed");
    }
    this.#mode = mode;
    this.#sandboxPath = options.sandboxPath ?? "/usr/bin/bwrap";
    this.#prlimitPath = options.prlimitPath ?? "/usr/bin/prlimit";
    this.#probeOverride = options.probe;
  }

  public probe(): ProviderCompilerSandboxStatus {
    if (this.#mode === "manual") {
      return { available: false, code: "manual-compilation-required" };
    }
    if (this.#probeOverride !== undefined) return this.#probeOverride();
    if (!isAbsolute(this.#sandboxPath) || !isAbsolute(this.#prlimitPath)) {
      return { available: false, code: "binary-unavailable" };
    }
    const result = spawnSync(
      this.#sandboxPath,
      [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "/bin/true",
      ],
      { encoding: "utf8", timeout: 2_000, env: { PATH: "/usr/bin:/bin" } },
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { available: false, code: "binary-unavailable" };
    }
    return result.status === 0
      ? { available: true, code: "available" }
      : { available: false, code: "namespace-unavailable" };
  }

  public async compile(request: ProviderCompilerRequest): Promise<ProviderCompilerResult> {
    const status = this.probe();
    if (!status.available) {
      if (status.code === "manual-compilation-required") {
        throw new Error(
          "Provider compilation is in manual mode; compile outside Nanasa and import the resolved signed package",
        );
      }
      throw new Error(`Provider compiler sandbox is unavailable: ${status.code}`);
    }
    if (
      !isAbsolute(request.executable) ||
      request.executable.includes("\0") ||
      (!request.executable.startsWith("/usr/") && !request.executable.startsWith("/bin/"))
    ) {
      throw new Error("Provider compiler executable must be an absolute read-only system path");
    }
    if (
      request.args.length > 128 ||
      request.args.some((argument) => argument.length > 4_096 || argument.includes("\0"))
    ) {
      throw new Error("Provider compiler arguments exceed bounded direct-exec limits");
    }
    const input = Buffer.from(JSON.stringify(request.input), "utf8");
    if (input.length === 0 || input.length > PROVIDER_RPC_MAX_FRAME_BYTES) {
      throw new Error("Provider compiler input exceeds the RPC frame limit");
    }
    const timeoutMs = request.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      throw new Error("Provider compiler timeout is outside the supported range");
    }
    const sandboxArguments = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/work",
      "--chdir",
      "/work",
      this.#prlimitPath,
      "--cpu=30",
      "--as=1073741824",
      "--nproc=16",
      "--nofile=128",
      "--fsize=16777216",
      "--",
      request.executable,
      ...request.args,
    ];
    return new Promise<ProviderCompilerResult>((resolvePromise, reject) => {
      const child = spawn(this.#sandboxPath, sandboxArguments, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        shell: false,
        detached: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const killProcessGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const finish = (error?: Error, output?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else
          resolvePromise({
            output,
            ...(stderrBytes === 0 ? {} : { stderrCode: "compiler-stderr" }),
          });
      };
      const timer = setTimeout(() => {
        killProcessGroup();
        finish(new Error("Provider compiler timed out"));
      }, timeoutMs);
      child.once("error", (error) => finish(error));
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > PROVIDER_RPC_MAX_FRAME_BYTES) {
          killProcessGroup();
          finish(new Error("Provider compiler output exceeds the RPC frame limit"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          finish(
            new Error(
              `Provider compiler failed: ${signal === null ? `exit-${code ?? "unknown"}` : `signal-${signal}`}`,
            ),
          );
          return;
        }
        try {
          const text = Buffer.concat(stdout).toString("utf8");
          finish(undefined, JSON.parse(text));
        } catch {
          finish(new Error("Provider compiler returned malformed JSON"));
        }
      });
      child.stdin.end(input);
    });
  }
}
