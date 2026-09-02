import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { AgentStatusEventInput, ProcessIdentityObservation } from "@nanasa/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { NanasaStore } from "../src/store.js";

const root = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const scales = [1, 15, 100] as const;

interface FleetBaseline {
  scale: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  processObservationRows: number;
  statusRevisionRows: number;
  domainEventRows: number;
  sqliteBytes: number;
  statusLatencyP95Ms: number;
}

const baselines: FleetBaseline[] = [];

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function processIdentity(index: number): ProcessIdentityObservation {
  return {
    foregroundPgid: index + 1,
    leaderPid: index + 1,
    pidStartIdentity: `baseline-${index}`,
    executableFingerprint: fingerprint("claude"),
    argvFingerprint: fingerprint(`claude-${index}`),
    processFingerprint: fingerprint(`process-${index}`),
    expectedProviderMatch: "match",
    wrapperChain: [],
  };
}

function reporterEvent(runId: string, generation: number, index: number): AgentStatusEventInput {
  return {
    version: 2,
    eventId: `baseline-ready-${index}`,
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code",
    protocolVersion: 2,
    reporterVersion: "2",
    runId,
    generation,
    reporterEpoch: `baseline-epoch-${index}`,
    sourceSequence: 1,
    event: "session.ready",
    nativeSessionId: `baseline-session-${index}`,
    data: {},
  };
}

function scalar(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, number>;
  return Number(Object.values(row)[0] ?? 0);
}

afterAll(() => {
  const outputDirectory = join(root, "test-results", "performance");
  mkdirSync(outputDirectory, { recursive: true });
  const result = {
    formatVersion: 1,
    workload: "provider-platform-status-baseline",
    scales,
    generatedAt: new Date().toISOString(),
    machine: {
      platform: platform(),
      architecture: process.arch,
      kernel: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      node: process.version,
    },
    baselines,
  };
  writeFileSync(
    join(outputDirectory, "provider-platform-baseline.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(`NANASA_PROVIDER_PLATFORM_BASELINE=${JSON.stringify(result)}`);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("provider platform fleet regression baselines", () => {
  function recordFleetBaseline(scale: (typeof scales)[number]): void {
    const directory = mkdtempSync(join(tmpdir(), `nanasa-provider-baseline-${scale}-`));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    const store = new NanasaStore(databasePath);
    const group = store.createGroup({ name: `Provider baseline ${scale}` });
    const profile = store.createInternalAgentProfile({
      name: "Claude baseline",
      agentType: "claude-code",
      kind: "claude-code",
      command: "claude",
      args: [],
      environment: {},
    });
    const beforeMemory = process.memoryUsage();
    const beforeCpu = process.cpuUsage();
    const latencies: number[] = [];

    for (let index = 0; index < scale; index += 1) {
      const memberId = `baseline-worker-${index}`;
      store.addMembership(group.id, {
        memberId,
        agentProfileId: profile.id,
        alias: `Worker ${index}`,
      });
      const run = store.createRunForMembership(group.id, memberId).run;
      store.updateRunStatus(run.id, "running");
      const identity = processIdentity(index);
      store.registerReporterSession({
        id: `baseline-reporter-${index}`,
        providerId: "claude-code",
        adapterId: "claude-code",
        reporterId: "claude-hooks",
        source: "claude-code",
        protocolVersion: 2,
        reporterVersion: "2",
        runId: run.id,
        generation: run.generation,
        reporterEpoch: `baseline-epoch-${index}`,
        readinessCoverage: "full",
        sourceSequence: 0,
        openedAt: "2026-09-01T00:00:00.000Z",
        leaseExpiresAt: "2099-09-01T00:00:00.000Z",
      });
      store.bindReporterProcess(run.id, run.generation, identity.processFingerprint);
      const observedAt = new Date().toISOString();
      store.recordProcessStatus(run.id, {
        event: "process.alive",
        eventId: `baseline-process-${index}`,
        observedAt,
        process: identity,
      });
      const started = performance.now();
      store.ingestAgentStatusEvent(
        { groupId: group.id, memberId, runId: run.id, generation: run.generation },
        reporterEvent(run.id, run.generation, index),
      );
      store.getAgentStatus(group.id, memberId);
      latencies.push(performance.now() - started);
    }

    const cpu = process.cpuUsage(beforeCpu);
    const afterMemory = process.memoryUsage();
    store.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const sqliteBytes =
      scalar(database, "PRAGMA page_count") * scalar(database, "PRAGMA page_size");
    const baseline: FleetBaseline = {
      scale,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      heapDeltaBytes: Math.max(0, afterMemory.heapUsed - beforeMemory.heapUsed),
      rssDeltaBytes: Math.max(0, afterMemory.rss - beforeMemory.rss),
      processObservationRows: scalar(
        database,
        "SELECT count(*) AS total FROM runtime_observations WHERE source = 'process'",
      ),
      statusRevisionRows: scalar(database, "SELECT count(*) AS total FROM status_revisions"),
      domainEventRows: scalar(database, "SELECT count(*) AS total FROM domain_events"),
      sqliteBytes,
      statusLatencyP95Ms: percentile95(latencies),
    };
    database.close();
    baselines.push(baseline);

    expect(baseline.processObservationRows).toBe(scale * 2);
    expect(baseline.statusRevisionRows).toBeGreaterThanOrEqual(scale);
    expect(baseline.domainEventRows).toBeGreaterThanOrEqual(scale);
    expect(baseline.sqliteBytes).toBeGreaterThan(0);
    expect(baseline.statusLatencyP95Ms).toBeLessThan(2_000);
    expect(baseline.cpuUserMs + baseline.cpuSystemMs).toBeLessThan(10_000);
    expect(baseline.heapDeltaBytes).toBeLessThan(128 * 1024 * 1024);
    expect(baseline.rssDeltaBytes).toBeLessThan(256 * 1024 * 1024);
  }

  it.each(scales)(
    "records CPU, memory, process, SQLite, event, and latency at %i runs",
    recordFleetBaseline,
    30_000,
  );
});
