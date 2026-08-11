import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { NanasaConfig, PortalSnapshot } from "@nanasa/contracts";
import { parseDocument } from "yaml";
import {
  type LoadedNanasaConfig,
  loadNanasaConfig,
  nanasaPaths,
  parseNanasaConfigSource,
} from "./config.js";

export interface ConfigMutation<T> {
  config: NanasaConfig;
  result: T;
}

export class ConfigRepository {
  readonly #repositoryRoot: string;
  #queue: Promise<void> = Promise.resolve();

  public constructor(repositoryRoot: string) {
    this.#repositoryRoot = repositoryRoot;
  }

  public load(): LoadedNanasaConfig {
    return loadNanasaConfig(this.#repositoryRoot);
  }

  public initializeTopology(snapshot: PortalSnapshot): LoadedNanasaConfig {
    const current = this.load();
    if (current.hasDeclarativeTopology) return current;
    const agentProfiles = Object.fromEntries(
      snapshot.agentProfiles.map((profile) => [
        profile.id,
        { name: profile.name, agentType: profile.agentType, instructions: [] },
      ]),
    );
    const groups = Object.fromEntries(
      snapshot.groups.map((group) => [
        group.id,
        {
          name: group.name,
          instructions: [],
          memberships: Object.fromEntries(
            snapshot.memberships
              .filter((membership) => membership.groupId === group.id)
              .map((membership) => [
                membership.id,
                {
                  memberId: membership.memberId,
                  agentProfileId: membership.agentProfileId,
                  alias: membership.alias,
                  instructions: [],
                },
              ]),
          ),
        },
      ]),
    );
    this.#write(current, { ...current.config, agentProfiles, groups });
    return this.load();
  }

  public mutate<T>(
    mutate: (config: NanasaConfig) => ConfigMutation<T>,
  ): Promise<{ loaded: LoadedNanasaConfig; result: T }> {
    let resolveResult: (value: { loaded: LoadedNanasaConfig; result: T }) => void;
    let rejectResult: (error: unknown) => void;
    const result = new Promise<{ loaded: LoadedNanasaConfig; result: T }>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#queue = this.#queue
      .then(() => {
        const current = this.load();
        const mutation = mutate(structuredClone(current.config));
        this.#write(current, mutation.config);
        resolveResult({ loaded: this.load(), result: mutation.result });
      })
      .catch((error: unknown) => {
        rejectResult(error);
      });
    return result;
  }

  #write(current: LoadedNanasaConfig, config: NanasaConfig): void {
    const source = readFileSync(current.configPath, "utf8");
    const actualRevision = createHash("sha256").update(source).digest("hex");
    if (actualRevision !== current.status.revision) {
      throw new Error("Configuration changed while preparing an update; retry the operation");
    }
    const document = parseDocument(source, { version: "1.2" });
    document.set("instructions", config.instructions);
    document.set("roles", config.roles);
    document.set("agentProfiles", config.agentProfiles);
    document.set("groups", config.groups);
    document.set("messages", config.messages);
    const candidate = document.toString({ lineWidth: 100 });
    parseNanasaConfigSource(candidate, nanasaPaths(this.#repositoryRoot));

    const temporaryPath = `${current.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const mode = statSync(current.configPath).mode & 0o777;
    writeFileSync(temporaryPath, candidate, { encoding: "utf8", mode });
    const fileDescriptor = openSync(temporaryPath, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    const revisionBeforeRename = createHash("sha256")
      .update(readFileSync(current.configPath, "utf8"))
      .digest("hex");
    if (revisionBeforeRename !== actualRevision) {
      unlinkSync(temporaryPath);
      throw new Error(
        "Configuration changed before the update could be committed; retry the operation",
      );
    }
    renameSync(temporaryPath, current.configPath);
    const directoryDescriptor = openSync(dirname(current.configPath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}
