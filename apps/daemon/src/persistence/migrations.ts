import type { DatabaseSync } from "node:sqlite";
import type { MigrationStep } from "../release/migration-runner.js";
import {
  PROVIDER_PLATFORM_SCHEMA_SQL,
  PROVIDER_PLATFORM_SCHEMA_V9_SQL,
} from "./provider-platform-schema.js";

export const PROVIDER_PLATFORM_MIGRATION: MigrationStep = Object.freeze({
  from: 8,
  to: 9,
  name: "inert-provider-platform-target-state",
  apply(database: DatabaseSync) {
    database.exec(PROVIDER_PLATFORM_SCHEMA_V9_SQL);
  },
});

export const PROVIDER_PLATFORM_SCHEMA_10_MIGRATION: MigrationStep = Object.freeze({
  from: 9,
  to: 10,
  name: "complete-provider-platform-target-state",
  apply(database: DatabaseSync) {
    const tables = [
      "provider_packages",
      "provider_snapshots",
      "provider_activations",
      "run_provider_bindings",
      "provider_process_incarnations",
      "provider_authority_fences",
      "provider_operation_audits",
      "status_source_claims",
      "reporter_turn_cycles",
    ];
    for (const table of tables) {
      const count = (
        database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
      if (count !== 0) {
        throw new Error(`Schema 9 target table must be empty before forward rewrite: ${table}`);
      }
    }
    database.exec(`
      DROP TABLE reporter_turn_cycles;
      DROP TABLE status_source_claims;
      DROP TABLE provider_operation_audits;
      DROP TABLE provider_authority_fences;
      DROP TABLE provider_process_incarnations;
      DROP TABLE run_provider_bindings;
      DROP TABLE provider_activations;
      DROP TABLE provider_snapshots;
      DROP TABLE provider_packages;
      DROP INDEX runs_target_identity;
    `);
    database.exec(PROVIDER_PLATFORM_SCHEMA_SQL);
  },
});
