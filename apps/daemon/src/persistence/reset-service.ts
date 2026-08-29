import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { nanasaPaths } from "../config-v2.js";
import { openNanasaDatabase, verifyDatabaseIntegrity } from "./database.js";

export interface AlphaResetInventory {
  databasePresent: boolean;
  databaseBytes: number;
  runtimeEntries: number;
  providerStateEntries: number;
  ownedTmuxPanes: number;
}

export interface AlphaResetResult {
  backupDirectory: string;
  databaseBackup?: string;
  configBackup: string;
  removedOwnedTmuxPanes: number;
  inventory: AlphaResetInventory;
}

function countEntries(path: string): number {
  return existsSync(path) ? readdirSync(path, { recursive: true }).length : 0;
}

function ownedTmuxPanes(serverName: string, tmuxPath: string): string[] {
  const listed = spawnSync(
    tmuxPath,
    [
      "-L",
      serverName,
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{@nanasa-run-id}\t#{@nanasa-generation}",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (listed.status !== 0) {
    const error = listed.stderr.trim();
    if (/no server running|failed to connect|no such file/i.test(error)) return [];
    throw new Error("Could not inventory Nanasa-owned tmux panes");
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      (fields): fields is [string, string, string] =>
        fields.length === 3 &&
        /^%[0-9]+$/.test(fields[0] ?? "") &&
        /^run_[A-Za-z0-9_-]+$/.test(fields[1] ?? "") &&
        /^[1-9][0-9]*$/.test(fields[2] ?? ""),
    )
    .map(([paneId]) => paneId);
}

export function inventoryAlphaResources(
  repositoryRoot: string,
  options: { tmuxServerName?: string; tmuxPath?: string } = {},
): AlphaResetInventory {
  const paths = nanasaPaths(repositoryRoot);
  const databasePresent = existsSync(paths.dataPath);
  return {
    databasePresent,
    databaseBytes: databasePresent ? statSync(paths.dataPath).size : 0,
    runtimeEntries: countEntries(paths.runtimeDirectory),
    providerStateEntries: countEntries(paths.integrationsDirectory),
    ownedTmuxPanes: ownedTmuxPanes(options.tmuxServerName ?? "nanasa", options.tmuxPath ?? "tmux")
      .length,
  };
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o644 });
  const descriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  const directoryDescriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

async function createVerifiedBackup(sourcePath: string, backupPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec("PRAGMA busy_timeout = 5000");
    source.exec("PRAGMA wal_checkpoint(PASSIVE)");
    await backup(source, backupPath, { rate: 100 });
  } finally {
    source.close();
  }
  verifyDatabaseIntegrity(backupPath);
}

export async function resetFromAlpha(options: {
  repositoryRoot: string;
  confirmation: string;
  configTemplate: string;
  tmuxServerName?: string;
  tmuxPath?: string;
}): Promise<AlphaResetResult> {
  const repositoryRoot = resolve(options.repositoryRoot);
  if (options.confirmation !== repositoryRoot) {
    throw new Error(`Reset confirmation must exactly match the repository root: ${repositoryRoot}`);
  }
  const paths = nanasaPaths(repositoryRoot);
  if (!existsSync(paths.configPath)) throw new Error("Nanasa configuration was not found");
  const tmuxServerName = options.tmuxServerName ?? "nanasa";
  const tmuxPath = options.tmuxPath ?? "tmux";
  const panes = ownedTmuxPanes(tmuxServerName, tmuxPath);
  const inventory = inventoryAlphaResources(repositoryRoot, { tmuxServerName, tmuxPath });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backupDirectory = join(repositoryRoot, ".nanasa", "backups", `alpha-${stamp}`);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const configBackup = join(backupDirectory, "config.yaml");
  copyFileSync(paths.configPath, configBackup);
  let databaseBackup: string | undefined;
  if (existsSync(paths.dataPath)) {
    databaseBackup = join(backupDirectory, "nanasa.sqlite");
    await createVerifiedBackup(paths.dataPath, databaseBackup);
  }
  if (existsSync(paths.integrationsDirectory)) {
    cpSync(paths.integrationsDirectory, join(backupDirectory, "provider-state"), {
      recursive: true,
      preserveTimestamps: true,
    });
  }

  let removedOwnedTmuxPanes = 0;
  for (const paneId of panes) {
    const killed = spawnSync(tmuxPath, ["-L", tmuxServerName, "kill-pane", "-t", paneId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (killed.status === 0) removedOwnedTmuxPanes += 1;
  }

  rmSync(paths.stateDirectory, { recursive: true, force: true });
  rmSync(paths.runtimeDirectory, { recursive: true, force: true });
  rmSync(paths.integrationsDirectory, { recursive: true, force: true });
  writeAtomic(paths.configPath, options.configTemplate);
  const initialized = openNanasaDatabase(paths.dataPath);
  initialized.close();

  return {
    backupDirectory,
    ...(databaseBackup === undefined ? {} : { databaseBackup }),
    configBackup,
    removedOwnedTmuxPanes,
    inventory,
  };
}

export function formatRedactedResetInventory(inventory: AlphaResetInventory): string {
  return [
    `database: ${inventory.databasePresent ? `${inventory.databaseBytes} bytes` : "absent"}`,
    `runtime entries: ${inventory.runtimeEntries}`,
    `provider-state entries: ${inventory.providerStateEntries}`,
    `owned tmux panes: ${inventory.ownedTmuxPanes}`,
  ].join("\n");
}

export function resetConfirmation(repositoryRoot: string): string {
  return resolve(repositoryRoot);
}

export function resetLabel(repositoryRoot: string): string {
  return basename(resolve(repositoryRoot));
}
