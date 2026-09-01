export const STATUS_REPORTER_VERSION = "2";

export const HOOK_STATUS_REPORTER_SOURCE = String.raw`import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const source = process.argv[2];
const configuredEvent = process.argv[3];
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1024 * 1024) process.exit(0);
  chunks.push(chunk);
}

function stableId(...parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

function nextSequence() {
  const path = process.env.NANASA_REPORTER_SEQUENCE_FILE;
  const epoch = process.env.NANASA_REPORTER_EPOCH;
  if (!path || !epoch) return undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + ".lock";
  let descriptor;
  try {
    descriptor = openSync(lock, "wx", 0o600);
    let sequence = 0;
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (current.epoch === epoch && Number.isSafeInteger(current.sequence)) sequence = current.sequence;
    } catch {}
    sequence += 1;
    const temporary = path + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify({ epoch, sequence }), { mode: 0o600 });
    renameSync(temporary, path);
    return sequence;
  } catch { return undefined; }
  finally { if (descriptor !== undefined) closeSync(descriptor); rmSync(lock, { force: true }); }
}

function base(input, event, fields = {}) {
  const sourceSequence = nextSequence();
  if (sourceSequence === undefined) return undefined;
  return {
    version: 2,
    eventId: randomUUID(),
    providerId: process.env.NANASA_REPORTER_PROVIDER_ID,
    adapterId: process.env.NANASA_REPORTER_ADAPTER_ID,
    reporterId: process.env.NANASA_REPORTER_ID,
    source: process.env.NANASA_REPORTER_SOURCE || source,
    protocolVersion: Number(process.env.NANASA_REPORTER_PROTOCOL_VERSION),
    reporterVersion: process.env.NANASA_REPORTER_VERSION,
    runId: process.env.NANASA_REPORTER_RUN_ID,
    generation: Number(process.env.NANASA_REPORTER_GENERATION),
    reporterEpoch: process.env.NANASA_REPORTER_EPOCH,
    sourceSequence,
    event,
    occurredAt: new Date().toISOString(),
    ...(input.session_id || input.sessionId ? { nativeSessionId: input.session_id || input.sessionId } : {}),
    ...fields,
  };
}

function normalize(input) {
  const name = configuredEvent || input.hook_event_name || input.eventName || input.event_name;
  const tool = input.tool_name || input.toolName;
  const session = input.session_id || input.sessionId || "session";
  const operation = input.tool_use_id || input.toolUseId || stableId(source, session, tool || "tool");
  const permission = stableId(source, session, "permission");
  const events = [];
  if (name === "SessionStart" || name === "sessionStart") events.push(base(input, "session.ready"));
  else if (name === "UserPromptSubmit" || name === "userPromptSubmitted") events.push(base(input, "turn.started"));
  else if (name === "PreToolUse" || name === "preToolUse") {
    if (tool === "AskUserQuestion" || tool === "ask_user") {
      events.push(base(input, "wait.opened", { requestId: operation, data: { waitKind: "question", summary: "Agent question requires input", replyChannel: "terminal" } }));
    } else if (tool === "ExitPlanMode") {
      events.push(base(input, "wait.opened", { requestId: operation, data: { waitKind: "plan_approval", summary: "Plan approval required", replyChannel: "terminal" } }));
    } else {
      events.push(base(input, "tool.started", { operationId: operation, data: { ...(tool ? { tool } : {}) } }));
    }
  } else if (name === "PermissionRequest" || name === "permissionRequest") {
    events.push(base(input, "wait.opened", { requestId: permission, data: { waitKind: "permission", summary: "Tool permission required", replyChannel: "terminal" } }));
  } else if (["PostToolUse", "postToolUse", "PostToolUseFailure", "postToolUseFailure"].includes(name)) {
    const failed = name === "PostToolUseFailure" || name === "postToolUseFailure";
    if (tool === "AskUserQuestion" || tool === "ask_user" || tool === "ExitPlanMode") {
      events.push(base(input, "wait.closed", { requestId: operation, data: {} }));
    } else {
      events.push(base(input, failed ? "tool.failed" : "tool.finished", { operationId: operation, data: { ...(tool ? { tool } : {}) } }));
    }
    events.push(base(input, "wait.closed", { requestId: permission, data: {} }));
  } else if (name === "Stop" || name === "agentStop") {
    const activeCount = Array.isArray(input.background_tasks) ? input.background_tasks.length : 0;
    events.push(base(input, "wait.closed", { requestId: permission, data: {} }));
    events.push(base(input, "turn.settled", { data: { activeCount } }));
  } else if (name === "StopFailure" || name === "errorOccurred") {
    const fatal = input.recoverable === false;
    events.push(base(input, "failure.observed", { data: { ...(input.error ? { errorClass: typeof input.error === "string" ? input.error : input.error.name } : {}), fatal } }));
  } else if (name === "PreCompact" || name === "preCompact") events.push(base(input, "compaction.started"));
  else if (name === "PostCompact") events.push(base(input, "compaction.finished"));
  else if (name === "Elicitation") {
    const requestId = input.elicitation_id || stableId(source, session, "elicitation");
    events.push(base(input, "wait.opened", { requestId, data: { waitKind: "elicitation", summary: "MCP elicitation requires input", replyChannel: "terminal" } }));
  } else if (name === "ElicitationResult") {
    const requestId = input.elicitation_id || stableId(source, session, "elicitation");
    events.push(base(input, "wait.closed", { requestId, data: {} }));
  } else if (name === "SessionEnd" || name === "sessionEnd") events.push(base(input, "session.ended"));
  return events;
}

async function send(event) {
  const url = process.env.NANASA_STATUS_URL;
  const token = process.env.NANASA_MCP_TOKEN;
  if (!url || !token || !event) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
  } catch {}
  finally { clearTimeout(timeout); }
}

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  for (const event of normalize(input)) await send(event);
} catch {}
`;

export const PI_STATUS_REPORTER_SOURCE = String.raw`function reporter() {
  const url = process.env.NANASA_STATUS_URL;
  const token = process.env.NANASA_MCP_TOKEN;
  let sessionId;
  let sourceSequence = 0;
  let heartbeat;
  let disabled = false;
  let rootSession = false;
  let delivery = Promise.resolve();
  const heartbeatMs = Math.max(50, Number(process.env.NANASA_REPORTER_HEARTBEAT_MS) || 15000);
  const retryDelays = [0, 100, 400];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const disable = () => { disabled = true; rootSession = false; clearInterval(heartbeat); heartbeat = undefined; };
  const deliver = async (envelope) => {
    for (const retryDelay of retryDelays) {
      if (disabled) return;
      if (retryDelay > 0) await delay(retryDelay);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(envelope), signal: controller.signal });
        if (response.status === 409) {
          const body = await response.json().catch(() => undefined);
          if (body?.code === "status_reporter_identity_fenced" || body?.code === "status_native_session_fenced") { disable(); return; }
        }
        if (response.ok) return;
      } catch {}
      finally { clearTimeout(timeout); }
    }
  };
  const send = (event, fields = {}, eventSessionId = sessionId) => {
    if (!url || !token || disabled || !rootSession) return Promise.resolve();
    const envelope = { version: 2, eventId: crypto.randomUUID(), providerId: process.env.NANASA_REPORTER_PROVIDER_ID, adapterId: process.env.NANASA_REPORTER_ADAPTER_ID, reporterId: process.env.NANASA_REPORTER_ID, source: process.env.NANASA_REPORTER_SOURCE, protocolVersion: Number(process.env.NANASA_REPORTER_PROTOCOL_VERSION), reporterVersion: process.env.NANASA_REPORTER_VERSION, runId: process.env.NANASA_REPORTER_RUN_ID, generation: Number(process.env.NANASA_REPORTER_GENERATION), reporterEpoch: process.env.NANASA_REPORTER_EPOCH, sourceSequence: ++sourceSequence, event, occurredAt: new Date().toISOString(), ...(eventSessionId ? { nativeSessionId: eventSessionId } : {}), ...fields };
    delivery = delivery.then(() => deliver(envelope));
    return delivery;
  };
  return (pi) => {
    pi.on("session_start", async (_event, ctx) => {
      if (disabled || ctx?.mode !== "tui") return;
      rootSession = true;
      const startedSessionId = ctx.sessionManager.getSessionId();
      sessionId = startedSessionId;
      await send("session.ready", {}, startedSessionId);
      await send(ctx?.isIdle?.() === false ? "turn.started" : "turn.settled", {}, startedSessionId);
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send("heartbeat"), heartbeatMs);
      heartbeat.unref?.();
    });
    pi.on("agent_start", () => send("turn.started"));
    pi.on("tool_execution_start", (event) => send("tool.started", { operationId: event.toolCallId, data: { tool: event.toolName } }));
    pi.on("tool_execution_end", (event) => send(event.isError ? "tool.failed" : "tool.finished", { operationId: event.toolCallId, data: { tool: event.toolName } }));
    pi.on("session_before_compact", () => send("compaction.started"));
    pi.on("session_compact", () => send("compaction.finished"));
    pi.on("agent_settled", (_event, ctx) => { if (ctx?.isIdle?.() !== false) send("turn.settled"); });
    pi.on("session_shutdown", () => { send("session.ended"); clearInterval(heartbeat); heartbeat = undefined; rootSession = false; });
  };
}
export default reporter();
`;

export const OPENCODE_STATUS_REPORTER_SOURCE = String.raw`const ROOT_SESSION_KEY = Symbol.for("nanasa.opencode.root-session.v1");
function rootSessionState() {
  if (!globalThis[ROOT_SESSION_KEY]) globalThis[ROOT_SESSION_KEY] = { sessionId: undefined, listeners: new Set() };
  return globalThis[ROOT_SESSION_KEY];
}
export const NanasaStatusPlugin = async () => {
  const url = process.env.NANASA_STATUS_URL;
  const token = process.env.NANASA_MCP_TOKEN;
  const roots = rootSessionState();
  const childParents = new Map();
  let sourceSequence = 0;
  let reportedRootSessionId;
  let heartbeat;
  let disabled = false;
  let delivery = Promise.resolve();
  const heartbeatMs = Math.max(50, Number(process.env.NANASA_REPORTER_HEARTBEAT_MS) || 15000);
  const retryDelays = [0, 100, 400, 1000];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const disable = () => { disabled = true; clearInterval(heartbeat); heartbeat = undefined; childParents.clear(); roots.listeners.delete(selectRoot); };
  const deliver = async (envelope) => {
    for (const retryDelay of retryDelays) {
      if (disabled) return;
      if (retryDelay > 0) await delay(retryDelay);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(envelope), signal: controller.signal });
        if (response.status === 409) {
          const body = await response.json().catch(() => undefined);
          if (body?.code === "status_reporter_identity_fenced" || body?.code === "status_native_session_fenced") { disable(); return; }
        }
        if (response.ok) return;
      } catch {}
      finally { clearTimeout(timeout); }
    }
  };
  const send = (event, sessionId, fields = {}) => {
    if (!url || !token || disabled || !sessionId) return Promise.resolve();
    const envelope = { version: 2, eventId: crypto.randomUUID(), providerId: process.env.NANASA_REPORTER_PROVIDER_ID, adapterId: process.env.NANASA_REPORTER_ADAPTER_ID, reporterId: process.env.NANASA_REPORTER_ID, source: process.env.NANASA_REPORTER_SOURCE, protocolVersion: Number(process.env.NANASA_REPORTER_PROTOCOL_VERSION), reporterVersion: process.env.NANASA_REPORTER_VERSION, runId: process.env.NANASA_REPORTER_RUN_ID, generation: Number(process.env.NANASA_REPORTER_GENERATION), reporterEpoch: process.env.NANASA_REPORTER_EPOCH, sourceSequence: ++sourceSequence, event, occurredAt: new Date().toISOString(), nativeSessionId: sessionId, ...fields };
    delivery = delivery.then(() => deliver(envelope));
    return delivery;
  };
  const selectRoot = (sessionId) => {
    if (disabled || !sessionId || reportedRootSessionId === sessionId) return;
    reportedRootSessionId = sessionId;
    send("session.ready", sessionId);
  };
  roots.listeners.add(selectRoot);
  selectRoot(roots.sessionId);
  heartbeat = setInterval(() => send("heartbeat", reportedRootSessionId), heartbeatMs);
  heartbeat.unref?.();
  return {
    event: async ({ event }) => {
      if (disabled) return;
      const properties = event.properties || {};
      const sessionId = properties.sessionID || properties.sessionId || properties.info?.id || properties.part?.sessionID;
      if (event.type === "session.created" && properties.info?.id) {
        if (properties.info.parentID) childParents.set(properties.info.id, properties.info.parentID);
        else selectRoot(properties.info.id);
        return;
      }
      const childParent = sessionId ? childParents.get(sessionId) : undefined;
      const authoritativeSessionId = childParent === reportedRootSessionId ? reportedRootSessionId : sessionId;
      if (childParent !== undefined) {
        if (authoritativeSessionId !== reportedRootSessionId) return;
        if (event.type === "permission.asked") send("wait.opened", authoritativeSessionId, { requestId: properties.id, data: { waitKind: "permission", summary: "Tool permission required", replyChannel: "terminal" } });
        else if (event.type === "permission.replied") send("wait.closed", authoritativeSessionId, { requestId: properties.requestID, data: {} });
        else if (event.type === "question.asked") send("wait.opened", authoritativeSessionId, { requestId: properties.id, data: { waitKind: "question", summary: "Agent question requires input", replyChannel: "terminal" } });
        else if (event.type === "question.replied" || event.type === "question.rejected") send("wait.closed", authoritativeSessionId, { requestId: properties.requestID, data: {} });
        else if (event.type === "session.deleted") childParents.delete(sessionId);
        return;
      }
      if (!sessionId || sessionId !== reportedRootSessionId) return;
      if (event.type === "session.status") {
        const status = properties.status || {};
        if (["active", "busy", "pending", "running", "streaming", "working"].includes(String(status.type).toLowerCase())) send("turn.started", sessionId);
        else if (String(status.type).toLowerCase() === "idle") send("turn.settled", sessionId);
        else if (String(status.type).toLowerCase() === "retry") send("retry.observed", sessionId, { data: { ...(status.next ? { retryAt: new Date(status.next).toISOString() } : {}) } });
      } else if (event.type === "session.idle") send("turn.settled", sessionId);
      else if (event.type === "permission.asked") send("wait.opened", sessionId, { requestId: properties.id, data: { waitKind: "permission", summary: "Tool permission required", replyChannel: "terminal" } });
      else if (event.type === "permission.replied") send("wait.closed", sessionId, { requestId: properties.requestID, data: {} });
      else if (event.type === "question.asked") send("wait.opened", sessionId, { requestId: properties.id, data: { waitKind: "question", summary: "Agent question requires input", replyChannel: "terminal" } });
      else if (event.type === "question.replied" || event.type === "question.rejected") send("wait.closed", sessionId, { requestId: properties.requestID, data: {} });
      else if (event.type === "message.part.updated" && properties.part?.type === "tool") {
        const part = properties.part;
        const state = part.state?.status || part.state?.type;
        const operationId = part.callID;
        if (operationId && (state === "pending" || state === "running")) send("tool.started", sessionId, { operationId, data: { tool: part.tool } });
        else if (operationId && state === "completed") send("tool.finished", sessionId, { operationId, data: { tool: part.tool } });
        else if (operationId && state === "error") send("tool.failed", sessionId, { operationId, data: { tool: part.tool } });
      } else if (event.type === "session.error") send("failure.observed", sessionId, { data: { errorClass: properties.error?.name || "session_error" } });
      else if (event.type === "session.deleted") { send("session.ended", sessionId); reportedRootSessionId = undefined; }
    },
  };
};
export default NanasaStatusPlugin;
`;

export const OPENCODE_TUI_STATUS_REPORTER_SOURCE = String.raw`const ROOT_SESSION_KEY = Symbol.for("nanasa.opencode.root-session.v1");
function rootSessionState() {
  if (!globalThis[ROOT_SESSION_KEY]) globalThis[ROOT_SESSION_KEY] = { sessionId: undefined, listeners: new Set() };
  return globalThis[ROOT_SESSION_KEY];
}
export default {
  id: "nanasa.opencode.root-session",
  tui: async (api) => {
    const roots = rootSessionState();
    const syncSelectedSession = () => {
      const route = api.route.current;
      const sessionId = route?.name === "session" ? route.params?.sessionID : undefined;
      const session = typeof sessionId === "string" && sessionId ? api.state.session.get(sessionId) : undefined;
      if (!session || session.parentID) return;
      if (roots.sessionId === sessionId) return;
      roots.sessionId = sessionId;
      for (const listener of roots.listeners) listener(sessionId);
    };
    syncSelectedSession();
    const routePoll = setInterval(syncSelectedSession, 100);
    routePoll.unref?.();
    api.lifecycle.onDispose(() => clearInterval(routePoll));
  },
};
`;
