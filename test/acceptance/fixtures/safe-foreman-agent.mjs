import { randomUUID } from "node:crypto";

let sequence = 0;
let initialized = false;
const environment = process.env;
const nativeSessionId = `fixture-${environment.NANASA_REPORTER_RUN_ID}`;
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write("\u001b[?2004hSAFE_FOREMAN_READY\r\n");

async function report(event) {
  const response = await fetch(environment.NANASA_STATUS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.NANASA_MCP_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: 2,
      eventId: randomUUID(),
      providerId: environment.NANASA_REPORTER_PROVIDER_ID,
      adapterId: environment.NANASA_REPORTER_ADAPTER_ID,
      reporterId: environment.NANASA_REPORTER_ID,
      source: environment.NANASA_REPORTER_SOURCE,
      protocolVersion: Number(environment.NANASA_REPORTER_PROTOCOL_VERSION),
      reporterVersion: environment.NANASA_REPORTER_VERSION,
      runId: environment.NANASA_REPORTER_RUN_ID,
      generation: Number(environment.NANASA_REPORTER_GENERATION),
      reporterEpoch: environment.NANASA_REPORTER_EPOCH,
      sourceSequence: ++sequence,
      nativeSessionId,
      event,
      data: event === "turn.settled" ? { activeCount: 0 } : {},
    }),
  });
  return response.ok;
}

async function tool(name, args) {
  const response = await fetch(environment.NANASA_MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.NANASA_MCP_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "safe-foreman", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const result = await response.json();
  if (!response.ok || result.error || result.result?.isError)
    throw new Error("Fixture MCP request failed");
  return result.result.structuredContent;
}

let pending = Promise.resolve();
const timer = setInterval(() => {
  pending = pending
    .then(async () => {
      if (!initialized) initialized = await report("session.ready");
      else await report("heartbeat");
    })
    .catch(() => undefined);
}, 1500);

function submit(line) {
  process.stdout.write(`SAFE_FOREMAN:${line.replaceAll("\n", "\r\n")}\r\n`);
  pending = pending
    .then(async () => {
      const messageId = line.match(/Operator channel message (fm_[a-z0-9-]+)/)?.[1];
      const review = line.match(/Supervise goal (goal_[a-z0-9-]+)/);
      const questionId = line.match(/\| Request: (question_[a-z0-9-]+)/)?.[1];
      const resultId = line.match(/Conversation result (question_[a-z0-9-]+)/)?.[1];
      const nativeQuestion = line === "Ask the teams from this terminal";
      if (
        messageId === undefined &&
        review === null &&
        questionId === undefined &&
        resultId === undefined &&
        !nativeQuestion
      )
        return;
      await report("turn.started");
      if (nativeQuestion) {
        const teams = await tool("nanasa.foreman_discover_teams", {});
        for (const team of teams.result) {
          if (!team.members.length) continue;
          await tool("nanasa.foreman_ask_member", {
            requestId: `native-${randomUUID()}`,
            groupId: team.id,
            memberId: team.members[0].memberId,
            text: "What is your current status?",
          });
        }
      } else if (questionId !== undefined) {
        const requests = await tool("nanasa.member_foreman_conversations", { id: questionId });
        const request = requests.result.requests[0];
        await tool("nanasa.reply_foreman", {
          id: questionId,
          requestId: `answer-${questionId}`,
          text: `Member ${request.memberId}: no assigned work; ready for discussion.`,
        });
      } else if (resultId !== undefined) {
        const requests = await tool("nanasa.foreman_read_conversations", { id: resultId });
        const request = requests.result.requests[0];
        await tool("nanasa.foreman_reply", {
          requestId: `summary-${resultId}`,
          text: `Team response: ${request.response ?? request.state}`,
        });
        await tool("nanasa.foreman_finish_conversation", { id: resultId });
      } else if (messageId !== undefined) {
        const page = await tool("nanasa.foreman_read_channel", { limit: 100 });
        const message = page.result.messages.find((candidate) => candidate.id === messageId);
        if (message === undefined) throw new Error("Fixture message unavailable");
        await tool("nanasa.foreman_reply", {
          requestId: `reply-${message.id}`,
          replyTo: message.id,
          text: `Fixture reply: ${message.text}`,
          ...(message.teamId === undefined ? {} : { teamId: message.teamId }),
        });
        if (message.text === "Ask both teams what they are doing") {
          const teams = await tool("nanasa.foreman_discover_teams", {});
          for (const team of teams.result) {
            if (!team.members.length) continue;
            await tool("nanasa.foreman_ask_member", {
              requestId: `${messageId}-${team.id}`,
              groupId: team.id,
              memberId: team.members[0].memberId,
              text: "What is your team working on?",
              sourceMessageId: messageId,
            });
          }
        }
      } else {
        await tool("nanasa.foreman_finish_goal_review", {
          goalId: review[1],
        });
      }
      await report("turn.settled");
    })
    .catch(() => process.stdout.write("SAFE_FOREMAN_REQUEST_BLOCKED\n"));
}

let input = "";
let pendingInput = "";
let pasting = false;
process.stdin.on("data", (chunk) => {
  pendingInput += chunk.toString("utf8");
  while (pendingInput.length > 0) {
    if (pendingInput.startsWith("\u001b[I") || pendingInput.startsWith("\u001b[O")) {
      pendingInput = pendingInput.slice(3);
      continue;
    }
    if (pendingInput.startsWith("\u001b[200~")) {
      pasting = true;
      pendingInput = pendingInput.slice(6);
      continue;
    }
    if (pendingInput.startsWith("\u001b[201~")) {
      pasting = false;
      pendingInput = pendingInput.slice(6);
      continue;
    }
    if (pendingInput.startsWith("\u001b") && pendingInput.length < 6) return;
    const character = pendingInput[0];
    pendingInput = pendingInput.slice(1);
    if (!pasting && (character === "\r" || character === "\n")) {
      const line = input;
      input = "";
      submit(line);
    } else if (character === "\u007f") input = input.slice(0, -1);
    else if (character !== "\u001b") input += character;
  }
});

function close() {
  clearInterval(timer);
  process.stdin.setRawMode?.(false);
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
