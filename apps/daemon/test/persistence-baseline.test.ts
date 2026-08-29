import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NanasaConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_SCHEMA_VERSION, openNanasaDatabase } from "../src/persistence/database.js";
import { resetFromAlpha } from "../src/persistence/reset-service.js";
import { NanasaStore } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "nanasa-persistence-"));
  directories.push(path);
  return path;
}

function tableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("database baseline", () => {
  it("creates every final domain as strict tables and reopens idempotently", () => {
    const path = join(directory(), "nanasa.sqlite");
    openNanasaDatabase(path).close();
    openNanasaDatabase(path).close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(DATABASE_SCHEMA_VERSION);
    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        "daemon_epochs",
        "groups",
        "topology_order_state",
        "roles",
        "memberships",
        "runs",
        "runtime_observations",
        "reporter_sessions",
        "status_revisions",
        "messages",
        "deliveries",
        "actions",
        "action_attempts",
        "action_acknowledgements",
        "open_waits",
        "provider_state",
        "overlays",
        "native_sessions",
        "models",
        "trust",
        "repositories",
        "checkouts",
        "worktrees",
        "git_operations",
        "terminal_checkpoints",
        "extensions",
        "domain_events",
        "idempotency_keys",
        "audits",
        "retention_metadata",
      ]),
    );
    const nonStrict = database
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND strict = 0",
      )
      .all();
    expect(nonStrict).toEqual([]);
    database.close();
  });

  it("keeps checkpoints default-off, owner-only, and metadata-only", () => {
    const disabled = new NanasaStore(":memory:", {
      config: NanasaConfigSchema.parse({ version: 2, integrations: {} }),
    });
    expect(() =>
      disabled.saveTerminalCheckpoint("owner", {
        runId: "missing",
        generation: 1,
        terminalBinding: {
          serverName: "nanasa",
          sessionId: "session",
          windowId: "@1",
          paneId: "%1",
        },
        capturedAt: "2026-08-29T12:00:00Z",
        lineCount: 1,
        byteCount: 1,
        truncated: false,
        sensitivity: "repository-private",
        storageReference: ".nanasa/state/checkpoints/one",
        expiresAt: "2026-08-30T12:00:00Z",
      }),
    ).toThrowError(/disabled/);
    disabled.close();
  });

  it("creates a verified backup before an explicit alpha reset", async () => {
    const repository = directory();
    mkdirSync(join(repository, ".git"));
    mkdirSync(join(repository, ".nanasa", "state"), { recursive: true });
    const oldConfig = "integrations: {}\n";
    writeFileSync(join(repository, ".nanasa", "config.yaml"), oldConfig);
    const oldDatabase = new DatabaseSync(join(repository, ".nanasa", "state", "nanasa.sqlite"));
    oldDatabase.exec(
      "CREATE TABLE legacy (id TEXT PRIMARY KEY) STRICT; INSERT INTO legacy VALUES ('kept'); PRAGMA user_version = 4",
    );
    oldDatabase.close();
    const configTemplate = "version: 2\nintegrations: {}\n";
    const result = await resetFromAlpha({
      repositoryRoot: repository,
      confirmation: repository,
      configTemplate,
      tmuxServerName: `nanasa-reset-${process.pid}`,
    });
    expect(result.databaseBackup).toBeDefined();
    const backup = new DatabaseSync(result.databaseBackup as string, { readOnly: true });
    expect(backup.prepare("SELECT id FROM legacy").get()).toEqual({ id: "kept" });
    backup.close();
    openNanasaDatabase(join(repository, ".nanasa", "state", "nanasa.sqlite")).close();
  });

  it("removes only exactly tagged Nanasa tmux panes", async () => {
    const repository = directory();
    mkdirSync(join(repository, ".git"));
    mkdirSync(join(repository, ".nanasa"));
    writeFileSync(join(repository, ".nanasa", "config.yaml"), "version: 2\nintegrations: {}\n");
    const logPath = join(repository, "tmux.log");
    const tmuxPath = join(repository, "tmux-fixture.mjs");
    writeFileSync(
      tmuxPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("list-panes")) {
  process.stdout.write("%1\\trun_owned-1\\t1\\n%2\\t\\t\\n%3\\tunrelated\\t1\\n");
} else if (args.includes("kill-pane")) {
  appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
}
`,
    );
    chmodSync(tmuxPath, 0o755);
    const result = await resetFromAlpha({
      repositoryRoot: repository,
      confirmation: repository,
      configTemplate: "version: 2\nintegrations: {}\n",
      tmuxPath,
    });
    expect(result.removedOwnedTmuxPanes).toBe(1);
    expect(readFileSync(logPath, "utf8")).toMatch(/kill-pane -t %1/);
    expect(readFileSync(logPath, "utf8")).not.toMatch(/%2|%3/);
  });
});
