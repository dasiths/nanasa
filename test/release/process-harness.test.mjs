import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ProcessHarness } from "../support/process-harness.mjs";

test("process harness recognizes only exact owned process identity", async () => {
  const harness = new ProcessHarness("identity");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const record = harness.ownProcess(child, process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  assert.equal(harness.verifyOwnedProcess(record), true);
  assert.equal(harness.verifyOwnedProcess({ ...record, startTime: "wrong" }), false);
  assert.equal(harness.verifyOwnedProcess({ ...record, pid: process.pid }), false);
  harness.terminateOwned();
  await new Promise((resolve) => child.once("exit", resolve));
  harness.assertNoOrphans();
  harness.close();
});

test("process harness records every release resource class", () => {
  const harness = new ProcessHarness("resources");
  harness.register("sockets", "127.0.0.1:3210");
  harness.register("tmuxServers", `nanasa-test-${harness.runId}`);
  harness.register("attachmentHelpers", `node-pty-${harness.runId}`);
  harness.register("databases", `${harness.root}/state.sqlite`);
  const manifest = JSON.parse(readFileSync(harness.manifestPath, "utf8"));
  assert.equal(manifest.resources.sockets.length, 1);
  assert.equal(manifest.resources.tmuxServers.length, 1);
  assert.equal(manifest.resources.attachmentHelpers.length, 1);
  assert.equal(manifest.resources.databases.length, 1);
  harness.close();
});

test("watchdog cleans an exact owned child after its harness owner exits", async () => {
  const moduleUrl = pathToFileURL(resolve("test/support/process-harness.mjs")).href;
  const source = `
    import { spawn } from "node:child_process";
    import { ProcessHarness } from ${JSON.stringify(moduleUrl)};
    const harness = new ProcessHarness("watchdog-e2e");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.once("spawn", () => {
      harness.ownProcess(child, process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      harness.startWatchdog();
      process.stdout.write(JSON.stringify({ pid: child.pid, root: harness.root }) + "\\n");
      process.exit(0);
    });
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  owner.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  await new Promise((resolveExit, reject) => {
    owner.once("error", reject);
    owner.once("exit", resolveExit);
  });
  const record = JSON.parse(output.trim());
  const exactChildIsActive = () => {
    try {
      return readFileSync(`/proc/${record.pid}/cmdline`, "utf8").includes(
        "setInterval(() => {}, 1000)",
      );
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 5_000;
  while ((exactChildIsActive() || existsSync(record.root)) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(exactChildIsActive(), false);
  assert.equal(existsSync(record.root), false);
});
