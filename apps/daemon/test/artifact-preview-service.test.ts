import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactPreviewService } from "../src/terminal/artifact-preview-service.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe("ArtifactPreviewService", () => {
  it("allows bounded repository text and rejects traversal and forged image extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "nanasa-preview-"));
    directories.push(root);
    writeFileSync(join(root, "output.txt"), "preview");
    writeFileSync(join(root, "forged.png"), "not png");
    const service = new ArtifactPreviewService(root);
    expect(service.inspect("output.txt")).toMatchObject({ mediaType: "text/plain", byteCount: 7 });
    expect(() => service.inspect("../outside.txt")).toThrow(/escaped/i);
    expect(() => service.inspect("forged.png")).toThrow(/signature/i);
  });
});
