import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type MigrationProbe, MigrationProbeSchema } from "@nanasa/contracts";

export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  apply(database: DatabaseSync, context: { databasePath: string }): void;
}

export interface MigrationHooks {
  beforeStep?(step: MigrationStep): void;
  afterStep?(step: MigrationStep): void;
}

function schemaVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function verify(database: DatabaseSync): {
  integrity: "ok" | "failed";
  foreignKeys: "ok" | "failed";
} {
  const integrity = (
    database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check;
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  return {
    integrity: integrity === "ok" ? "ok" : "failed",
    foreignKeys: foreignKeys.length === 0 ? "ok" : "failed",
  };
}

export class MigrationCompatibilityError extends Error {
  public constructor(
    public readonly code:
      | "migration_database_missing"
      | "migration_future_schema"
      | "migration_downgrade_refused"
      | "migration_path_missing"
      | "migration_integrity_failed",
    message: string,
  ) {
    super(message);
    this.name = "MigrationCompatibilityError";
  }
}

export class MigrationRunner {
  readonly #path: string;
  readonly #targetSchema: number;
  readonly #steps: ReadonlyMap<number, MigrationStep>;

  public constructor(path: string, targetSchema: number, steps: readonly MigrationStep[] = []) {
    this.#path = resolve(path);
    this.#targetSchema = targetSchema;
    this.#steps = new Map(steps.map((step) => [step.from, step]));
    if (!Number.isInteger(targetSchema) || targetSchema < 1)
      throw new Error("Target schema must be positive");
    for (const step of steps) {
      if (step.to !== step.from + 1)
        throw new Error(`Migration ${step.name} must advance exactly one schema`);
    }
  }

  public probe(): MigrationProbe {
    if (!existsSync(this.#path)) {
      throw new MigrationCompatibilityError(
        "migration_database_missing",
        `Database does not exist: ${this.#path}`,
      );
    }
    const database = new DatabaseSync(this.#path, { readOnly: true });
    try {
      const foundSchema = schemaVersion(database);
      const checks = verify(database);
      return MigrationProbeSchema.parse({
        path: this.#path,
        foundSchema,
        targetSchema: this.#targetSchema,
        compatibility:
          foundSchema === this.#targetSchema
            ? "current"
            : foundSchema > this.#targetSchema
              ? "future-schema"
              : this.#hasCompletePath(foundSchema)
                ? "upgrade-available"
                : "unsupported-old",
        ...checks,
      });
    } finally {
      database.close();
    }
  }

  public preflight(): MigrationProbe {
    const probe = this.probe();
    if (probe.integrity !== "ok" || probe.foreignKeys !== "ok") {
      throw new MigrationCompatibilityError(
        "migration_integrity_failed",
        "Database integrity or foreign-key verification failed",
      );
    }
    if (probe.foundSchema > probe.targetSchema) {
      throw new MigrationCompatibilityError(
        "migration_future_schema",
        `Database schema ${probe.foundSchema} is newer than supported schema ${probe.targetSchema}; downgrade is refused`,
      );
    }
    if (probe.compatibility === "unsupported-old") {
      throw new MigrationCompatibilityError(
        "migration_path_missing",
        `No complete migration path exists from schema ${probe.foundSchema} to ${probe.targetSchema}`,
      );
    }
    return probe;
  }

  public apply(hooks: MigrationHooks = {}): MigrationProbe {
    const preflight = this.preflight();
    if (preflight.compatibility === "current") return preflight;
    const database = new DatabaseSync(this.#path);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      let current = schemaVersion(database);
      while (current < this.#targetSchema) {
        const step = this.#steps.get(current);
        if (step === undefined) {
          throw new MigrationCompatibilityError(
            "migration_path_missing",
            `Missing migration from schema ${current}`,
          );
        }
        hooks.beforeStep?.(step);
        database.exec("BEGIN IMMEDIATE");
        try {
          step.apply(database, { databasePath: this.#path });
          database.exec(`PRAGMA user_version = ${step.to}`);
          const metadata = database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'schema_metadata'",
            )
            .get();
          if (metadata !== undefined) {
            database
              .prepare("UPDATE schema_metadata SET schema_version = ? WHERE singleton = 1")
              .run(step.to);
          }
          const checks = verify(database);
          if (checks.integrity !== "ok" || checks.foreignKeys !== "ok") {
            throw new MigrationCompatibilityError(
              "migration_integrity_failed",
              `Migration ${step.name} failed verification`,
            );
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        hooks.afterStep?.(step);
        current = step.to;
      }
    } finally {
      database.close();
    }
    return this.preflight();
  }

  public assertRollbackCompatible(candidateSchema: number): void {
    const current = this.probe().foundSchema;
    if (candidateSchema < current) {
      throw new MigrationCompatibilityError(
        "migration_downgrade_refused",
        `Candidate schema ${candidateSchema} cannot read active schema ${current}; restore a verified backup before rollback`,
      );
    }
  }

  #hasCompletePath(found: number): boolean {
    let current = found;
    while (current < this.#targetSchema) {
      const step = this.#steps.get(current);
      if (step === undefined || step.to !== current + 1) return false;
      current = step.to;
    }
    return current === this.#targetSchema;
  }
}
