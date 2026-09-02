import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CreateWorktreeCommand,
  OpenCheckoutCommand,
  Worktree,
  WorktreeOperationResult,
} from "@nanasa/contracts";
import { DomainError, type NanasaStore } from "../store.js";
import { CheckoutService } from "./checkout-service.js";
import { GitCommandAdapter, GitCommandError } from "./git-command-adapter.js";

interface ListedWorktree {
  path: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export function safeWorktreeSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length === 0 ? "worktree" : slug;
}

function parseWorktreeList(output: string): ListedWorktree[] {
  const records: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current !== undefined) records.push(current);
      current = {
        path: field.slice("worktree ".length),
        bare: false,
        detached: false,
        prunable: false,
      };
    } else if (current !== undefined && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    } else if (current !== undefined && field === "bare") {
      current.bare = true;
    } else if (current !== undefined && field === "detached") {
      current.detached = true;
    } else if (current !== undefined && field.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current !== undefined) records.push(current);
  return records;
}

export class WorktreeService {
  #pending: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly store: NanasaStore,
    private readonly git: GitCommandAdapter,
    private readonly checkouts: CheckoutService,
    private readonly worktreeRoot: string,
  ) {}

  public list(repositoryId: string): Worktree[] {
    return this.store.listWorktrees(repositoryId);
  }

  public create(command: CreateWorktreeCommand): Promise<WorktreeOperationResult> {
    return this.#serialize(() => this.#create(command));
  }

  public open(command: OpenCheckoutCommand): Promise<WorktreeOperationResult> {
    return this.#serialize(async () => {
      const source = this.store.getCheckout(command.sourceCheckoutId);
      const listed = await this.#list(source.path);
      const matches = listed.filter((candidate) =>
        command.path === undefined
          ? candidate.branch === command.branch && !candidate.detached
          : this.#samePath(candidate.path, command.path),
      );
      if (matches.length !== 1) {
        throw new DomainError(
          matches.length === 0 ? "worktree_not_found" : "ambiguous_worktree_branch",
          matches.length === 0
            ? "No matching worktree was found"
            : "More than one worktree matched",
          matches.length === 0 ? 404 : 409,
        );
      }
      const match = matches[0]!;
      if (match.bare || match.prunable) {
        throw new DomainError(
          "worktree_not_openable",
          "Bare or prunable worktrees cannot be opened as agent checkouts",
          409,
        );
      }
      const operation = this.store.beginGitOperation({
        repositoryId: source.repositoryId,
        checkoutId: source.id,
        kind: "inspect",
        targetPath: match.path,
      });
      try {
        const checkout = await this.checkouts.discover(match.path);
        if (checkout.repositoryId !== source.repositoryId) {
          throw new DomainError(
            "worktree_repository_mismatch",
            "Worktree belongs to another repository",
            409,
          );
        }
        const completed = this.store.completeGitOperation(operation.id, "succeeded");
        return {
          operation: completed,
          checkout,
          worktree: this.store
            .listWorktrees(source.repositoryId)
            .find((item) => item.checkoutId === checkout.id),
        };
      } catch (error) {
        this.#fail(operation.id, error);
        throw error;
      }
    });
  }

  public remove(
    worktreeId: string,
    options: { force: boolean; expectedOperationGeneration: number },
  ): Promise<WorktreeOperationResult> {
    return this.#serialize(() => this.#remove(worktreeId, options));
  }

  public recover(): Promise<void> {
    return this.#serialize(async () => {
      for (const operation of this.store.listRecoverableGitOperations()) {
        const intent = this.store.getGitOperationRequest(operation.id);
        if (operation.kind === "create-worktree" && operation.targetPath !== undefined) {
          try {
            if (!existsSync(operation.targetPath)) throw new Error("worktree_create_interrupted");
            const checkout = await this.checkouts.discover(operation.targetPath);
            if (checkout.repositoryId !== operation.repositoryId)
              throw new Error("worktree_identity_changed");
            const now = new Date().toISOString();
            this.store.saveWorktree({
              id: String(intent.worktreeId),
              repositoryId: operation.repositoryId,
              checkoutId: checkout.id,
              sourceCheckoutId: String(intent.sourceCheckoutId),
              path: checkout.path,
              branch: String(intent.branch),
              base: String(intent.base),
              provenanceToken: String(intent.provenanceToken),
              operationGeneration: operation.generation,
              state: "ready",
              createdAt: String(intent.createdAt),
              updatedAt: now,
            });
            this.store.completeGitOperation(operation.id, "succeeded");
          } catch (error) {
            this.#fail(operation.id, error);
          }
        } else if (operation.kind === "remove-worktree" && operation.worktreeId !== undefined) {
          const worktree = this.store.getWorktree(operation.worktreeId);
          const removed = !existsSync(worktree.path);
          this.store.saveWorktree({
            ...worktree,
            state: removed ? "removed" : "ready",
            updatedAt: new Date().toISOString(),
          });
          this.store.completeGitOperation(
            operation.id,
            removed ? "succeeded" : "failed",
            removed ? undefined : "worktree_remove_interrupted",
          );
        } else {
          this.store.completeGitOperation(operation.id, "failed", "git_operation_interrupted");
        }
      }
    });
  }

  async #create(command: CreateWorktreeCommand): Promise<WorktreeOperationResult> {
    const source = this.store.getCheckout(command.sourceCheckoutId);
    if (source.kind === "bare") {
      throw new DomainError(
        "bare_worktree_source",
        "A bare repository cannot be the worktree source",
        409,
      );
    }
    const branchCheck = await this.git.run(
      ["-C", source.path, "check-ref-format", "--branch", command.branch],
      { allowFailure: true },
    );
    if (branchCheck.exitCode !== 0) {
      throw new DomainError("invalid_worktree_branch", "Worktree branch name is invalid", 400);
    }
    const baseCheck = await this.git.run(
      ["-C", source.path, "rev-parse", "--verify", `${command.base}^{commit}`],
      { allowFailure: true },
    );
    if (baseCheck.exitCode !== 0) {
      throw new DomainError(
        "invalid_worktree_base",
        "Worktree base does not resolve to a commit",
        400,
      );
    }
    const listed = await this.#list(source.path);
    const existing = listed.find(
      (candidate) => candidate.branch === command.branch && !candidate.prunable,
    );
    if (existing !== undefined) {
      const checkout = await this.checkouts.discover(existing.path);
      const operation = this.store.beginGitOperation({
        repositoryId: source.repositoryId,
        checkoutId: source.id,
        kind: "inspect",
        targetPath: checkout.path,
      });
      return {
        operation: this.store.completeGitOperation(operation.id, "succeeded"),
        checkout,
        worktree: this.store
          .listWorktrees(source.repositoryId)
          .find((item) => item.checkoutId === checkout.id),
      };
    }
    const repository = this.store.getRepository(source.repositoryId);
    const targetPath = join(
      this.worktreeRoot,
      safeWorktreeSlug(repository.displayName),
      safeWorktreeSlug(command.branch),
    );
    if (existsSync(targetPath)) {
      throw new DomainError(
        "worktree_path_exists",
        "The managed worktree path already exists",
        409,
      );
    }
    const worktreeId = `worktree_${randomUUID()}`;
    const provenanceToken = createHash("sha256")
      .update(`${worktreeId}:${source.id}:${targetPath}:${randomUUID()}`)
      .digest("hex");
    const createdAt = new Date().toISOString();
    const operation = this.store.beginGitOperation({
      repositoryId: source.repositoryId,
      checkoutId: source.id,
      worktreeId,
      kind: "create-worktree",
      targetPath,
      request: {
        worktreeId,
        sourceCheckoutId: source.id,
        branch: command.branch,
        base: command.base,
        provenanceToken,
        createdAt,
      },
    });
    let gitAdded = false;
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      const localBranch = await this.git.run(
        ["-C", source.path, "show-ref", "--verify", "--quiet", `refs/heads/${command.branch}`],
        { allowFailure: true },
      );
      const addArguments =
        localBranch.exitCode === 0
          ? ["-C", source.path, "worktree", "add", targetPath, command.branch]
          : ["-C", source.path, "worktree", "add", "-b", command.branch, targetPath, command.base];
      await this.git.run(addArguments);
      gitAdded = true;
      const checkout = await this.checkouts.discover(targetPath);
      if (
        checkout.repositoryId !== source.repositoryId ||
        checkout.path !== realpathSync(targetPath)
      ) {
        throw new DomainError(
          "worktree_identity_changed",
          "Created worktree identity does not match",
          409,
        );
      }
      const now = new Date().toISOString();
      const worktree = this.store.saveWorktree({
        id: worktreeId,
        repositoryId: source.repositoryId,
        checkoutId: checkout.id,
        sourceCheckoutId: source.id,
        path: checkout.path,
        branch: command.branch,
        base: command.base,
        provenanceToken,
        operationGeneration: operation.generation,
        state: "ready",
        createdAt,
        updatedAt: now,
      });
      const completed = this.store.completeGitOperation(operation.id, "succeeded");
      this.store.recordRuntimeEvent("worktree.created", "worktree", worktree.id, {
        worktreeId: worktree.id,
        checkoutId: checkout.id,
        operationGeneration: operation.generation,
      });
      return { operation: completed, checkout, worktree };
    } catch (error) {
      if (!gitAdded) this.#fail(operation.id, error);
      throw error;
    }
  }

  async #remove(
    worktreeId: string,
    options: { force: boolean; expectedOperationGeneration: number },
  ): Promise<WorktreeOperationResult> {
    const worktree = this.store.getWorktree(worktreeId);
    if (
      worktree.state !== "ready" ||
      worktree.operationGeneration !== options.expectedOperationGeneration
    ) {
      throw new DomainError(
        "worktree_operation_stale",
        "Worktree operation generation is stale",
        409,
      );
    }
    if (this.store.listRunsBoundToCheckout(worktree.checkoutId).length > 0) {
      throw new DomainError(
        "worktree_has_active_runs",
        "Stop every run bound to this worktree first",
        409,
      );
    }
    if (this.store.listMembershipsBoundToCheckout(worktree.checkoutId).length > 0) {
      throw new DomainError(
        "worktree_has_assignments",
        "Reassign every agent from this worktree before removal",
        409,
      );
    }
    const checkout = this.store.getCheckout(worktree.checkoutId);
    const discovered = await this.checkouts.discover(worktree.path);
    if (
      discovered.id !== checkout.id ||
      discovered.repositoryId !== worktree.repositoryId ||
      discovered.path !== worktree.path ||
      discovered.gitDirectory !== checkout.gitDirectory
    ) {
      throw new DomainError(
        "worktree_final_identity_mismatch",
        "Worktree identity changed before removal",
        409,
      );
    }
    const operation = this.store.beginGitOperation({
      repositoryId: worktree.repositoryId,
      checkoutId: worktree.checkoutId,
      worktreeId: worktree.id,
      kind: "remove-worktree",
      targetPath: worktree.path,
      request: { provenanceToken: worktree.provenanceToken },
    });
    this.store.saveWorktree({
      ...worktree,
      state: "removing",
      operationGeneration: operation.generation,
      updatedAt: new Date().toISOString(),
    });
    const source = this.store.getCheckout(worktree.sourceCheckoutId);
    try {
      const result = await this.git.run(
        [
          "-C",
          source.path,
          "worktree",
          "remove",
          ...(options.force ? ["--force"] : []),
          worktree.path,
        ],
        { allowFailure: true },
      );
      if (result.exitCode !== 0) {
        if (
          !options.force &&
          /modified or untracked files|contains modified|use --force/i.test(result.stderr)
        ) {
          throw new DomainError(
            "dirty_worktree_requires_force",
            "The worktree is dirty; confirm force removal to continue",
            409,
          );
        }
        if (!(options.force && (await this.#removeVerifiedLeftover(source.path, worktree)))) {
          throw new GitCommandError("git_worktree_remove_failed", result);
        }
      }
      const removed = this.store.saveWorktree({
        ...worktree,
        state: "removed",
        operationGeneration: operation.generation,
        updatedAt: new Date().toISOString(),
      });
      const completed = this.store.completeGitOperation(operation.id, "succeeded");
      this.store.recordRuntimeEvent("worktree.removed", "worktree", worktree.id, {
        worktreeId: worktree.id,
        checkoutId: worktree.checkoutId,
        branchPreserved: true,
      });
      return { operation: completed, checkout, worktree: removed };
    } catch (error) {
      this.store.saveWorktree({
        ...worktree,
        state: "ready",
        updatedAt: new Date().toISOString(),
      });
      this.#fail(operation.id, error);
      throw error;
    }
  }

  async #removeVerifiedLeftover(sourcePath: string, worktree: Worktree): Promise<boolean> {
    if (!existsSync(worktree.path)) return true;
    if (
      (await this.#list(sourcePath)).some((candidate) =>
        this.#samePath(candidate.path, worktree.path),
      )
    ) {
      return false;
    }
    const marker = join(worktree.path, ".git");
    if (!existsSync(marker) || !statSync(marker).isFile()) return false;
    const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(marker, "utf8"));
    if (match === null) return false;
    const pointer = realpathSync(resolve(worktree.path, match[1]!));
    const repository = this.store.getRepository(worktree.repositoryId);
    const administrationRoot = realpathSync(join(repository.commonDirectory, "worktrees"));
    const pointerRelative = relative(administrationRoot, pointer);
    if (
      pointerRelative === ".." ||
      pointerRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(pointerRelative)
    ) {
      return false;
    }
    rmSync(worktree.path, { recursive: true, force: false });
    return true;
  }

  async #list(sourcePath: string): Promise<ListedWorktree[]> {
    const result = await this.git.run(["-C", sourcePath, "worktree", "list", "--porcelain", "-z"]);
    return parseWorktreeList(result.stdout);
  }

  #samePath(left: string, right: string): boolean {
    try {
      return realpathSync(left) === realpathSync(right);
    } catch {
      return resolve(left) === resolve(right);
    }
  }

  #fail(operationId: string, error: unknown): void {
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof GitCommandError
          ? error.code
          : error instanceof Error
            ? error.message.slice(0, 100)
            : "git_operation_failed";
    try {
      this.store.completeGitOperation(operationId, "failed", code);
    } catch {
      // The original operation result remains authoritative.
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation, operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }
}
