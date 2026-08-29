import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Checkout, Repository } from "@nanasa/contracts";
import { GitCommandAdapter } from "./git-command-adapter.js";

export interface DiscoveredRepository {
  readonly repository: Repository;
  readonly checkout: Checkout;
}

function identifier(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function canonical(path: string, cwd: string): string {
  return realpathSync(resolve(cwd, path.trim()));
}

export class RepositoryDiscoveryService {
  public constructor(private readonly git: GitCommandAdapter) {}

  public async discover(startPath: string): Promise<DiscoveredRepository> {
    const bareResult = await this.git.run(["-C", startPath, "rev-parse", "--is-bare-repository"]);
    const bare = bareResult.stdout.trim() === "true";
    const gitDirectory = canonical(
      (await this.git.run(["-C", startPath, "rev-parse", "--absolute-git-dir"])).stdout,
      startPath,
    );
    const commonDirectory = canonical(
      (await this.git.run(["-C", startPath, "rev-parse", "--git-common-dir"])).stdout,
      startPath,
    );
    const checkoutPath = bare
      ? commonDirectory
      : canonical(
          (await this.git.run(["-C", startPath, "rev-parse", "--show-toplevel"])).stdout,
          startPath,
        );
    const objectFormatResult = await this.git.run(
      ["-C", startPath, "rev-parse", "--show-object-format"],
      { allowFailure: true },
    );
    const objectFormat = objectFormatResult.stdout.trim() === "sha256" ? "sha256" : "sha1";
    const refFormatResult = await this.git.run(
      ["-C", startPath, "rev-parse", "--show-ref-format"],
      { allowFailure: true },
    );
    const configuredRefStorage = await this.git.run(
      ["-C", startPath, "config", "--get", "extensions.refStorage"],
      { allowFailure: true },
    );
    const refStorage =
      refFormatResult.stdout.trim() === "reftable" ||
      configuredRefStorage.stdout.trim().toLowerCase() === "reftable"
        ? "reftable"
        : "files";
    const branchResult = await this.git.run(
      ["-C", startPath, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowFailure: true },
    );
    const headResult = await this.git.run(["-C", startPath, "rev-parse", "--verify", "HEAD"], {
      allowFailure: true,
    });
    const dirtyResult = bare
      ? { stdout: "" }
      : await this.git.run(
          ["-C", startPath, "status", "--porcelain=v1", "--untracked-files=normal"],
          { allowFailure: true },
        );
    const now = new Date().toISOString();
    const repositoryId = identifier("repo", commonDirectory);
    const checkoutKey = createHash("sha256").update(checkoutPath).digest("hex");
    const checkoutId = identifier("checkout", `${repositoryId}:${checkoutKey}`);
    const repositoryContainer =
      basename(commonDirectory) === ".git" ? dirname(commonDirectory) : commonDirectory;
    const repository: Repository = {
      id: repositoryId,
      commonDirectory,
      displayName: basename(repositoryContainer),
      objectFormat,
      refStorage,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const checkout: Checkout = {
      id: checkoutId,
      repositoryId,
      checkoutKey,
      path: checkoutPath,
      gitDirectory,
      kind: bare ? "bare" : gitDirectory === commonDirectory ? "primary" : "linked",
      ...(headResult.exitCode === 0 && headResult.stdout.trim().length > 0
        ? { head: headResult.stdout.trim() }
        : {}),
      ...(branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0
        ? { branch: branchResult.stdout.trim() }
        : {}),
      dirty: dirtyResult.stdout.length > 0,
      observedAt: now,
    };
    return { repository, checkout };
  }
}
