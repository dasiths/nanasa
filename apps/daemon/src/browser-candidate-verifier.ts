import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { canonicalJson } from "@nanasa/contracts";
import type { Browser, BrowserContext, Page } from "playwright";
import { z } from "zod";
import { DomainError } from "./store.js";

const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.includes(":") &&
      value
        .split("/")
        .every((part) => part !== "" && !part.startsWith(".") && part !== "node_modules"),
    "Use an exact checkout-root-relative path without hidden segments or dependencies",
  );
const selectorSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => !value.includes(">>") && !value.includes("\0"),
    "Only CSS selectors are accepted",
  );
const viewportSchema = z
  .object({
    width: z.number().int().min(320).max(1920),
    height: z.number().int().min(240).max(1200),
  })
  .strict();
export const BrowserCandidateVerificationSchema = z
  .object({
    delegationId: z.string().trim().min(1).max(128),
    candidatePath: pathSchema,
    entry: pathSchema.default("index.html"),
    viewports: z
      .array(viewportSchema)
      .min(2)
      .max(4)
      .default([
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ])
      .refine(
        (items) => items.length >= 2 && items[0]!.width > items[1]!.width,
        "First viewport must be wider than the second",
      ),
    actions: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("click"), selector: selectorSchema }).strict(),
          z
            .object({
              type: z.literal("select"),
              selector: selectorSchema,
              value: z.string().max(256),
            })
            .strict(),
          z
            .object({
              type: z.literal("fill"),
              selector: selectorSchema,
              value: z.string().max(256),
            })
            .strict(),
          z
            .object({
              type: z.literal("slider"),
              selector: selectorSchema,
              value: z.number().finite(),
            })
            .strict(),
        ]),
      )
      .max(10)
      .default([]),
  })
  .strict();

type Input = z.infer<typeof BrowserCandidateVerificationSchema>;
type Candidate = {
  checkoutId: string;
  candidatePath: string;
  candidateDigest: string;
  root: string;
};
type PageState = Awaited<ReturnType<typeof pageState>>;
type ActionObservation = Input["actions"][number] & {
  status: "observed" | "failed";
  stateChanged?: boolean;
  after?: PageState;
  reason?: string;
};
type Observation = {
  mode: string;
  viewport: Input["viewports"][number];
  initial: PageState;
  rendered: PageState;
  actions: ActionObservation[];
  pixels: Awaited<ReturnType<typeof pixels>>;
  screenshots: string[];
  pageErrors: string[];
  networkErrors: string[];
};
const maximumBytes = 16 * 1024 * 1024;
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
let running = false;
let artifactRoot: string | undefined;
const retainedArtifacts: string[] = [];

function failure(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new DomainError(code, message, 409, {
    ...details,
    effect: "none",
    retry: "inspect-first",
    nextAction:
      "No review or candidate write was performed. Inspect the scoped candidate and browser capability; report missing verification as a blocker. Never install dependencies or broaden scope through this tool.",
  });
}

function bounded(text: string, bytes = 4096) {
  return Buffer.from(text).subarray(0, bytes).toString("utf8");
}

export function snapshotBrowserCandidate(candidate: Candidate) {
  const files = new Map<string, Buffer>();
  const hash = createHash("sha256");
  let bytes = 0;
  let entries = 0;
  if (realpathSync(candidate.root) !== candidate.root || !lstatSync(candidate.root).isDirectory())
    failure("browser_candidate_path", "Static candidate must be a directory without symlinks");
  const visit = (path: string) => {
    const name = relative(candidate.root, path).split("\\").join("/");
    if (++entries > 1024 || name.split("/").length > 32)
      failure("browser_candidate_limit", "Candidate exceeds snapshot directory limits");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path)
      failure("browser_candidate_path", "Static candidate must not contain symlinks");
    if (stat.isDirectory()) {
      const children = readdirSync(path).sort();
      if (children.length > 512) failure("browser_candidate_limit", "Too many directory entries");
      for (const child of children) {
        if (child.startsWith(".") || child === "node_modules")
          failure(
            "browser_candidate_path",
            "Static candidates must exclude hidden files and dependencies",
          );
        visit(join(path, child));
      }
      return;
    }
    if (
      !stat.isFile() ||
      files.size >= 512 ||
      stat.size > 4 * 1024 * 1024 ||
      bytes + stat.size > maximumBytes
    )
      failure(
        "browser_candidate_limit",
        "Candidate exceeds static file limits (512 files, 4 MiB each, 16 MiB total)",
      );
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let content: Buffer;
    try {
      const current = fstatSync(descriptor);
      if (
        !current.isFile() ||
        current.size !== stat.size ||
        current.ino !== stat.ino ||
        current.dev !== stat.dev
      )
        failure("browser_candidate_changed", "Candidate changed while taking the snapshot");
      content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const count = readSync(descriptor, content, offset, content.length - offset, offset);
        if (count === 0) failure("browser_candidate_changed", "Candidate changed while reading");
        offset += count;
      }
      if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0)
        failure("browser_candidate_changed", "Candidate grew while reading");
    } finally {
      closeSync(descriptor);
    }
    bytes += content.length;
    files.set(name, content);
    hash.update(
      canonicalJson({
        path: `${candidate.candidatePath}/${name}`,
        executable: Boolean(stat.mode & 0o111),
        digest: createHash("sha256").update(content).digest("hex"),
      }),
    );
  };
  visit(candidate.root);
  if (hash.digest("hex") !== candidate.candidateDigest)
    failure("browser_candidate_changed", "Snapshot does not match the authorized candidate digest");
  return files;
}

export async function startBrowserCandidateServer(files: Map<string, Buffer>, entry: string) {
  if (extname(entry) !== ".html" || !files.has(entry))
    failure("browser_candidate_entry", "Entry must name an existing candidate HTML file");
  let requests = 0;
  let servedBytes = 0;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const address = server.address();
      const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      const rawPath = decodeURIComponent((request.url ?? "").split("?")[0]!);
      const name = rawPath.slice(1);
      const content = files.get(name);
      const mime = mimeTypes[extname(name)];
      if (
        request.headers.host !== host ||
        !["GET", "HEAD"].includes(request.method ?? "") ||
        !rawPath.startsWith("/") ||
        !pathSchema.safeParse(name).success ||
        !content ||
        !mime ||
        ++requests > 512 ||
        servedBytes + content.length > 64 * 1024 * 1024
      ) {
        response.writeHead(403).end();
        return;
      }
      servedBytes += content.length;
      response.writeHead(200, { "Content-Type": mime, "Content-Length": content.length });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(403).end();
    }
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.maxConnections = 16;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing static listener");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
    },
  };
}

async function launchBrowser() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir, ".cache", "ms-playwright");
  try {
    const { chromium } = await import("playwright");
    return await chromium.launch({
      headless: true,
      timeout: 8000,
      env: { HOME: userInfo().homedir, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      args: [
        "--disable-background-networking",
        "--no-proxy-server",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const library = message.match(/\b(lib[\w.+-]+\.so(?:\.\d+)*)\b/)?.[1];
    failure("browser_unavailable", "Installed headless Chromium could not launch", {
      reason: library
        ? `Missing host library: ${library}`
        : /executable doesn't exist/i.test(message)
          ? "Matching Playwright headless-shell binary is not installed in the daemon host cache"
          : "Host launch failed or timed out; operator must inspect browser dependencies and sandbox support",
      browser: "playwright chromium headless",
      browserCache: "PLAYWRIGHT_BROWSERS_PATH or OS account home/.cache/ms-playwright",
    });
  }
}

async function pageState(page: Page) {
  const state = await page.evaluate(() => ({
    title: document.title.slice(0, 256),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    controls: Array.from(
      document.querySelectorAll("button,input,select,textarea,a[href],[role=button],[role=slider]"),
    )
      .slice(0, 40)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id.slice(0, 128),
        name: (element.getAttribute("aria-label") ?? element.textContent ?? "")
          .trim()
          .slice(0, 160),
        type: element.getAttribute("type"),
        value: "value" in element ? String(element.value).slice(0, 256) : null,
        pressed: element.getAttribute("aria-pressed"),
        checked: "checked" in element ? Boolean(element.checked) : null,
        disabled: "disabled" in element ? Boolean(element.disabled) : null,
      })),
    graphics: Array.from(document.querySelectorAll("canvas,svg"))
      .slice(0, 4)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id.slice(0, 128),
          x: Math.max(0, bounds.x),
          y: Math.max(0, bounds.y),
          width: Math.max(0, Math.min(innerWidth, bounds.right) - Math.max(0, bounds.x)),
          height: Math.max(0, Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.y)),
        };
      }),
  }));
  return {
    ...state,
    accessibilitySnapshot: bounded(await page.locator("body").ariaSnapshot({ timeout: 2000 })),
  };
}

async function act(page: Page, action: Input["actions"][number]) {
  if (
    (await page.evaluate(
      (selector) => document.querySelectorAll(selector).length,
      action.selector,
    )) !== 1
  )
    throw new Error("CSS selector must match exactly one control");
  const locator = page.locator(`css=${action.selector}`);
  if ((await locator.count()) !== 1) throw new Error("Selector must match exactly one control");
  const kind = await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type"),
    role: element.getAttribute("role"),
  }));
  if (action.type === "click") {
    if (
      !(
        kind.tag === "button" ||
        kind.role === "button" ||
        (kind.tag === "input" && ["button", "checkbox", "radio", "range"].includes(kind.type ?? ""))
      )
    )
      throw new Error("Click is limited to buttons and local input controls");
    await locator.click({ timeout: 1500, noWaitAfter: true });
  } else if (action.type === "select") {
    if (kind.tag !== "select") throw new Error("Select requires a select control");
    await locator.selectOption(action.value, { timeout: 1500 });
  } else if (action.type === "fill") {
    if (
      !(
        kind.tag === "textarea" ||
        (kind.tag === "input" && [null, "text", "number", "search"].includes(kind.type))
      )
    )
      throw new Error("Fill is limited to text, search, number and textarea controls");
    await locator.fill(action.value, { timeout: 1500 });
  } else {
    if (kind.tag !== "input" || kind.type !== "range")
      throw new Error("Slider requires input[type=range]");
    await locator.evaluate((element, value) => {
      const input = element as HTMLInputElement;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, action.value);
  }
}

async function pixels(
  probe: Page,
  first: Buffer,
  second: Buffer,
  graphics: Awaited<ReturnType<typeof pageState>>["graphics"],
) {
  return probe.evaluate(
    async ({ first, second, graphics }) => {
      const decode = async (encoded: string) => {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        image.close();
        return {
          width: canvas.width,
          height: canvas.height,
          data: context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const before = await decode(first);
      const after = await decode(second);
      return [
        { tag: "viewport", id: "", x: 0, y: 0, width: before.width, height: before.height },
        ...graphics,
      ].map((rect) => {
        const colors = new Set<string>();
        let changedSamples = 0;
        let samples = 0;
        if (rect.width > 0 && rect.height > 0) {
          for (let row = 0; row < 32; row++)
            for (let column = 0; column < 32; column++) {
              const x = Math.min(
                before.width - 1,
                Math.floor(rect.x + ((column + 0.5) * rect.width) / 32),
              );
              const y = Math.min(
                before.height - 1,
                Math.floor(rect.y + ((row + 0.5) * rect.height) / 32),
              );
              const offset = (y * before.width + x) * 4;
              const color = before.data.slice(offset, offset + 4).join(",");
              if (colors.size < 64) colors.add(color);
              if (color !== after.data.slice(offset, offset + 4).join(",")) changedSamples++;
              samples++;
            }
        }
        return {
          ...rect,
          samples,
          distinctColorsAtLeast: colors.size,
          nonUniform: colors.size > 1,
          changedSamples,
        };
      });
    },
    { first: first.toString("base64"), second: second.toString("base64"), graphics },
  );
}

export async function verifyBrowserCandidate(
  input: Input,
  authorize: () => Candidate,
  launch: () => Promise<Browser> = launchBrowser,
) {
  const command = BrowserCandidateVerificationSchema.parse(input);
  if (running)
    failure(
      "browser_verifier_busy",
      "One browser verification is already running; retry after it completes",
    );
  running = true;
  let browser: Browser | undefined;
  let server: Awaited<ReturnType<typeof startBrowserCandidateServer>> | undefined;
  let directory: string | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let expired = false;
  let succeeded = false;
  try {
    const before = authorize();
    if (before.candidatePath !== command.candidatePath)
      failure("browser_candidate_path", "Authorized path does not match input");
    const files = snapshotBrowserCandidate(before);
    server = await startBrowserCandidateServer(files, command.entry);
    const origin = server.origin;
    const id = `verification-${randomUUID()}`;
    artifactRoot ??= mkdtempSync(join(tmpdir(), "nanasa-browser-"));
    directory = join(artifactRoot, id);
    mkdirSync(directory, { mode: 0o700 });
    const artifactDirectory = directory;
    const operation = async () => {
      browser = await launch();
      if (expired) {
        await browser.close();
        failure("browser_verification_timeout", "Browser verification timed out");
      }
      let artifactBytes = 0;
      const observations: Observation[] = [];
      let context: BrowserContext | undefined;
      try {
        for (let viewportIndex = 0; viewportIndex < command.viewports.length; viewportIndex++) {
          const viewport = command.viewports[viewportIndex]!;
          context = await browser.newContext({
            viewport,
            deviceScaleFactor: 1,
            acceptDownloads: false,
            serviceWorkers: "block",
            permissions: [],
            storageState: { cookies: [], origins: [] },
          });
          context.setDefaultTimeout(2000);
          context.setDefaultNavigationTimeout(5000);
          const pageErrors: string[] = [];
          const networkErrors: string[] = [];
          const record = (items: string[], message: string) => {
            if (items.length < 16) items.push(bounded(message, 240));
          };
          const resource = (url: string) => {
            try {
              const parsed = new URL(url);
              return parsed.origin === origin ? bounded(parsed.pathname, 160) : parsed.origin;
            } catch {
              return "invalid URL";
            }
          };
          await context.route("**/*", async (route) => {
            const request = route.request();
            if (
              new URL(request.url()).origin !== origin ||
              !["GET", "HEAD"].includes(request.method())
            ) {
              record(networkErrors, `blocked: ${resource(request.url())}`);
              await route.abort("blockedbyclient");
            } else await route.continue();
          });
          await context.routeWebSocket("**/*", (socket) => {
            record(networkErrors, `blocked websocket: ${resource(socket.url())}`);
            socket.close();
          });
          const page = await context.newPage();
          const probe = await context.newPage();
          page.on("framenavigated", (frame) => {
            if (frame !== page.mainFrame()) return;
            const destination = new URL(frame.url());
            if (
              destination.origin !== origin ||
              decodeURIComponent(destination.pathname) !== `/${command.entry}`
            ) {
              record(networkErrors, "blocked navigation away from candidate entry");
              void page.close();
            }
          });
          context.on("page", (popup) => {
            record(networkErrors, "blocked popup");
            void popup.close();
          });
          page.on("dialog", (dialog) => {
            void dialog.dismiss();
          });
          page.on("download", (download) => {
            record(networkErrors, "blocked download");
            void download.cancel();
          });
          page.on("pageerror", (error) => record(pageErrors, error.message));
          page.on("console", (message) => {
            if (message.type() !== "error") return;
            record(pageErrors, message.text());
            if (/content security policy/i.test(message.text()))
              record(networkErrors, `blocked by CSP: ${message.text()}`);
          });
          page.on("requestfailed", (request) =>
            record(networkErrors, `failed: ${resource(request.url())}`),
          );
          page.on("response", (response) => {
            if (response.status() >= 400)
              record(networkErrors, `${response.status()}: ${resource(response.url())}`);
          });
          await page.goto(`${origin}/${command.entry}`, { waitUntil: "load" });
          const observe = async (
            mode: string,
            size: Input["viewports"][number],
            performActions: boolean,
          ) => {
            await page.waitForTimeout(150);
            const initial = await pageState(page);
            const actionResults: ActionObservation[] = [];
            if (performActions)
              for (const action of command.actions) {
                const prior = await pageState(page);
                try {
                  await act(page, action);
                  await page.waitForTimeout(100);
                  const after = await pageState(page);
                  actionResults.push({
                    ...action,
                    status: "observed",
                    stateChanged: JSON.stringify(prior) !== JSON.stringify(after),
                    after,
                  });
                } catch {
                  actionResults.push({
                    ...action,
                    status: "failed",
                    reason: "Control missing, ambiguous, unsupported, detached or timed out",
                  });
                }
              }
            const rendered = await pageState(page);
            const first = await page.screenshot({ type: "png", timeout: 2000 });
            await page.waitForTimeout(150);
            const second = await page.screenshot({ type: "png", timeout: 2000 });
            artifactBytes += first.length + second.length;
            if (
              first.length > 4 * 1024 * 1024 ||
              second.length > 4 * 1024 * 1024 ||
              artifactBytes > maximumBytes
            )
              failure(
                "browser_artifact_limit",
                "Screenshot artifacts exceed 16 MiB per verification",
              );
            const references = [
              `${basename(artifactRoot!)}/${id}/${mode}-first.png`,
              `${basename(artifactRoot!)}/${id}/${mode}-second.png`,
            ];
            writeFileSync(join(artifactDirectory, `${mode}-first.png`), first, {
              mode: 0o600,
              flag: "wx",
            });
            writeFileSync(join(artifactDirectory, `${mode}-second.png`), second, {
              mode: 0o600,
              flag: "wx",
            });
            observations.push({
              mode,
              viewport: size,
              initial,
              rendered,
              actions: actionResults,
              pixels: await pixels(probe, first, second, rendered.graphics),
              screenshots: references,
              pageErrors: [...pageErrors],
              networkErrors: [...networkErrors],
            });
          };
          await observe(`fresh-${viewportIndex}`, viewport, true);
          if (viewportIndex === 0) {
            pageErrors.length = 0;
            networkErrors.length = 0;
            await page.setViewportSize(command.viewports[1]!);
            await observe("desktop-to-mobile", command.viewports[1]!, false);
          }
          await context.close();
          context = undefined;
        }
      } finally {
        await context?.close();
      }
      const after = authorize();
      if (
        before.checkoutId !== after.checkoutId ||
        before.root !== after.root ||
        before.candidatePath !== after.candidatePath ||
        before.candidateDigest !== after.candidateDigest
      )
        failure(
          "browser_candidate_changed",
          "Candidate or assignment changed during verification; evidence is invalid",
          { beforeDigest: before.candidateDigest, afterDigest: after.candidateDigest },
        );
      const result = {
        status: "observed",
        browser: "playwright chromium headless",
        delegationId: command.delegationId,
        candidatePath: command.candidatePath,
        entry: command.entry,
        beforeDigest: before.candidateDigest,
        afterDigest: after.candidateDigest,
        unchanged: true,
        observations,
        limitations:
          "Observations only, not approval. Pixel variation does not prove correct rendering or motion; compare source, snapshots and controls against the requested outcome. Each snapshot is capped at 4096 UTF-8 bytes, controls at 40, graphics at four, page/network errors at 16 each. External assets, frames, workers, downloads and non-static applications are unsupported. Screenshots are private OS-temporary-directory-relative references, retained for at most one hour or four successful runs per daemon process.",
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
        failure(
          "browser_evidence_limit",
          "Evidence exceeds 128 KiB; request fewer actions or viewports",
        );
      return result;
    };
    const result = await Promise.race([
      operation(),
      new Promise<never>((_accept, reject) => {
        timeout = setTimeout(() => {
          expired = true;
          void browser?.close();
          reject(
            new DomainError(
              "browser_verification_timeout",
              "Browser verification exceeded 45 seconds",
              409,
              { effect: "none" },
            ),
          );
        }, 45_000);
      }),
    ]);
    retainedArtifacts.push(directory);
    while (retainedArtifacts.length > 4)
      rmSync(retainedArtifacts.shift()!, { recursive: true, force: true });
    const retained = directory;
    setTimeout(() => {
      rmSync(retained, { recursive: true, force: true });
      const index = retainedArtifacts.indexOf(retained);
      if (index >= 0) retainedArtifacts.splice(index, 1);
    }, 3_600_000).unref();
    succeeded = true;
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        if (!succeeded && directory) rmSync(directory, { recursive: true, force: true });
        running = false;
      }
    }
  }
}
