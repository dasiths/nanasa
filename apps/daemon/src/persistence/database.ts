import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_BASELINE_SQL,
  DATABASE_MIGRATION_10_TO_11_SQL,
  DATABASE_MIGRATION_11_TO_12_SQL,
  DATABASE_MIGRATION_12_TO_13_SQL,
  DATABASE_MIGRATION_13_TO_14_SQL,
  DATABASE_SCHEMA_VERSION,
} from "./schema.js";

export class DatabaseSchemaError extends Error {
  public constructor(
    public readonly foundVersion: number,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseSchemaError";
  }
}

function userTableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function schemaVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function initializeFreshDatabase(database: DatabaseSync): void {
  const initializedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(DATABASE_BASELINE_SQL);
    database
      .prepare(
        "INSERT INTO schema_metadata (singleton, schema_version, initialized_at) VALUES (1, ?, ?)",
      )
      .run(DATABASE_SCHEMA_VERSION, initializedAt);
    database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function applyMigration(database: DatabaseSync, fromVersion: number, sql: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database
      .prepare("UPDATE schema_metadata SET schema_version = ? WHERE singleton = 1")
      .run(fromVersion + 1);
    database.exec(`PRAGMA user_version = ${fromVersion + 1}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateDatabase(database: DatabaseSync, version: number): void {
  let currentVersion = version;
  if (currentVersion === 10) {
    applyMigration(database, currentVersion, DATABASE_MIGRATION_10_TO_11_SQL);
    currentVersion = 11;
  }
  if (currentVersion === 11) {
    applyMigration(database, currentVersion, DATABASE_MIGRATION_11_TO_12_SQL);
    currentVersion = 12;
  }
  if (currentVersion === 12) {
    applyMigration(database, currentVersion, DATABASE_MIGRATION_12_TO_13_SQL);
    currentVersion = 13;
  }
  if (currentVersion === 13) {
    applyMigration(database, currentVersion, DATABASE_MIGRATION_13_TO_14_SQL);
  }
}

function assertCurrentSchema(database: DatabaseSync): void {
  const version = schemaVersion(database);
  if (version !== DATABASE_SCHEMA_VERSION) {
    const direction = version < DATABASE_SCHEMA_VERSION ? "old" : "future";
    throw new DatabaseSchemaError(
      version,
      `Refusing to mutate ${direction} database schema ${version}; expected ${DATABASE_SCHEMA_VERSION}. Run nanasa reset --from-alpha after creating a verified backup.`,
    );
  }
  const metadata = database
    .prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
    .get() as { schema_version: number } | undefined;
  if (metadata?.schema_version !== DATABASE_SCHEMA_VERSION) {
    throw new DatabaseSchemaError(version, "Database schema metadata does not match user_version");
  }
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) {
    throw new DatabaseSchemaError(version, "Database foreign-key verification failed");
  }
}

export function openNanasaDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
    const version = schemaVersion(database);
    const tables = userTableNames(database);
    if (version === 0 && tables.length === 0) initializeFreshDatabase(database);
    else migrateDatabase(database, version);
    assertCurrentSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function verifyDatabaseIntegrity(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") {
      throw new Error(`Database integrity check failed: ${result.integrity_check}`);
    }
  } finally {
    database.close();
  }
}

export { DATABASE_SCHEMA_VERSION } from "./schema.js";
