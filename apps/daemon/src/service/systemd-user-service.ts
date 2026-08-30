import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ActivationManifestSchema,
  type ServiceDescriptor,
  ServiceDescriptorSchema,
} from "@nanasa/contracts";
import { repositoryIdentity } from "../protocol-metadata.js";

export type ServiceOperation =
  | "install"
  | "status"
  | "start"
  | "stop"
  | "restart"
  | "upgrade"
  | "rollback"
  | "remove"
  | "logs";

export interface ServiceCommandRunner {
  run(command: string, args: readonly string[]): SpawnSyncReturns<string>;
}

interface RemovalState {
  loaded: string;
  enabled: string;
  active: string;
  failed: string;
}

const defaultRunner: ServiceCommandRunner = {
  run: (command, args) => spawnSync(command, args, { encoding: "utf8" }),
};

function instanceName(repositoryRoot: string): `nanasa-${string}` {
  return `nanasa-${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 20)}`;
}

function assertSafePath(path: string): void {
  if (!path.startsWith("/") || /[\0\r\n]/.test(path))
    throw new Error("Service paths must be absolute and single-line");
}

function unitQuote(path: string): string {
  assertSafePath(path);
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function environmentValue(path: string): string {
  assertSafePath(path);
  return path.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function commandFailure(result: SpawnSyncReturns<string>, operation: string): Error {
  const detail =
    result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? "unknown failure";
  return new Error(`systemd user service ${operation} failed: ${detail}`);
}

export class SystemdUserService {
  readonly #repositoryRoot: string;
  readonly #packageRoot: string;
  readonly #nodePath: string;
  readonly #cliPath: string;
  readonly #templatePath: string;
  readonly #runner: ServiceCommandRunner;
  readonly #home: string;
  readonly #port: number;

  public constructor(options: {
    repositoryRoot: string;
    packageRoot: string;
    nodePath?: string;
    cliPath?: string;
    templatePath?: string;
    home?: string;
    port?: number;
    runner?: ServiceCommandRunner;
  }) {
    this.#repositoryRoot = resolve(options.repositoryRoot);
    this.#packageRoot = resolve(options.packageRoot);
    this.#nodePath = resolve(options.nodePath ?? process.execPath);
    this.#cliPath = resolve(options.cliPath ?? join(this.#packageRoot, "bin", "nanasa.js"));
    this.#templatePath = resolve(
      options.templatePath ?? join(this.#packageRoot, "templates", "systemd", "nanasa.service"),
    );
    this.#runner = options.runner ?? defaultRunner;
    this.#home = resolve(options.home ?? homedir());
    this.#port = options.port ?? 3210;
    [
      this.#repositoryRoot,
      this.#packageRoot,
      this.#nodePath,
      this.#cliPath,
      this.#templatePath,
      this.#home,
    ].forEach(assertSafePath);
  }

  public get name(): string {
    return instanceName(this.#repositoryRoot);
  }

  public get unitName(): string {
    return `${this.name}.service`;
  }

  public get unitPath(): string {
    return join(this.#home, ".config", "systemd", "user", this.unitName);
  }

  public get environmentPath(): string {
    return join(this.#repositoryRoot, ".nanasa", "runtime", "service.env");
  }

  public supportDiagnostic(): string | undefined {
    if (process.platform !== "linux")
      return "Nanasa services require Linux with a systemd user manager";
    const version = this.#runner.run("systemctl", ["--version"]);
    if (version.status !== 0) return "systemctl is unavailable; use foreground nanasa start";
    return undefined;
  }

  public renderUnit(): string {
    const source = readFileSync(this.#templatePath, "utf8");
    const replacements: Record<string, string> = {
      "{{PACKAGE_ROOT}}": this.#packageRoot,
      "{{REPOSITORY_ROOT}}": unitQuote(this.#repositoryRoot),
      "{{ENVIRONMENT_FILE}}": unitQuote(this.environmentPath),
      "{{NODE_PATH}}": unitQuote(this.#nodePath),
      "{{CLI_PATH}}": unitQuote(this.#cliPath),
      "{{INSTANCE_NAME}}": this.name,
    };
    const rendered = Object.entries(replacements).reduce(
      (value, [needle, replacement]) => value.replaceAll(needle, replacement),
      source,
    );
    if (/{{[A-Z_]+}}/.test(rendered))
      throw new Error("Systemd unit template has unresolved placeholders");
    if (!rendered.includes("KillMode=process") || !rendered.includes("Restart=on-failure")) {
      throw new Error("Systemd unit must preserve tmux processes and restart failed daemons");
    }
    return rendered;
  }

  public install(): ServiceDescriptor {
    this.#assertSupported();
    mkdirSync(dirname(this.unitPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.environmentPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.environmentPath,
      `NANASA_REPO_ROOT=${environmentValue(this.#repositoryRoot)}\nNANASA_PORT=${this.#port}\n`,
      { mode: 0o600 },
    );
    chmodSync(this.environmentPath, 0o600);
    writeFileSync(this.unitPath, this.renderUnit(), { mode: 0o644 });
    this.#systemctl("daemon-reload");
    this.#systemctl("enable", this.unitName);
    return this.status("Service installed and enabled");
  }

  public start(): ServiceDescriptor {
    this.#assertInstalled();
    this.#systemctl("start", this.unitName);
    return this.status("Service start requested");
  }

  public stop(): ServiceDescriptor {
    this.#assertInstalled();
    this.#systemctl("stop", this.unitName);
    return this.status(
      "Daemon stopped; tmux-owned runs remain outside service process termination",
    );
  }

  public restart(): ServiceDescriptor {
    this.#assertInstalled();
    this.#systemctl("restart", this.unitName);
    return this.status("Daemon restarted; browsers must reconnect and resnapshot");
  }

  public remove(): ServiceDescriptor {
    this.#assertSupported();
    const unitOnDisk = existsSync(this.unitPath);
    const environmentOnDisk = existsSync(this.environmentPath);
    const initial = this.#removalState();
    const managerAbsent =
      initial.loaded === "not-found" &&
      initial.enabled === "not-found" &&
      ["inactive", "unknown", "not-found"].includes(initial.active) &&
      ["inactive", "unknown", "not-found"].includes(initial.failed);
    const alreadyAbsent = !unitOnDisk && !environmentOnDisk && managerAbsent;

    if (!alreadyAbsent) {
      if (
        initial.loaded !== "not-found" ||
        !["inactive", "unknown", "not-found"].includes(initial.active)
      ) {
        this.#systemctlForRemoval(
          "stop",
          (state) =>
            state.loaded === "not-found" &&
            ["inactive", "unknown", "not-found"].includes(state.active),
        );
      }

      let stopped = this.#removalState();
      if (
        initial.failed === "failed" ||
        initial.active === "failed" ||
        stopped.failed === "failed" ||
        stopped.active === "failed"
      ) {
        this.#systemctlForRemoval(
          "reset-failed",
          (state) => state.loaded === "not-found" && state.failed === "not-found",
        );
        stopped = this.#removalState();
      }

      this.#assertStoppedState(stopped, "after stop and reset-failed");
      if (this.#enablementNeedsDisable(stopped.enabled)) {
        this.#systemctlForRemoval(
          "disable",
          (state) => state.enabled === "not-found" && state.loaded === "not-found",
        );
        stopped = this.#removalState();
      }
      this.#assertRemovalState(stopped, "before deleting unit files", false);

      rmSync(this.unitPath, { force: true });
      rmSync(this.environmentPath, { force: true });
      this.#systemctl("daemon-reload");
      this.#assertRemovalState(this.#removalState(), "after daemon-reload", true);
    }
    return this.status("Service removed; tmux-owned runs were not terminated");
  }

  public logs(lines = 200): string {
    this.#assertInstalled();
    if (!Number.isInteger(lines) || lines < 1 || lines > 10_000)
      throw new Error("Log lines must be from 1 to 10000");
    const result = this.#runner.run("journalctl", [
      "--user-unit",
      this.unitName,
      "--no-pager",
      "-n",
      String(lines),
    ]);
    if (result.status !== 0) throw commandFailure(result, "logs");
    return result.stdout;
  }

  public async waitReady(timeoutMs = 30_000): Promise<ServiceDescriptor> {
    const started = Date.now();
    const url = `http://127.0.0.1:${this.#port}/api/v1/meta`;
    const buildPath = join(this.#packageRoot, "dist", "meta", "build.json");
    const expectedBuild = existsSync(buildPath)
      ? (JSON.parse(readFileSync(buildPath, "utf8")) as {
          packageVersion?: string;
          commit?: string;
        })
      : undefined;
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          const metadata = (await response.json()) as {
            repositoryId?: string;
            lifecycle?: string;
            productVersion?: string;
            buildCommit?: string;
          };
          if (
            metadata.repositoryId === repositoryIdentity(this.#repositoryRoot) &&
            metadata.lifecycle === "ready" &&
            (expectedBuild === undefined ||
              (metadata.productVersion === expectedBuild.packageVersion &&
                metadata.buildCommit === expectedBuild.commit))
          ) {
            return this.status("Service is ready");
          }
        }
      } catch {
        // Readiness polling is bounded and reports the final timeout below.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    throw new Error(`Service readiness timed out after ${timeoutMs}ms`);
  }

  public status(detail?: string): ServiceDescriptor {
    const unsupported = this.supportDiagnostic();
    let state: ServiceDescriptor["state"] = "unsupported";
    let resolvedDetail = detail ?? unsupported ?? "Service status is unavailable";
    if (unsupported === undefined) {
      if (!existsSync(this.unitPath)) {
        state = "not-installed";
        resolvedDetail = detail ?? "Project-local service is not installed";
      } else {
        const result = this.#runner.run("systemctl", ["--user", "is-active", this.unitName]);
        const active = result.stdout.trim();
        state =
          active === "active"
            ? "ready"
            : active === "activating"
              ? "starting"
              : active === "failed"
                ? "failed"
                : "inactive";
        resolvedDetail = detail ?? `systemd reports ${active || "inactive"}`;
      }
    }
    const lastActivation = this.#lastActivation();
    return ServiceDescriptorSchema.parse({
      formatVersion: 1,
      repositoryId: repositoryIdentity(this.#repositoryRoot),
      instanceName: this.name,
      unitName: this.unitName,
      repositoryRoot: this.#repositoryRoot,
      packageRoot: this.#packageRoot,
      nodePath: this.#nodePath,
      cliPath: this.#cliPath,
      portalUrl: `http://127.0.0.1:${this.#port}`,
      state,
      detail: resolvedDetail,
      killMode: "process",
      ...(lastActivation === undefined ? {} : { lastActivation }),
    });
  }

  #lastActivation(): ServiceDescriptor["lastActivation"] {
    const root = join(this.#repositoryRoot, ".nanasa", "runtime", "activations");
    if (!existsSync(root)) return undefined;
    const manifests = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "manifest.json"))
      .filter(existsSync)
      .flatMap((path) => {
        try {
          return [ActivationManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const latest = manifests[0];
    return latest === undefined
      ? undefined
      : {
          activationId: latest.activationId,
          createdAt: latest.createdAt,
          from: latest.from,
          to: latest.to,
          state: latest.state,
        };
  }

  #assertSupported(): void {
    const diagnostic = this.supportDiagnostic();
    if (diagnostic !== undefined) throw new Error(diagnostic);
  }

  #assertInstalled(): void {
    this.#assertSupported();
    if (!existsSync(this.unitPath))
      throw new Error("Project-local Nanasa service is not installed");
  }

  #systemctl(...args: string[]): void {
    const result = this.#runner.run("systemctl", ["--user", ...args]);
    if (result.status !== 0) throw commandFailure(result, args[0] ?? "operation");
  }

  #systemctlForRemoval(
    operation: "stop" | "disable" | "reset-failed",
    absent: (state: RemovalState) => boolean,
  ): void {
    const result = this.#runner.run("systemctl", ["--user", operation, this.unitName]);
    if (result.status === 0) return;
    if (absent(this.#removalState())) return;
    throw commandFailure(result, operation);
  }

  #removalState(): RemovalState {
    const loaded = this.#runner.run("systemctl", [
      "--user",
      "show",
      this.unitName,
      "--property=LoadState",
      "--value",
    ]);
    const enabled = this.#runner.run("systemctl", ["--user", "is-enabled", this.unitName]);
    const active = this.#runner.run("systemctl", ["--user", "is-active", this.unitName]);
    const failed = this.#runner.run("systemctl", ["--user", "is-failed", this.unitName]);
    return {
      loaded: loaded.stdout.trim() || (loaded.status === 4 ? "not-found" : "indeterminate"),
      enabled: enabled.stdout.trim() || (enabled.status === 4 ? "not-found" : "indeterminate"),
      active: active.stdout.trim() || (active.status === 4 ? "not-found" : "indeterminate"),
      failed: failed.stdout.trim() || (failed.status === 4 ? "not-found" : "indeterminate"),
    };
  }

  #enablementNeedsDisable(enabled: string): boolean {
    if (["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].includes(enabled)) {
      return true;
    }
    if (
      [
        "disabled",
        "static",
        "indirect",
        "generated",
        "transient",
        "masked",
        "masked-runtime",
        "not-found",
      ].includes(enabled)
    ) {
      return false;
    }
    throw new Error(`systemd user service enablement state is unsafe: enabled=${enabled}`);
  }

  #assertStoppedState(state: RemovalState, stage: string): void {
    if (
      !["inactive", "unknown", "not-found"].includes(state.active) ||
      !["inactive", "unknown", "not-found"].includes(state.failed)
    ) {
      throw new Error(
        `systemd user service removal state is unsafe ${stage}: loaded=${state.loaded}, enabled=${state.enabled}, active=${state.active}, failed=${state.failed}`,
      );
    }
  }

  #assertRemovalState(state: RemovalState, stage: string, requireAbsent: boolean): void {
    const loadedStates = requireAbsent ? ["not-found"] : ["loaded", "not-found"];
    const enabledStates = requireAbsent
      ? ["disabled", "not-found"]
      : [
          "disabled",
          "static",
          "indirect",
          "generated",
          "transient",
          "masked",
          "masked-runtime",
          "not-found",
        ];
    const activeStates = ["inactive", "unknown", "not-found"];
    const failedStates = ["inactive", "unknown", "not-found"];
    if (
      !loadedStates.includes(state.loaded) ||
      !enabledStates.includes(state.enabled) ||
      !activeStates.includes(state.active) ||
      !failedStates.includes(state.failed)
    ) {
      throw new Error(
        `systemd user service removal state is unsafe ${stage}: loaded=${state.loaded}, enabled=${state.enabled}, active=${state.active}, failed=${state.failed}`,
      );
    }
  }
}
