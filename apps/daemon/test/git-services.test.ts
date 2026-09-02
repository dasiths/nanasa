import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutService } from "../src/git/checkout-service.js";
import { GitCommandAdapter } from "../src/git/git-command-adapter.js";
import { GitStatusService } from "../src/git/git-status-service.js";
import { RepositoryDiscoveryService } from "../src/git/repository-discovery-service.js";
import { NanasaStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `nanasa-${name}-`));
  directories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initialize(path: string, refFormat?: "reftable"): void {
  execFileSync("git", [
    "init",
    "--quiet",
    ...(refFormat === undefined ? [] : [`--ref-format=${refFormat}`]),
    path,
  ]);
  git(
    path,
    "-c",
    "user.name=Nanasa Test",
    "-c",
    "user.email=nanasa@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
}

function services() {
  const adapter = new GitCommandAdapter();
  const discovery = new RepositoryDiscoveryService(adapter);
  const statuses = new GitStatusService(adapter);
  const store = new NanasaStore(":memory:");
  return {
    adapter,
    discovery,
    statuses,
    store,
    checkouts: new CheckoutService(store, discovery, statuses),
  };
}

describe("Git repository and checkout identity", () => {
  it("distinguishes a common repository from normal and linked checkout identities", async () => {
    const parent = temporaryDirectory("linked-layout");
    const primary = join(parent, "primary");
    const linked = join(parent, "linked");
    initialize(primary);
    git(primary, "worktree", "add", "-b", "feature/linked", linked, "HEAD");
    const { discovery, store } = services();
    try {
      const main = await discovery.discover(primary);
      const child = await discovery.discover(linked);
      expect(child.repository.id).toBe(main.repository.id);
      expect(child.repository.commonDirectory).toBe(main.repository.commonDirectory);
      expect(child.checkout.id).not.toBe(main.checkout.id);
      expect(main.checkout.kind).toBe("primary");
      expect(child.checkout.kind).toBe("linked");
    } finally {
      store.close();
    }
  });

  it("supports bare, packed-ref, and reftable repository layouts", async () => {
    const parent = temporaryDirectory("git-layouts");
    const standard = join(parent, "standard");
    initialize(standard);
    git(standard, "branch", "packed-branch");
    git(standard, "pack-refs", "--all", "--prune");
    const bare = join(parent, "bare.git");
    execFileSync("git", ["clone", "--quiet", "--bare", standard, bare]);
    const reftable = join(parent, "reftable");
    initialize(reftable, "reftable");
    const { discovery, store } = services();
    try {
      await expect(discovery.discover(standard)).resolves.toMatchObject({
        repository: { refStorage: "files" },
        checkout: { kind: "primary" },
      });
      await expect(discovery.discover(bare)).resolves.toMatchObject({ checkout: { kind: "bare" } });
      await expect(discovery.discover(reftable)).resolves.toMatchObject({
        repository: { refStorage: "reftable" },
      });
    } finally {
      store.close();
    }
  });

  it("persists machine-local checkout paths and reports structured dirty status", async () => {
    const repository = temporaryDirectory("git-status");
    initialize(repository);
    writeFileSync(join(repository, "staged.txt"), "staged\n");
    git(repository, "add", "staged.txt");
    writeFileSync(join(repository, "untracked.txt"), "untracked\n");
    const { checkouts, statuses, store } = services();
    try {
      const initialized = await checkouts.initialize(repository);
      const status = await statuses.inspect(initialized.checkout);
      expect(status).toMatchObject({ staged: 1, modified: 0, untracked: 1, detached: false });
      expect(store.listRepositories()).toHaveLength(1);
      expect(store.listCheckouts()).toEqual([
        expect.objectContaining({ id: initialized.checkout.id, path: repository, dirty: true }),
      ]);
    } finally {
      store.close();
    }
  });

  it("passes metacharacters as argv without invoking a shell", async () => {
    const repository = temporaryDirectory("argv");
    initialize(repository);
    const sentinel = join(repository, "shell-was-used");
    const { adapter, store } = services();
    try {
      const argument = `HEAD;touch ${sentinel}`;
      await adapter.run(["-C", repository, "rev-parse", argument], {
        allowFailure: true,
      });
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      store.close();
    }
  });
});
