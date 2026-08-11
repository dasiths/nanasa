import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun, TerminalEndpointStatus } from "@nanasa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { loadNanasaConfig } from "../src/config.js";
import { createDaemon, type DaemonContext } from "../src/server.js";
import { ttydViewSessionName } from "../src/ttyd-supervisor.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const ttydAvailable = spawnSync("ttyd", ["--version"], { encoding: "utf8" }).status === 0;
const temporaryDirectories: string[] = [];
const tmuxServers: string[] = [];
const openDaemons = new Set<DaemonContext>();

afterEach(async () => {
  for (const daemon of openDaemons) {
    await daemon.app.close();
  }
  openDaemons.clear();
  for (const serverName of tmuxServers.splice(0)) {
    spawnSync("tmux", ["-L", serverName, "kill-server"], { encoding: "utf8" });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tmux(serverName: string, args: string[]): string {
  const result = spawnSync("tmux", ["-L", serverName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tmux exited with ${result.status}`);
  }
  return result.stdout.trim();
}

async function waitForTmuxClientCount(
  serverName: string,
  sessionName: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const clients = tmux(serverName, [
      "list-clients",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{client_pid}",
    ]);
    const count = clients === "" ? 0 : clients.split("\n").length;
    if (count === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} tmux clients in ${sessionName}`);
}

function expectOwnerPaneAlive(serverName: string, run: AgentRun): void {
  expect(
    tmux(serverName, ["display-message", "-p", "-t", run.terminal!.paneId, "#{pane_dead}"]),
  ).toBe("0");
}

async function waitForEndpoint(
  daemon: DaemonContext,
  runId: string,
): Promise<TerminalEndpointStatus> {
  const deadline = Date.now() + 8_000;
  let lastStatus: TerminalEndpointStatus | undefined;
  while (Date.now() < deadline) {
    const response = await daemon.app.inject({
      method: "GET",
      url: `/api/runs/${encodeURIComponent(runId)}/terminal`,
    });
    const status = response.json<TerminalEndpointStatus>();
    lastStatus = status;
    if (status.state === "ready") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for terminal endpoint ${runId}: ${JSON.stringify({
      status: lastStatus,
      run: daemon.store.getRun(runId),
      events: daemon.store
        .listEvents()
        .filter(
          (event) =>
            event.aggregateId === runId &&
            (event.type.startsWith("ttyd.") || event.type === "run.recovery-failed"),
        )
        .slice(-20)
        .map((event) => ({ type: event.type, payload: event.payload })),
    })}`,
  );
}

async function waitForEndpointState(
  daemon: DaemonContext,
  runId: string,
  expected: TerminalEndpointStatus["state"],
): Promise<TerminalEndpointStatus> {
  const deadline = Date.now() + 8_000;
  let lastStatus: TerminalEndpointStatus | undefined;
  while (Date.now() < deadline) {
    const response = await daemon.app.inject({
      method: "GET",
      url: `/api/runs/${encodeURIComponent(runId)}/terminal`,
    });
    lastStatus = response.json<TerminalEndpointStatus>();
    if (lastStatus.state === expected) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for terminal endpoint ${runId} to become ${expected}: ${JSON.stringify(lastStatus)}`,
  );
}

function ttydPids(basePath: string): number[] {
  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `ps exited with ${result.status}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .filter((match) => match[2]!.includes(`--base-path ${basePath}`))
    .map((match) => Number(match[1]));
}

async function waitForTtydProcessCount(basePath: string, expected: number): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pids = ttydPids(basePath);
    if (pids.length === expected) {
      return pids;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} ttyd processes at ${basePath}`);
}

async function waitForRunStatus(
  daemon: DaemonContext,
  runId: string,
  expected: AgentRun["status"],
): Promise<AgentRun> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const run = daemon.store.getRun(runId);
    if (run.status === expected) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to become ${expected}`);
}

async function waitForReplacementRun(daemon: DaemonContext, previous: AgentRun): Promise<AgentRun> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const replacement = daemon.store
      .listDesiredRunningRuns()
      .find(
        (run) =>
          run.groupId === previous.groupId &&
          run.memberId === previous.memberId &&
          run.generation > previous.generation &&
          run.status === "running" &&
          run.recoveryPhase === "recovered",
      );
    if (replacement !== undefined) return replacement;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for a replacement generation after ${previous.id}`);
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

async function connectTerminal(
  url: string,
  origin: string,
): Promise<{
  socket: WebSocket;
  outputUntil(text: string): Promise<string>;
}> {
  const socket = new WebSocket(url, "tty", { origin });
  let output = "";
  const waiters = new Set<{
    text: string;
    resolve(value: string): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  socket.on("message", (data) => {
    const frame = rawDataBuffer(data);
    if (frame[0] === "0".charCodeAt(0)) {
      output += frame.subarray(1).toString("utf8");
    }
    for (const waiter of waiters) {
      if (output.includes(waiter.text)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(output);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ AuthToken: "", columns: 100, rows: 30 }));
  return {
    socket,
    outputUntil(text) {
      if (output.includes(text)) {
        return Promise.resolve(output);
      }
      return new Promise<string>((resolve, reject) => {
        const waiter = {
          text,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ttyd output ${JSON.stringify(text)}`));
          }, 5_000),
        };
        waiter.timer.unref();
        waiters.add(waiter);
      });
    },
  };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.close();
  });
}

const describeRuntime = tmuxAvailable && ttydAvailable ? describe : describe.skip;

describeRuntime("real tmux and ttyd runtime", () => {
  it("isolates two run views and reconciles endpoints without killing owner panes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nanasa-ttyd-"));
    temporaryDirectories.push(directory);
    const dataPath = join(directory, "nanasa.sqlite");
    const serverName = `nanasa-ttyd-test-${process.pid}-${Date.now()}`;
    tmuxServers.push(serverName);
    const fixtureCode = [
      'const readline = require("node:readline");',
      "console.log(`READY:${process.env.NANASA_MEMBER}`);",
      'readline.createInterface({ input: process.stdin }).on("line",',
      "  (line) => console.log(`ECHO:${process.env.NANASA_MEMBER}:${line}`));",
    ].join("");
    mkdirSync(join(directory, ".git"));
    mkdirSync(join(directory, ".nanasa"));
    writeFileSync(
      join(directory, ".nanasa", "config.yaml"),
      `version: 1
agentTypes:
  test-echo:
    name: Echo fixture
    kind: opencode
    command: ${JSON.stringify(["node", "-e", fixtureCode])}
    cwd: .
    environment: { NANASA_MEMBER: shared }
    agentConfigHome: { scope: agent-type }
agentProfiles: {}
groups: {}
messages: { retentionPerGroup: 1000 }
`,
    );
    const first = await createDaemon({
      dataPath,
      loadedConfig: loadNanasaConfig(directory),
      tmuxServerName: serverName,
      ttydPath: "ttyd",
      reconcileIntervalMs: 50,
    });
    openDaemons.add(first);
    const firstAddress = await first.app.listen({ host: "127.0.0.1", port: 0 });

    const group = (
      await first.app.inject({ method: "POST", url: "/api/groups", payload: { name: "Shells" } })
    ).json<{ id: string }>();
    const profile = (
      await first.app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { name: "Echo fixture", agentType: "test-echo" },
      })
    ).json<{ id: string }>();
    for (const memberId of ["alpha", "beta"]) {
      expect(
        (
          await first.app.inject({
            method: "POST",
            url: `/api/groups/${group.id}/memberships`,
            payload: { memberId, agentProfileId: profile.id, alias: memberId },
          })
        ).statusCode,
      ).toBe(201);
    }

    const runs: AgentRun[] = [];
    for (const memberId of ["alpha", "beta"]) {
      const response = await first.app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/memberships/${memberId}/run`,
        payload: { cols: 100, rows: 30 },
      });
      expect(response.statusCode, response.body).toBe(201);
      runs.push(response.json<AgentRun>());
    }
    const [alpha, beta] = runs as [AgentRun, AgentRun];
    expect(alpha.terminal?.sessionId).toBe(beta.terminal?.sessionId);
    expect(alpha.terminal?.windowId).not.toBe(beta.terminal?.windowId);
    expect(tmux(serverName, ["show-options", "-gv", "extended-keys"])).toBe("on");
    expect(tmux(serverName, ["show-options", "-gv", "set-clipboard"])).toBe("on");
    expect(tmux(serverName, ["show-options", "-gv", "terminal-features"])).toContain(
      "xterm-256color:extkeys:clipboard",
    );
    for (const run of runs) {
      const paneTty = tmux(serverName, [
        "display-message",
        "-p",
        "-t",
        run.terminal!.paneId,
        "#{pane_tty}",
      ]);
      const terminalMode = spawnSync("stty", ["-a", "-F", paneTty], { encoding: "utf8" });
      expect(terminalMode.status, terminalMode.stderr).toBe(0);
      expect(terminalMode.stdout).toMatch(/(?:^|\s)-ixon(?:\s|;)/);
    }

    const statuses = await Promise.all(runs.map((run) => waitForEndpoint(first, run.id)));
    expect(statuses[0].url).not.toBe(statuses[1].url);
    for (const run of runs) {
      expect(
        tmux(serverName, [
          "list-panes",
          "-t",
          `=${ttydViewSessionName(run.id)}`,
          "-F",
          "#{window_id}\t#{pane_id}",
        ]),
      ).toBe(`${run.terminal?.windowId}\t${run.terminal?.paneId}`);
      expect(
        tmux(serverName, ["show-options", "-t", ttydViewSessionName(run.id), "-v", "prefix"]),
      ).toBe("None");
      expect(
        tmux(serverName, ["show-options", "-t", ttydViewSessionName(run.id), "-v", "prefix2"]),
      ).toBe("None");
      expect(
        tmux(serverName, ["show-options", "-t", ttydViewSessionName(run.id), "-v", "status"]),
      ).toBe("off");
      expect(
        tmux(serverName, [
          "show-options",
          "-t",
          ttydViewSessionName(run.id),
          "-v",
          "destroy-unattached",
        ]),
      ).toBe("off");
      expect(
        tmux(serverName, [
          "show-options",
          "-w",
          "-t",
          `${ttydViewSessionName(run.id)}:1`,
          "-v",
          "window-size",
        ]),
      ).toBe("latest");
    }

    for (const status of statuses) {
      if (status.state !== "ready") {
        throw new Error("Expected a ready endpoint");
      }
      expect(await waitForTtydProcessCount(status.url.slice(0, -1), 1)).toHaveLength(1);
      const index = await fetch(`${firstAddress}${status.url}`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("ttyd");
      const token = await fetch(`${firstAddress}${status.url}token`);
      expect(token.status).toBe(200);
    }

    const clients = await Promise.all(
      statuses.map((status) => {
        if (status.state !== "ready") {
          throw new Error("Expected a ready endpoint");
        }
        return connectTerminal(
          `${firstAddress.replace(/^http:/, "ws:")}${status.url}ws`,
          firstAddress,
        );
      }),
    );
    await Promise.all(
      runs.map((run) => waitForTmuxClientCount(serverName, ttydViewSessionName(run.id), 1)),
    );
    await Promise.all(clients.map((client) => client.outputUntil("READY:shared")));
    clients[0].socket.send(Buffer.concat([Buffer.from("0"), Buffer.from("alpha-input\r")]));
    clients[1].socket.send(Buffer.concat([Buffer.from("0"), Buffer.from("beta-input\r")]));
    expect(await clients[0].outputUntil("ECHO:shared:alpha-input")).not.toContain("beta-input");
    expect(await clients[1].outputUntil("ECHO:shared:beta-input")).not.toContain("alpha-input");
    await closeSocket(clients[0].socket);
    await waitForTmuxClientCount(serverName, ttydViewSessionName(alpha.id), 0);
    await waitForTmuxClientCount(serverName, ttydViewSessionName(beta.id), 1);
    runs.forEach((run) => expectOwnerPaneAlive(serverName, run));
    await closeSocket(clients[1].socket);
    await waitForTmuxClientCount(serverName, ttydViewSessionName(beta.id), 0);
    runs.forEach((run) => expectOwnerPaneAlive(serverName, run));

    await first.app.close();
    openDaemons.delete(first);
    for (const [index, run] of runs.entries()) {
      expectOwnerPaneAlive(serverName, run);
      expect(tmux(serverName, ["has-session", "-t", `=${ttydViewSessionName(run.id)}`])).toBe("");
      const status = statuses[index];
      if (status?.state === "ready") {
        expect(await waitForTtydProcessCount(status.url.slice(0, -1), 0)).toEqual([]);
      }
    }

    const reopened = await createDaemon({
      dataPath,
      loadedConfig: loadNanasaConfig(directory),
      tmuxServerName: serverName,
      ttydPath: "ttyd",
      reconcileIntervalMs: 50,
    });
    openDaemons.add(reopened);
    const reopenedAddress = await reopened.app.listen({ host: "127.0.0.1", port: 0 });
    const reconciled = await Promise.all(runs.map((run) => waitForEndpoint(reopened, run.id)));
    expect(reconciled.map((status) => status.state)).toEqual(["ready", "ready"]);
    expect(reconciled.map((status) => status.url)).toEqual(statuses.map((status) => status.url));
    for (const [index, status] of reconciled.entries()) {
      expect(reopened.store.getRun(runs[index]!.id).terminal).toEqual(runs[index]!.terminal);
      if (status.state === "ready") {
        expect((await fetch(`${reopenedAddress}${status.url}`)).status).toBe(200);
      }
    }

    const betaStatus = reconciled[1];
    if (betaStatus?.state !== "ready") {
      throw new Error("Expected beta endpoint to be ready");
    }
    const [crashedPid] = await waitForTtydProcessCount(betaStatus.url.slice(0, -1), 1);
    process.kill(crashedPid!, "SIGKILL");
    expect((await waitForEndpointState(reopened, beta.id, "backoff")).state).toBe("backoff");
    expect(reopened.store.getRun(beta.id).status).toBe("running");
    const recovered = await waitForEndpoint(reopened, beta.id);
    expect(recovered.url).toBe(betaStatus.url);
    const [recoveredPid] = await waitForTtydProcessCount(betaStatus.url.slice(0, -1), 1);
    expect(recoveredPid).not.toBe(crashedPid);

    tmux(serverName, ["kill-pane", "-t", alpha.terminal!.paneId]);
    const replacementAlpha = await waitForReplacementRun(reopened, alpha);
    expect((await waitForRunStatus(reopened, alpha.id, "failed")).desiredState).toBe("running");
    expect(replacementAlpha).toMatchObject({
      generation: alpha.generation + 1,
      recoveryPhase: "recovered",
      recoveryAttempts: 1,
    });
    expect((await waitForEndpoint(reopened, replacementAlpha.id)).state).toBe("ready");
    expect((await waitForEndpointState(reopened, alpha.id, "stopped")).state).toBe("stopped");
    expect(tmux(serverName, ["list-sessions", "-F", "#{session_name}"]).split("\n")).not.toContain(
      ttydViewSessionName(alpha.id),
    );
    const alphaStatus = reconciled[0];
    if (alphaStatus?.state === "ready") {
      expect(await waitForTtydProcessCount(alphaStatus.url.slice(0, -1), 0)).toEqual([]);
    }
    expectOwnerPaneAlive(serverName, replacementAlpha);
    expectOwnerPaneAlive(serverName, beta);

    const stopResponse = await reopened.app.inject({
      method: "DELETE",
      url: `/api/groups/${group.id}/memberships/beta/run`,
    });
    expect(stopResponse.statusCode, stopResponse.body).toBe(200);
    expect(stopResponse.json<AgentRun>().status).toBe("stopped");
    expect((await waitForEndpointState(reopened, beta.id, "stopped")).state).toBe("stopped");
    expect(await waitForTtydProcessCount(betaStatus.url.slice(0, -1), 0)).toEqual([]);
    expect(tmux(serverName, ["list-panes", "-a", "-F", "#{pane_id}"]).split("\n")).not.toContain(
      beta.terminal!.paneId,
    );
  }, 30_000);
});
