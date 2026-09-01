import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  AgentStatusEventInputSchema,
  ControlMetadataSchema,
  EventServerFrameSchema,
  NanasaConfigSchema,
  TerminalClientFrameSchema,
} from "../../packages/contracts/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const fixtures = join(root, "fixtures", "release");
const manifest = JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");

for (const [name, expected] of Object.entries(manifest.fixtures)) {
  test(`immutable fixture ${name} matches its digest`, () => {
    assert.equal(digest(readFileSync(join(fixtures, name))), expected);
  });
}

test("versioned fixtures parse through final contracts", () => {
  ControlMetadataSchema.parse(
    JSON.parse(readFileSync(join(fixtures, "control-meta.v1.json"), "utf8")),
  );
  EventServerFrameSchema.parse(
    JSON.parse(readFileSync(join(fixtures, "event-frame.v1.json"), "utf8")),
  );
  TerminalClientFrameSchema.parse(
    JSON.parse(readFileSync(join(fixtures, "terminal-frame.v1.json"), "utf8")),
  );
  AgentStatusEventInputSchema.parse(
    JSON.parse(readFileSync(join(fixtures, "reporter-event.v2.json"), "utf8")),
  );
  NanasaConfigSchema.parse(parseYaml(readFileSync(join(fixtures, "config-v2.yaml"), "utf8")));
});
