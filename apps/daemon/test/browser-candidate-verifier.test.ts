import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { get, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@nanasa/contracts";
import type { Browser, BrowserContext } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserCandidateVerificationSchema,
  snapshotBrowserCandidate,
  startBrowserCandidateServer,
  verifyBrowserCandidate,
} from "../src/browser-candidate-verifier.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function digestHtml(html: string) {
  return createHash("sha256")
    .update(
      canonicalJson({
        path: "src/index.html",
        executable: false,
        digest: createHash("sha256").update(html).digest("hex"),
      }),
    )
    .digest("hex");
}
function fixture(html = "<h1>Candidate</h1>") {
  const parent = mkdtempSync(join(tmpdir(), "nanasa-browser-test-"));
  roots.push(parent);
  const root = join(parent, "src");
  mkdirSync(root);
  writeFileSync(join(root, "index.html"), html);
  const candidateDigest = digestHtml(html);
  return { root, checkoutId: "checkout", candidatePath: "src", candidateDigest };
}
const command = () =>
  BrowserCandidateVerificationSchema.parse({ delegationId: "delegation", candidatePath: "src" });

describe("static browser verifier", () => {
  it("bounds exact action shapes, paths and viewports", () => {
    for (const input of [
      { candidatePath: "../outside" },
      { candidatePath: "/absolute" },
      { candidatePath: "src/.env" },
      { actions: [{ type: "evaluate", code: "anything" }] },
      { actions: [{ type: "click", selector: "button", code: "anything" }] },
      { actions: [{ type: "click", selector: "button >> text=not-css" }] },
      { actions: Array.from({ length: 11 }, () => ({ type: "click", selector: "button" })) },
      { viewports: [{ width: 10000, height: 900 }] },
      { entry: "../outside.html" },
    ])
      expect(BrowserCandidateVerificationSchema.safeParse({ ...command(), ...input }).success).toBe(
        false,
      );
  });
  it("rejects changed, hidden and symlinked snapshots", () => {
    const candidate = fixture();
    expect(snapshotBrowserCandidate(candidate).get("index.html")?.toString()).toBe(
      "<h1>Candidate</h1>",
    );
    writeFileSync(join(candidate.root, "index.html"), "Changed");
    expect(() => snapshotBrowserCandidate(candidate)).toThrow(/digest/);
    symlinkSync(join(candidate.root, "index.html"), join(candidate.root, "alias.html"));
    expect(() => snapshotBrowserCandidate(candidate)).toThrow(/symlinks/);
    rmSync(join(candidate.root, "alias.html"));
    writeFileSync(join(candidate.root, ".env"), "secret");
    expect(() => snapshotBrowserCandidate(candidate)).toThrow(/hidden/);
  });
  it("serves only bounded snapshot assets and closes its listener", async () => {
    const candidate = fixture();
    const server = await startBrowserCandidateServer(
      snapshotBrowserCandidate(candidate),
      "index.html",
    );
    try {
      expect(await (await fetch(`${server.origin}/index.html`)).text()).toBe("<h1>Candidate</h1>");
      for (const path of ["/.env", "/%2e%2e/secret", "/server.ts", "/src\\outside", "/%00"])
        expect((await fetch(`${server.origin}${path}`)).status).toBe(403);
      expect((await fetch(`${server.origin}/index.html`, { method: "POST" })).status).toBe(403);
      expect(
        await new Promise((accept, reject) => {
          get(
            `${server.origin}/index.html`,
            { headers: { host: "attacker.invalid" } },
            (response) => {
              response.resume();
              accept(response.statusCode);
            },
          ).on("error", reject);
        }),
      ).toBe(403);
      writeFileSync(join(candidate.root, "index.html"), "Changed after snapshot");
      expect(await (await fetch(`${server.origin}/index.html`)).text()).toBe("<h1>Candidate</h1>");
    } finally {
      await server.close();
    }
    await expect(fetch(`${server.origin}/index.html`)).rejects.toThrow();
  });
  it("does not launch when authorization fails and recovers after unavailable browser", async () => {
    const close = vi.spyOn(Server.prototype, "close");
    let launched = false;
    const launch = async (): Promise<never> => {
      launched = true;
      throw new Error("Browser unavailable");
    };
    await expect(
      verifyBrowserCandidate(
        command(),
        () => {
          throw new Error("Forbidden");
        },
        launch,
      ),
    ).rejects.toThrow("Forbidden");
    expect(launched).toBe(false);
    const candidate = fixture();
    await expect(verifyBrowserCandidate(command(), () => candidate, launch)).rejects.toThrow(
      "Browser unavailable",
    );
    await expect(verifyBrowserCandidate(command(), () => candidate, launch)).rejects.toThrow(
      "Browser unavailable",
    );
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.instances.every((server) => !server.listening)).toBe(true);
  });
  it("bounds concurrent execution and closes the listener on deadline", async () => {
    const originalTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler, delay, ...args) =>
      originalTimeout(handler, delay === 45_000 ? 25 : delay, ...args)) as typeof setTimeout);
    const close = vi.spyOn(Server.prototype, "close");
    const browser = {
      newContext: () => new Promise<BrowserContext>(() => {}),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const candidate = fixture();
    const pending = verifyBrowserCandidate(
      command(),
      () => candidate,
      async () => browser,
    );
    const deadline = expect(pending).rejects.toMatchObject({
      code: "browser_verification_timeout",
    });
    await expect(verifyBrowserCandidate(command(), () => candidate)).rejects.toMatchObject({
      code: "browser_verifier_busy",
    });
    await deadline;
    expect(browser.close).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.instances[0]!.listening).toBe(false);
    await expect(
      verifyBrowserCandidate(command(), () => {
        throw new Error("New scope checked");
      }),
    ).rejects.toThrow("New scope checked");
  });

  it("returns concrete missing-library or binary failures without private diagnostics or installs", async () => {
    const { chromium } = await import("playwright");
    const launch = vi.spyOn(chromium, "launch");
    const close = vi.spyOn(Server.prototype, "close");
    const candidate = fixture();
    for (const [message, reason] of [
      [
        "/private/provider/home/headless: error while loading shared libraries: libcups.so.2",
        "Missing host library: libcups.so.2",
      ],
      [
        "Executable doesn't exist at /private/provider/home/cache",
        "Matching Playwright headless-shell binary is not installed in the daemon host cache",
      ],
    ]) {
      launch.mockRejectedValueOnce(new Error(message));
      await expect(verifyBrowserCandidate(command(), () => candidate)).rejects.toMatchObject({
        code: "browser_unavailable",
        details: expect.objectContaining({ reason, effect: "none" }),
      });
    }
    expect(launch.mock.calls[0]![0]).toMatchObject({ headless: true, timeout: 8000 });
    expect(Object.keys(launch.mock.calls[0]![0]!.env!)).toEqual(["HOME", "PATH", "LANG"]);
    expect(close.mock.instances.every((server) => !server.listening)).toBe(true);
  });
  it.runIf(process.env.NANASA_REAL_BROWSER === "1")(
    "observes real static rendering, interactions, resize, blocked network and changed candidate",
    async () => {
      const close = vi.spyOn(Server.prototype, "close");
      const candidate = fixture(
        `<!doctype html><html><head><title>Scoped fixture</title><style>body{margin:0}svg{width:200px;height:100px} @media(max-width:500px){main{width:900px}}</style></head><body><main><h1>Scoped fixture</h1><button aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');this.textContent='Paused'">Pause</button><input id="speed" type="range"><select><option value="one">One</option><option value="two">Two</option></select><input id="label"><svg viewBox="0 0 200 100"><rect width="100" height="100" fill="red"/><circle cx="140" cy="50" r="30" fill="green"/></svg></main><canvas width="200" height="100"></canvas><script>const context=document.querySelector('canvas').getContext('2d');function frame(time){context.fillStyle='white';context.fillRect(0,0,200,100);context.fillStyle='blue';context.fillRect((time/4)%150,0,50,100);requestAnimationFrame(frame)}requestAnimationFrame(frame);fetch('https://example.invalid/no-access');</script></body></html>`,
      );
      const input = BrowserCandidateVerificationSchema.parse({
        ...command(),
        actions: [
          { type: "click", selector: "button" },
          { type: "slider", selector: "#speed", value: 70 },
          { type: "select", selector: "select", value: "two" },
          { type: "fill", selector: "#label", value: "Earth" },
        ],
      });
      const result = await verifyBrowserCandidate(input, () => candidate);
      expect(result.unchanged).toBe(true);
      expect(result.beforeDigest).toBe(result.afterDigest);
      expect(result.observations).toHaveLength(3);
      expect(result.observations.map((item) => item.rendered.horizontalOverflow)).toEqual([
        false,
        true,
        true,
      ]);
      expect(result.observations[0]!.actions.every((action) => action.status === "observed")).toBe(
        true,
      );
      expect(result.observations[0]!.pixels.find((pixel) => pixel.tag === "svg")?.nonUniform).toBe(
        true,
      );
      expect(result.observations[0]!.pixels.find((pixel) => pixel.tag === "canvas")).toMatchObject({
        nonUniform: true,
        changedSamples: expect.any(Number),
      });
      expect(
        result.observations[0]!.pixels.find((pixel) => pixel.tag === "canvas")!.changedSamples,
      ).toBeGreaterThan(0);
      expect(result.observations[0]!.networkErrors.join(" ")).toContain("example.invalid");
      expect(result.observations[2]!.initial.controls[0]!.pressed).toBe("false");
      expect(JSON.stringify(result)).not.toContain(candidate.root);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
      for (const reference of result.observations.flatMap((item) => item.screenshots)) {
        const artifact = join(tmpdir(), reference);
        expect(existsSync(artifact)).toBe(true);
        expect(statSync(artifact).mode & 0o777).toBe(0o600);
        expect(artifact.startsWith(candidate.root)).toBe(false);
      }
      const artifactDirectory = join(tmpdir(), result.observations[0]!.screenshots[0]!, "..");
      roots.push(artifactDirectory);
      let checks = 0;
      await expect(
        verifyBrowserCandidate(command(), () => {
          if (++checks === 1) return candidate;
          const changed = "<h1>Changed during verification</h1>";
          writeFileSync(join(candidate.root, "index.html"), changed);
          return { ...candidate, candidateDigest: digestHtml(changed) };
        }),
      ).rejects.toMatchObject({ code: "browser_candidate_changed" });
      expect(close.mock.instances.every((server) => !server.listening)).toBe(true);
    },
    60_000,
  );
});
