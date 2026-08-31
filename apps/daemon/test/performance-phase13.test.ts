import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { AgentRun, AgentStatusEventInput } from "@nanasa/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { AgentActionScheduler } from "../src/actions/agent-action-scheduler.js";
import { AgentActionService } from "../src/actions/agent-action-service.js";
import { DeliveryDispatcher } from "../src/delivery-dispatcher.js";
import { DeliveryRepository } from "../src/delivery-repository.js";
import { EventLog } from "../src/event-log.js";
import { EventStreamSession, type EventStreamSocket } from "../src/event-stream-session.js";
import { NanasaStore } from "../src/store.js";
import { AttachmentPty } from "../src/terminal/attachment-pty.js";
import { TerminalControlService } from "../src/terminal/terminal-control-service.js";
import { TerminalGateway } from "../src/terminal/terminal-gateway.js";
import { TerminalInputArbiter } from "../src/terminal/terminal-input-arbiter.js";
import { TerminalReadService } from "../src/terminal/terminal-read-service.js";
import { TmuxTerminalDelivery } from "../src/terminal-delivery.js";
import { TmuxRuntime } from "../src/tmux-runtime.js";

const root = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const metrics: BenchmarkMetric[] = [];
const seed = 0x13a5a5;

interface BenchmarkThresholds {
  maxElapsedP95Ms: number;
  minThroughputPerSecond: number;
  maxEventLoopDelayP99Ms: number;
  maxHeapDeltaBytes: number;
  maxRssDeltaBytes: number;
}

interface BenchmarkMetric {
  name: string;
  seed: number;
  operations: number;
  samples: number;
  elapsedMedianMs: number;
  elapsedP95Ms: number;
  throughputMedianPerSecond: number;
  eventLoopDelayP99Ms: number;
  peakHeapDeltaBytes: number;
  peakRssDeltaBytes: number;
  thresholds: BenchmarkThresholds;
}

// Calibrated on the Phase 13 Linux x64 baseline with 35-70% CI variance headroom.
const thresholdByBenchmark: Record<string, BenchmarkThresholds> = {
  "terminal-fleet": {
    maxElapsedP95Ms: 5_000,
    minThroughputPerSecond: 70,
    maxEventLoopDelayP99Ms: 400,
    maxHeapDeltaBytes: 32 * 1024 * 1024,
    maxRssDeltaBytes: 64 * 1024 * 1024,
  },
  "event-storm": {
    maxElapsedP95Ms: 10_000,
    minThroughputPerSecond: 100,
    maxEventLoopDelayP99Ms: 500,
    maxHeapDeltaBytes: 32 * 1024 * 1024,
    maxRssDeltaBytes: 64 * 1024 * 1024,
  },
  "slow-consumer-backpressure": {
    maxElapsedP95Ms: 300,
    minThroughputPerSecond: 1_800,
    maxEventLoopDelayP99Ms: 50,
    maxHeapDeltaBytes: 16 * 1024 * 1024,
    maxRssDeltaBytes: 32 * 1024 * 1024,
  },
  "delivery-pressure": {
    maxElapsedP95Ms: 14_000,
    minThroughputPerSecond: 1,
    maxEventLoopDelayP99Ms: 200,
    maxHeapDeltaBytes: 16 * 1024 * 1024,
    maxRssDeltaBytes: 64 * 1024 * 1024,
  },
  "action-scheduling-pressure": {
    maxElapsedP95Ms: 4_500,
    minThroughputPerSecond: 1.1,
    maxEventLoopDelayP99Ms: 150,
    maxHeapDeltaBytes: 24 * 1024 * 1024,
    maxRssDeltaBytes: 64 * 1024 * 1024,
  },
};

function fixtureStore(name: string): NanasaStore {
  const directory = mkdtempSync(join(tmpdir(), `nanasa-performance-${name}-`));
  directories.push(directory);
  return new NanasaStore(join(directory, "state.sqlite"));
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function measure(
  name: string,
  operations: number,
  operation: (sample: number) => Promise<void> | void,
) {
  const thresholds = thresholdByBenchmark[name]!;
  await operation(-2);
  await operation(-1);
  const samples: Array<{
    elapsedMs: number;
    throughput: number;
    delayMs: number;
    heap: number;
    rss: number;
  }> = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    const before = process.memoryUsage();
    let peakHeap = before.heapUsed;
    let peakRss = before.rss;
    const memorySampler = setInterval(() => {
      const current = process.memoryUsage();
      peakHeap = Math.max(peakHeap, current.heapUsed);
      peakRss = Math.max(peakRss, current.rss);
    }, 5);
    delay.enable();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const started = performance.now();
    await operation(sample);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const elapsedMs = performance.now() - started;
    clearInterval(memorySampler);
    delay.disable();
    samples.push({
      elapsedMs,
      throughput: operations / Math.max(elapsedMs / 1_000, 0.001),
      delayMs: Number.isFinite(delay.percentile(99)) ? delay.percentile(99) / 1_000_000 : 0,
      heap: Math.max(
        0,
        peakHeap - before.heapUsed,
        process.memoryUsage().heapUsed - before.heapUsed,
      ),
      rss: Math.max(0, peakRss - before.rss, process.memoryUsage().rss - before.rss),
    });
  }
  const metric: BenchmarkMetric = {
    name,
    seed,
    operations,
    samples: samples.length,
    elapsedMedianMs: percentile(
      samples.map((item) => item.elapsedMs),
      0.5,
    ),
    elapsedP95Ms: percentile(
      samples.map((item) => item.elapsedMs),
      0.95,
    ),
    throughputMedianPerSecond: percentile(
      samples.map((item) => item.throughput),
      0.5,
    ),
    eventLoopDelayP99Ms: percentile(
      samples.map((item) => item.delayMs),
      0.95,
    ),
    peakHeapDeltaBytes: Math.max(...samples.map((item) => item.heap)),
    peakRssDeltaBytes: Math.max(...samples.map((item) => item.rss)),
    thresholds,
  };
  metrics.push(metric);
  expect(metric.elapsedP95Ms, `${name} p95 elapsed time`).toBeLessThan(thresholds.maxElapsedP95Ms);
  expect(metric.throughputMedianPerSecond, `${name} median throughput`).toBeGreaterThan(
    thresholds.minThroughputPerSecond,
  );
  expect(metric.eventLoopDelayP99Ms, `${name} p99 event-loop delay`).toBeLessThan(
    thresholds.maxEventLoopDelayP99Ms,
  );
  expect(metric.peakHeapDeltaBytes, `${name} peak heap growth`).toBeLessThan(
    thresholds.maxHeapDeltaBytes,
  );
  expect(metric.peakRssDeltaBytes, `${name} peak RSS growth`).toBeLessThan(
    thresholds.maxRssDeltaBytes,
  );
}

function statusEvent(run: AgentRun, sourceSequence: number): AgentStatusEventInput {
  return {
    version: 2,
    eventId: `performance-status-${sourceSequence}`,
    providerId: "claude-code",
    adapterId: "claude-code",
    reporterId: "claude-hooks",
    source: "claude-code",
    protocolVersion: 2,
    reporterVersion: "2",
    runId: run.id,
    generation: run.generation,
    reporterEpoch: "performance-reporter-epoch",
    sourceSequence,
    event: "session.ready",
    data: {},
  };
}

afterAll(() => {
  const directory = join(root, "test-results", "performance");
  mkdirSync(directory, { recursive: true });
  const result = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    machine: {
      platform: platform(),
      architecture: process.arch,
      kernel: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      node: process.version,
      v8: process.versions.v8,
    },
    metrics,
  };
  writeFileSync(join(directory, "phase13-measured.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`NANASA_PERFORMANCE_RESULT=${JSON.stringify(result)}`);
  for (const directoryPath of directories.splice(0)) {
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

describe("Phase 13 measured performance and backpressure", () => {
  it("measures a real 100-terminal tmux fleet with controller and observer pressure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-performance-terminal-fleet-"));
    directories.push(directory);
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const providerPath = join(directory, "pi");
    writeFileSync(
      providerPath,
      "#!/bin/sh\nprintf 'nanasa-terminal-ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
      { mode: 0o700 },
    );
    chmodSync(providerPath, 0o700);
    const group = store.createGroup({ name: "Terminal fleet" });
    const profile = store.createInternalAgentProfile({
      name: "Fleet",
      agentType: "pi",
      kind: "pi",
      command: providerPath,
      args: [],
      environment: {},
    });
    const runs: AgentRun[] = [];
    const serverName = `nanasa-performance-${crypto.randomUUID()}`;
    const runtime = new TmuxRuntime(store, { serverName });
    for (let index = 0; index < 100; index += 1) {
      const memberId = `worker-${index}`;
      store.addMembership(group.id, { memberId, agentProfileId: profile.id, alias: memberId });
      runs.push(await runtime.startRun(group.id, memberId, { cols: 80, rows: 24 }));
    }
    const control = new TerminalControlService(store);
    const arbiter = new TerminalInputArbiter(control);
    const reads = new TerminalReadService(store, runtime, join(directory, "checkpoints"), {
      enabled: false,
      maxLines: 500,
      maxBytes: 65_536,
      retentionSeconds: 300,
      sensitivity: "repository-private",
    });
    const gateway = new TerminalGateway(control, reads, 1, "tmux", arbiter);
    await measure("terminal-fleet", runs.length * 3 + 20, async (sample) => {
      for (const [index, run] of runs.entries()) {
        gateway.start(run);
        const { viewer: controller } = control.connect({
          runId: run.id,
          runGeneration: run.generation,
          viewerId: `controller-${sample}-${run.id}`,
          requestedRole: "controller",
          takeover: false,
          close: () => undefined,
        });
        gateway.status(run.id);
        if (index < 10) {
          await runtime.ensureViewSession(run);
          const { viewer: observer } = control.connect({
            runId: run.id,
            runGeneration: run.generation,
            viewerId: `observer-${sample}-${run.id}`,
            requestedRole: "observer",
            takeover: false,
            close: () => undefined,
          });
          const controllerPty = new AttachmentPty(run, "controller", { cols: 80, rows: 24 });
          const observerPty = new AttachmentPty(run, "observer", { cols: 80, rows: 24 });
          let observedBytes = 0;
          let observe!: () => void;
          const observed = new Promise<void>((resolveObserved) => (observe = resolveObserved));
          const subscription = observerPty.onData((data) => {
            observedBytes += Buffer.byteLength(data);
            observe();
          });
          arbiter.dispatch(run.id, controller.streamId, controllerPty, {
            type: "input",
            leaseId: controller.lease!.id,
            data: `sample-${sample}-${index}\r`,
          });
          let observerTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              observed,
              new Promise<never>((_, reject) => {
                observerTimer = setTimeout(
                  () => reject(new Error("observer received no terminal bytes")),
                  1_000,
                );
              }),
            ]);
          } finally {
            if (observerTimer !== undefined) clearTimeout(observerTimer);
          }
          expect(observedBytes).toBeGreaterThan(0);
          subscription.dispose();
          controllerPty.close();
          observerPty.close();
          control.disconnect(run.id, observer.streamId);
        }
        control.disconnect(run.id, controller.streamId);
        if (index % 10 === 9) {
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      }
    });
    await gateway.close();
    await runtime.close();
    execFileSync("tmux", ["-L", serverName, "kill-server"]);
    store.close();
  }, 120_000);

  it("measures a fixed event storm and fail-closed slow consumers", async () => {
    const store = fixtureStore("event-storm");
    const eventLog = new EventLog(store);
    const frames: string[] = [];
    const socket: EventStreamSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (data) => frames.push(data),
      close: () => undefined,
      once: () => undefined,
    };
    const session = new EventStreamSession(socket, eventLog, {
      afterSequence: 0,
      instanceId: "performance-instance",
      daemonEpoch: 1,
      heartbeatMs: 60_000,
    });
    session.start();
    await measure("event-storm", 1_000, async () => {
      for (let index = 0; index < 1_000; index += 1) {
        store.recordRuntimeEvent("performance.event", "benchmark", String(index), {
          seed,
          index,
        });
        if (index % 25 === 24) {
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      }
    });
    expect(frames.filter((frame) => frame.includes('"type":"domain.event"'))).toHaveLength(7_000);
    session.close();

    let closed = 0;
    await measure("slow-consumer-backpressure", 500, () => {
      for (let index = 0; index < 500; index += 1) {
        const slowSocket: EventStreamSocket = {
          readyState: 1,
          bufferedAmount: 2 * 1024 * 1024,
          send: () => undefined,
          close: (code) => {
            if (code === 1013) closed += 1;
          },
          once: () => undefined,
        };
        new EventStreamSession(slowSocket, eventLog, {
          afterSequence: 0,
          instanceId: `slow-${index}`,
          daemonEpoch: 1,
          pendingByteLimit: 1024 * 1024,
          heartbeatMs: 60_000,
        }).start();
      }
    });
    expect(closed).toBe(3_500);
    store.close();
  }, 120_000);

  it("measures durable delivery and exact-action scheduling pressure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-performance-work-pressure-"));
    directories.push(directory);
    const store = new NanasaStore(join(directory, "state.sqlite"));
    const daemonEpoch = store.beginDaemonEpoch({
      instanceId: "performance-instance",
      processId: process.pid,
      processStartedAt: "2026-08-30T00:00:00.000Z",
    });
    const group = store.createGroup({ name: "Work pressure" });
    const providerPath = join(directory, "claude");
    writeFileSync(
      providerPath,
      "#!/bin/sh\nprintf 'nanasa-action-ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
      { mode: 0o700 },
    );
    chmodSync(providerPath, 0o700);
    const profile = store.createInternalAgentProfile({
      name: "Claude",
      agentType: "claude-code",
      kind: "claude-code",
      command: providerPath,
      args: [],
      environment: {},
    });
    store.addMembership(group.id, {
      memberId: "worker",
      agentProfileId: profile.id,
      alias: "Worker",
    });
    const serverName = `nanasa-performance-actions-${crypto.randomUUID()}`;
    const runtime = new TmuxRuntime(store, { serverName });
    const run = await runtime.startRun(group.id, "worker", { cols: 100, rows: 30 });
    store.registerReporterSession({
      id: "performance-reporter-session",
      providerId: "claude-code",
      adapterId: "claude-code",
      reporterId: "claude-hooks",
      source: "claude-code",
      protocolVersion: 2,
      reporterVersion: "2",
      runId: run.id,
      generation: run.generation,
      reporterEpoch: "performance-reporter-epoch",
      readinessCoverage: "full",
      sourceSequence: 0,
      openedAt: "2026-08-30T00:00:00.000Z",
      leaseExpiresAt: "2099-08-30T00:00:00.000Z",
    });
    const processObservation = await runtime.observeRun(run);
    if (processObservation.process === undefined)
      throw new Error("Real process identity unavailable");
    store.bindReporterProcess(
      run.id,
      run.generation,
      processObservation.process.processFingerprint,
    );
    store.recordProcessStatus(run.id, {
      event: "process.alive",
      eventId: "performance-process",
      observedAt: new Date().toISOString(),
      process: processObservation.process,
    });
    store.ingestAgentStatusEvent(
      { groupId: group.id, memberId: "worker", runId: run.id, generation: 1 },
      statusEvent(run, 1),
    );

    const deliveryControl = new TerminalControlService(store);
    const deliveryArbiter = new TerminalInputArbiter(deliveryControl);
    const dispatcher = new DeliveryDispatcher(
      store,
      new DeliveryRepository(store),
      new TmuxTerminalDelivery(runtime, deliveryArbiter),
    );
    await measure("delivery-pressure", 16, async (sample) => {
      for (let index = 0; index < 16; index += 1) {
        store.submitMessage(group.id, {
          intent: "request",
          sender: { kind: "operator", operatorId: "performance" },
          audience: { kind: "dm", memberId: "worker" },
          body: {
            contentType: "text/plain",
            text: `seed-${seed}-sample-${sample}-message-${index}`,
          },
          delivery: {},
        });
        if (index % 8 === 7) {
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      }
      while (store.listDeliveries().some((item) => item.status === "queued")) {
        await dispatcher.tick();
      }
    });
    expect(
      store.listDeliveries().filter((item) => item.status === "terminal_injected"),
    ).toHaveLength(112);

    const control = new TerminalControlService(store);
    const scheduler = new AgentActionScheduler(
      store,
      runtime,
      new TerminalInputArbiter(control),
      () => new Date("2026-08-30T00:00:02.000Z"),
    );
    const actions = new AgentActionService(
      store,
      daemonEpoch,
      undefined,
      () => new Date("2026-08-30T00:00:01.000Z"),
    );
    await measure("action-scheduling-pressure", 5, async (sample) => {
      for (let index = 0; index < 5; index += 1) {
        actions.create(
          { kind: "operator", operatorId: "performance" },
          {
            kind: "prompt",
            groupId: group.id,
            memberId: "worker",
            prompt: `seed-${seed}-sample-${sample}-action-${index}`,
            allowWorking: false,
          },
          `performance-action-${sample}-${index}`,
        );
        if (index % 10 === 9) {
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      }
      await scheduler.tick();
    });
    expect(store.listAgentActions().filter((item) => item.state === "submitted")).toHaveLength(35);
    await dispatcher.close();
    deliveryControl.close();
    await scheduler.close();
    control.close();
    await runtime.close();
    execFileSync("tmux", ["-L", serverName, "kill-server"]);
    store.close();
  }, 180_000);
});
