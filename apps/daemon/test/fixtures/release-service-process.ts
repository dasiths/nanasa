import { writeFileSync } from "node:fs";
import { createDaemon } from "../../src/server.js";

const repository = process.env.NANASA_TEST_REPOSITORY;
const database = process.env.NANASA_TEST_DATABASE;
const port = Number(process.env.NANASA_TEST_PORT);
if (repository === undefined || database === undefined || !Number.isInteger(port) || port < 1) {
  throw new Error("Release service harness configuration is invalid");
}

const daemon = await createDaemon({
  repoRoot: repository,
  dataPath: database,
  runtimePath: `${repository}/.nanasa/runtime`,
  reconcileIntervalMs: 60_000,
});
await daemon.app.listen({ host: "127.0.0.1", port });

if (process.env.NANASA_TEST_CANDIDATE === "1") {
  daemon.store.createGroup({ name: "Candidate mutation" });
  for (const [name, value] of [
    ["NANASA_TEST_CONFIG", "version: 2\ncandidate: true\n"],
    ["NANASA_TEST_LOCK", "version: 1\nrevision: 4\nextensions: {}\n"],
    ["NANASA_TEST_OVERLAY", '{"revision":4,"owner":"candidate"}\n'],
    ["NANASA_TEST_NEW_OVERLAY", '{"revision":1,"owner":"candidate"}\n'],
  ] as const) {
    const path = process.env[name];
    if (path !== undefined) writeFileSync(path, value);
  }
}

const close = async () => {
  await daemon.app.close();
  process.exit(0);
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
