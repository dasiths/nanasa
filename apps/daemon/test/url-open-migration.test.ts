import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import {
  DATABASE_MIGRATION_13_TO_14_SQL,
  DATABASE_SCHEMA_VERSION,
} from "../src/persistence/schema.js";

it("migrates schema 15 while preserving attention overrides and enabling URL subscriptions", () => {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-url-migration-"));
  const path = join(directory, "state.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE schema_metadata (singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, initialized_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_metadata VALUES (1, 15, '2026-09-06T00:00:00.000Z');
      ${DATABASE_MIGRATION_13_TO_14_SQL}
      INSERT INTO attention_subscription_overrides VALUES ('operator', 'group', 'member', 'completion', 0, '2026-09-06T00:00:00.000Z');
      PRAGMA user_version = 15;
    `);
    old.close();
    const migrated = openNanasaDatabase(path);
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
      user_version: DATABASE_SCHEMA_VERSION,
    });
    expect(
      migrated.prepare("SELECT event_type, enabled FROM attention_subscription_overrides").get(),
    ).toEqual({ event_type: "completion", enabled: 0 });
    migrated
      .prepare("INSERT INTO attention_subscription_overrides VALUES (?, ?, ?, ?, ?, ?)")
      .run("operator", "group", "member", "url-open-request", 0, "2026-09-06T00:00:00.000Z");
    expect(migrated.prepare("SELECT * FROM url_open_requests").all()).toEqual([]);
    migrated.close();
    openNanasaDatabase(path).close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
