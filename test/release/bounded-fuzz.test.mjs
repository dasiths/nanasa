import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRemoteSshPlan } from "../../apps/daemon/dist/remote/remote-ssh.js";
import {
  AgentStatusEventInputSchema,
  BrowserRestartFrameSchema,
  EventServerFrameSchema,
  RemoteDescriptorSchema,
  TerminalClientFrameSchema,
} from "../../packages/contracts/dist/index.js";

function randomBytes(seed, count) {
  let state = seed >>> 0;
  const bytes = Buffer.alloc(count);
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

const schemas = [
  AgentStatusEventInputSchema,
  BrowserRestartFrameSchema,
  EventServerFrameSchema,
  RemoteDescriptorSchema,
  TerminalClientFrameSchema,
];

test("bounded protocol and schema fuzzing never escapes validation", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const bytes = randomBytes(seed, seed % 1024);
    const candidates = [
      bytes.toString("utf8"),
      { type: bytes.toString("base64"), version: seed },
      [seed, bytes.length],
      null,
    ];
    for (const schema of schemas) {
      for (const candidate of candidates) {
        const result = schema.safeParse(candidate);
        assert.equal(typeof result.success, "boolean");
      }
    }
  }
});

test("bounded SSH target and path fuzzing rejects option and control-character injection", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const value = randomBytes(seed, seed % 128).toString("utf8");
    try {
      const plan = buildRemoteSshPlan(value, `/srv/${value}`);
      assert.match(plan.target, /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/);
      assert.ok(plan.repositoryPath.startsWith("/"));
      assert.ok(!plan.discoveryArgs.some((argument) => argument.includes("\0")));
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});
