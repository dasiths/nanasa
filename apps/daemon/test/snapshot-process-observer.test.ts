import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNanasaDatabase } from "../src/persistence/database.js";
import { ProcessIdentityObserver } from "../src/process-identity-observer.js";
import { buildTrustedBuiltinCopilotPackage } from "../src/providers/builtin-provider-packages.js";
import { ProviderProcessIncarnationRepository } from "../src/providers/provider-process-incarnation-repository.js";
import { ProviderRunBindingRepository } from "../src/providers/provider-run-binding-repository.js";
import { ProviderRuntimeIndex } from "../src/providers/provider-runtime-index.js";
import { ProviderSnapshotRepository } from "../src/providers/provider-snapshot-repository.js";
import { SnapshotProcessObserver } from "../src/providers/snapshot-process-observer.js";

const now = "2026-09-01T00:00:00.000Z";
const directories: string[] = [];
let database: DatabaseSync;

function seedRun(): void {
  database.exec(`
    INSERT INTO groups
      (id,name,order_index,membership_revision,message_sequence,created_at,updated_at)
    VALUES ('group-one','Group',0,0,0,'${now}','${now}');
    INSERT INTO agent_profiles
      (id,name,agent_type,kind,command,args_json,working_directory,environment_json,created_at,updated_at)
    VALUES ('profile-one','Copilot','copilot','copilot','copilot','[]',NULL,'{}','${now}','${now}');
    INSERT INTO runs
      (id,group_id,member_id,agent_profile_id,generation,status,desired_state,recovery_phase,
       recovery_attempts,launch_kind,requested_model_source,started_at)
    VALUES ('run-one','group-one','member-one','profile-one',1,'running','running','recovered',
            0,'fresh','provider-default','${now}');
  `);
}

function writeProcess(root: string, pid: number, start: number, command: readonly string[]): void {
  const directory = join(root, String(pid));
  mkdirSync(join(directory, "task", String(pid)), { recursive: true });
  const fields = [
    "S",
    "1",
    String(pid),
    "0",
    "0",
    String(pid),
    ...Array(13).fill("0"),
    String(start),
    "0",
  ];
  writeFileSync(join(directory, "stat"), `${pid} (process) ${fields.join(" ")}`);
  writeFileSync(join(directory, "cmdline"), `${command.join("\0")}\0`);
  writeFileSync(join(directory, "task", String(pid), "children"), "");
}

beforeEach(() => {
  database = openNanasaDatabase(":memory:");
  seedRun();
});

afterEach(() => {
  database.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("snapshot-aware process incarnations", () => {
  it("batches recognition and rolls PID reuse into one new active incarnation", async () => {
    const builtIn = await buildTrustedBuiltinCopilotPackage();
    const snapshots = new ProviderSnapshotRepository(database);
    const index = new ProviderRuntimeIndex(database, snapshots);
    await index.registerTrustedBuiltin(builtIn, now);
    const bindings = new ProviderRunBindingRepository(database, index, snapshots);
    const binding = await bindings.create({
      runId: "run-one",
      generation: 1,
      integrationId: "copilot",
      providerId: "copilot",
      snapshotDigest: builtIn.snapshot.digest,
      providerStateId: "state-one",
      overlayId: "overlay-one",
      credentialSlots: {},
      launchPlan: {
        configuredCommand: ["copilot"],
        command: ["copilot"],
        overlayArguments: [],
        environmentNames: [],
        stateStorageReference: "/state/copilot",
        modelResumePolicy: "preserve-session",
      },
      launchDigest: "1".repeat(64),
      permissionFloorDigest: "2".repeat(64),
      repositoryTrustDigest: "3".repeat(64),
      createdAt: now,
    });
    const procRoot = mkdtempSync(join(tmpdir(), "nanasa-snapshot-proc-"));
    directories.push(procRoot);
    writeProcess(procRoot, 100, 50, ["copilot"]);
    const incarnations = new ProviderProcessIncarnationRepository(database);
    const observer = new SnapshotProcessObserver(
      bindings,
      incarnations,
      new ProcessIdentityObserver({ procRoot }),
      2,
    );
    const request = {
      runId: "run-one",
      generation: 1,
      paneId: "%1",
      panePid: 100,
      observedAt: now,
    } as const;

    const [first] = await observer.observeBatch([request]);
    expect(first).toMatchObject({
      fence: {
        bindingId: binding.id,
        snapshotDigest: builtIn.snapshot.digest,
      },
      paneId: "%1",
      foregroundPgid: 100,
      leaderPid: 100,
      pidStartIdentity: "100:50",
    });
    expect(await observer.observeBatch([request])).toEqual([first]);

    writeProcess(procRoot, 100, 51, ["copilot"]);
    const [replacement] = await observer.observeBatch([
      { ...request, observedAt: "2026-09-01T00:00:01.000Z" },
    ]);
    expect(replacement!.digest).not.toBe(first!.digest);
    expect(incarnations.get(first!.digest)?.endedAt).toBe("2026-09-01T00:00:01.000Z");
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM provider_process_incarnations WHERE ended_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 1 });

    writeProcess(procRoot, 100, 52, ["node", "worker.mjs"]);
    await expect(
      observer.observeBatch([{ ...request, observedAt: "2026-09-01T00:00:02.000Z" }]),
    ).rejects.toThrow(/does not match the pinned provider snapshot/);
    expect(
      database.prepare("SELECT count(*) AS count FROM provider_process_incarnations").get(),
    ).toEqual({ count: 2 });
  });
});
