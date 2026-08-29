import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, CredentialProfileReference } from "@nanasa/contracts";
import { z } from "zod";

const CredentialProfileSchema = z
  .object({
    provider: z.enum(["copilot", "claude-code", "pi", "opencode"]),
    source: z.enum(["environment", "helper"]),
    sourceEnvironment: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    targetEnvironment: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    helperCommand: z.array(z.string().min(1).max(4_096)).min(1).max(16).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.source === "environment" && profile.sourceEnvironment === undefined) {
      context.addIssue({
        code: "custom",
        message: "Environment profiles require sourceEnvironment",
        path: ["sourceEnvironment"],
      });
    }
    if (profile.source === "helper" && profile.helperCommand === undefined) {
      context.addIssue({
        code: "custom",
        message: "Helper profiles require helperCommand",
        path: ["helperCommand"],
      });
    }
  });
const BrokerFileSchema = z
  .object({
    version: z.literal(1),
    profiles: z.record(z.string().min(1).max(128), CredentialProfileSchema),
  })
  .strict();
type CredentialProfile = z.infer<typeof CredentialProfileSchema>;

export interface CredentialDelivery {
  readonly mode: "provider-managed" | "broker-profile";
  readonly profileId?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly health: "available" | "provider-managed" | "missing";
}

export interface UserCredentialBrokerOptions {
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  profiles?: Readonly<Record<string, CredentialProfile>>;
}

export class UserCredentialBroker {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #profiles: Readonly<Record<string, CredentialProfile>>;

  public constructor(options: UserCredentialBrokerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#profiles = Object.freeze({ ...(options.profiles ?? this.#load(options.configPath)) });
  }

  public resolve(
    reference: CredentialProfileReference,
    provider: AgentKind,
    allowedTargetNames: readonly string[],
  ): CredentialDelivery {
    if (reference.kind === "provider-managed") {
      return Object.freeze({
        mode: "provider-managed",
        environment: Object.freeze({}),
        health: "provider-managed",
      });
    }
    const profile = this.#profiles[reference.profileId];
    if (profile === undefined)
      throw new Error(`Credential profile is unavailable: ${reference.profileId}`);
    if (profile.provider !== provider)
      throw new Error("Credential profile provider does not match the selected adapter");
    if (!allowedTargetNames.includes(profile.targetEnvironment))
      throw new Error("Credential target is not allowed by the provider adapter");
    const value =
      profile.source === "environment"
        ? this.#environment[profile.sourceEnvironment!]
        : this.#runHelper(profile.helperCommand!);
    if (value === undefined || value.length === 0) {
      return Object.freeze({
        mode: "broker-profile",
        profileId: reference.profileId,
        environment: Object.freeze({}),
        health: "missing",
      });
    }
    if (Buffer.byteLength(value, "utf8") > 16_384 || /[\0\r\n]/.test(value))
      throw new Error("Credential helper output is malformed or oversized");
    return Object.freeze({
      mode: "broker-profile",
      profileId: reference.profileId,
      environment: Object.freeze({ [profile.targetEnvironment]: value }),
      health: "available",
    });
  }

  public describe(reference: CredentialProfileReference): Readonly<Record<string, string>> {
    if (reference.kind === "provider-managed") return Object.freeze({ mode: "provider-managed" });
    const profile = this.#profiles[reference.profileId];
    return Object.freeze({
      mode: "broker-profile",
      profileId: reference.profileId,
      provider: profile?.provider ?? "unavailable",
      source: profile?.source ?? "unavailable",
    });
  }

  public redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|secret|password|credential|authorization|api[_-]?key/i.test(key)
          ? "[REDACTED]"
          : this.redact(entry),
      ]),
    );
  }

  #runHelper(command: readonly string[]): string | undefined {
    const [executable, ...args] = command;
    const result = spawnSync(executable!, args, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16_385,
      env: this.#environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error !== undefined || result.status !== 0) return undefined;
    return result.stdout.trim();
  }

  #load(configPath?: string): Readonly<Record<string, CredentialProfile>> {
    const path =
      configPath ??
      join(
        this.#environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "nanasa",
        "credentials.json",
      );
    if (!existsSync(path)) return Object.freeze({});
    const status = lstatSync(path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      (status.mode & 0o077) !== 0 ||
      status.size > 256 * 1024
    )
      throw new Error("Credential broker file must be a private bounded regular file");
    if (typeof process.getuid === "function" && status.uid !== process.getuid())
      throw new Error("Credential broker file must be owned by the current user");
    return BrokerFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).profiles;
  }
}
