import { type AgentStatusEventInput, ForemanConfigSchema } from "@nanasa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForemanInboxScheduler } from "../src/foreman-inbox-scheduler.js";
import { NanasaStore } from "../src/store.js";

const stores: NanasaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new NanasaStore(":memory:");
  stores.push(store);
  const profile = store.createInternalAgentProfile({
    name: "Foreman",
    agentType: "copilot",
    kind: "copilot",
    command: "copilot",
    args: [],
    environment: {},
  });
  const actor = store.upsertForeman({
    id: "repository-foreman",
    agentProfileId: profile.id,
    enabled: true,
  });
  const created = store.createRunForForeman(actor.id).run;
  store.updateRuntimeRunStatus(created.id, "running");
  const run = store.getActiveForemanRun(actor.id)!;
  const now = new Date().toISOString();
  store.registerReporterSession({
    id: "reporter",
    runId: run.id,
    generation: 1,
    providerId: "copilot",
    adapterId: "copilot",
    reporterId: "copilot-hooks",
    source: "copilot",
    protocolVersion: 2,
    reporterVersion: "2",
    reporterEpoch: "epoch",
    readinessCoverage: "full",
    sourceSequence: 0,
    openedAt: now,
    leaseExpiresAt: "2099-01-01T00:00:00Z",
  });
  store.bindReporterProcess(run.id, 1, "a".repeat(64));
  const identity = {
    kind: "foreman" as const,
    foremanId: actor.id,
    runId: run.id,
    generation: 1,
    authorityRevision: 0,
  };
  const event: AgentStatusEventInput = {
    version: 2,
    eventId: "ready",
    providerId: "copilot",
    adapterId: "copilot",
    reporterId: "copilot-hooks",
    source: "copilot",
    protocolVersion: 2,
    reporterVersion: "2",
    runId: run.id,
    generation: 1,
    reporterEpoch: "epoch",
    sourceSequence: 1,
    event: "session.ready",
    data: {},
  };
  const ready = () => {
    store.recordRuntimeProcessStatus(run.id, {
      event: "process.alive",
      eventId: "alive",
      observedAt: now,
      process: {
        foregroundPgid: 1,
        leaderPid: 1,
        pidStartIdentity: "1:1",
        executableFingerprint: "b".repeat(64),
        argvFingerprint: "c".repeat(64),
        processFingerprint: "a".repeat(64),
        expectedProviderMatch: "match",
        wrapperChain: ["copilot"],
      },
    });
    store.ingestForemanStatusEvent(identity, event);
  };
  const message = store.sendForemanMessage(
    { kind: "operator", operatorId: "human" },
    { requestId: "message", text: "Review the repository" },
  );
  let controlled = false;
  const runtime = {
    pasteToRun: vi.fn(async (_run, _text, assertCurrent) => {
      assertCurrent?.();
    }),
  } as unknown as ConstructorParameters<typeof ForemanInboxScheduler>[2];
  const service = {
    status: () => ({
      actor: store.getForeman(actor.id),
      run: store.getActiveForemanRun(actor.id),
      configuration: ForemanConfigSchema.parse({ integrationId: "copilot", enabled: true }),
      inbox: store.listForemanInbox(),
    }),
    observeReporterProcess: vi.fn(async () => undefined),
  };
  const scheduler = new ForemanInboxScheduler(
    store,
    service,
    runtime,
    { dispatchAutomated: async (_id, operation) => operation() },
    () => controlled,
  );
  return {
    store,
    run,
    event,
    identity,
    ready,
    scheduler,
    runtime,
    message,
    control: (value: boolean) => {
      controlled = value;
    },
    state: () =>
      store.database.prepare("SELECT state FROM foreman_inbox WHERE message_id = ?").get(message.id)
        ?.state,
  };
}

describe("Foreman durable input dispatch", () => {
  it("uses verified reporter readiness and human control, then submits exactly once", async () => {
    const context = fixture();
    expect(() => context.store.ingestForemanStatusEvent(context.identity, context.event)).toThrow(
      "currently verified",
    );
    await context.scheduler.tick();
    expect(context.runtime.pasteToRun).not.toHaveBeenCalled();
    context.ready();
    expect(() => context.store.ingestForemanStatusEvent(context.identity, context.event)).toThrow(
      "reordered",
    );
    context.control(true);
    await context.scheduler.tick();
    expect(context.state()).toBe("queued");
    context.control(false);
    await context.scheduler.tick();
    await context.scheduler.tick();
    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
    expect(context.state()).toBe("submitted");
    context.store.sendForemanMessage(
      { kind: "operator", operatorId: "human" },
      { requestId: "second", text: "Second instruction" },
    );
    await context.scheduler.tick();
    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
    context.store.sendForemanMessage(context.identity, {
      requestId: "reply",
      text: "Reviewed",
      replyTo: context.message.id,
    });
    expect(context.state()).toBe("answered");
    await context.scheduler.tick();
    expect(context.runtime.pasteToRun).toHaveBeenCalledTimes(2);
    await context.scheduler.close();
  });

  it("never replays an uncertain write and recovers abandoned write intents as ambiguous", async () => {
    const context = fixture();
    context.ready();
    vi.mocked(context.runtime.pasteToRun).mockRejectedValue(new Error("connection lost"));
    await context.scheduler.tick();
    await context.scheduler.tick();
    expect(context.state()).toBe("ambiguous");
    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
    context.store.database.prepare("UPDATE foreman_inbox SET state = 'writing'").run();
    context.scheduler.start();
    expect(context.state()).toBe("ambiguous");
    const inbox = context.store.listForemanInbox()[0]!;
    expect(() =>
      context.store.resolveForemanInput("human", {
        inboxId: inbox.id,
        expectedState: "submitted",
        resolution: "handled",
      }),
    ).toThrow("state changed");
    context.store.resolveForemanInput("human", {
      inboxId: inbox.id,
      expectedState: "ambiguous",
      resolution: "cancel",
    });
    expect(context.state()).toBe("cancelled");
    await context.scheduler.tick();
    expect(context.runtime.pasteToRun).toHaveBeenCalledOnce();
    await context.scheduler.close();
  });

  it("fences revocation between readiness and the native write", async () => {
    const context = fixture();
    context.ready();
    vi.mocked(context.runtime.pasteToRun).mockImplementation(async (_run, _text, assertCurrent) => {
      const actor = context.store.getForeman(context.run.foremanId);
      context.store.upsertForeman({ ...actor, enabled: false });
      assertCurrent?.();
    });
    await context.scheduler.tick();
    expect(context.state()).toBe("ambiguous");
    await context.scheduler.close();
  });
});
