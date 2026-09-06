import {
  type AdHocConsoleSession,
  AdHocConsoleSessionSchema,
  type Checkout,
  CheckoutSchema,
  type CreateWorktreeCommand,
  type GitReference,
  GitReferenceListSchema,
  type GitStatusProjection,
  GitStatusProjectionSchema,
  type OpenCheckoutCommand,
  type RemoveWorktreeCommand,
  type Repository,
  RepositorySchema,
  type TerminalCheckpoint,
  TerminalCheckpointContentSchema,
  TerminalCheckpointSchema,
  type Worktree,
  type WorktreeOperationResult,
  WorktreeOperationResultSchema,
  WorktreeSchema,
} from "@nanasa/contracts";
import type { NanasaControlClient } from "../index.js";
import { commandInit, path, request } from "./common.js";

export class WorkspaceResource {
  public constructor(private readonly client: NanasaControlClient) {}

  public listRepositories(): Promise<Repository[]> {
    return request(this.client, path("repositories"), RepositorySchema.array());
  }

  public listCheckouts(repositoryId: string): Promise<Checkout[]> {
    return request(
      this.client,
      path("repositories", repositoryId, "checkouts"),
      CheckoutSchema.array(),
    );
  }

  public refreshCheckout(checkoutId: string, key?: string): Promise<GitStatusProjection> {
    return request(
      this.client,
      path("checkouts", checkoutId, "refresh"),
      GitStatusProjectionSchema,
      commandInit("POST", {}, key),
    );
  }

  public listCheckoutReferences(checkoutId: string): Promise<GitReference[]> {
    return request(
      this.client,
      path("checkouts", checkoutId, "references"),
      GitReferenceListSchema,
    );
  }

  public fetchCheckout(checkoutId: string): Promise<GitStatusProjection[]> {
    return request(
      this.client,
      path("checkouts", checkoutId, "fetch"),
      GitStatusProjectionSchema.array(),
      commandInit("POST", {}),
    );
  }

  public openCheckout(
    command: OpenCheckoutCommand,
    key?: string,
  ): Promise<WorktreeOperationResult> {
    return request(
      this.client,
      path("checkouts", "open"),
      WorktreeOperationResultSchema,
      commandInit("POST", command, key),
    );
  }

  public listWorktrees(repositoryId: string): Promise<Worktree[]> {
    return request(
      this.client,
      path("repositories", repositoryId, "worktrees"),
      WorktreeSchema.array(),
    );
  }

  public createWorktree(
    command: CreateWorktreeCommand,
    key?: string,
  ): Promise<WorktreeOperationResult> {
    return request(
      this.client,
      path("worktrees"),
      WorktreeOperationResultSchema,
      commandInit("POST", command, key),
    );
  }

  public removeWorktree(
    worktreeId: string,
    command: RemoveWorktreeCommand,
    key?: string,
  ): Promise<WorktreeOperationResult> {
    return request(
      this.client,
      path("worktrees", worktreeId),
      WorktreeOperationResultSchema,
      commandInit("DELETE", command, key),
    );
  }

  public listConsoles(): Promise<AdHocConsoleSession[]> {
    return request(this.client, path("consoles"), AdHocConsoleSessionSchema.array());
  }

  public getConsole(consoleId: string): Promise<AdHocConsoleSession> {
    return request(this.client, path("consoles", consoleId), AdHocConsoleSessionSchema);
  }

  public createConsole(key?: string): Promise<AdHocConsoleSession> {
    return request(
      this.client,
      path("consoles"),
      AdHocConsoleSessionSchema,
      commandInit("POST", {}, key),
    );
  }

  public closeConsole(consoleId: string, key?: string): Promise<void> {
    return this.client.requestVoid(path("consoles", consoleId), commandInit("DELETE", {}, key));
  }

  public listCheckpoints(): Promise<TerminalCheckpoint[]> {
    return request(this.client, path("terminal-checkpoints"), TerminalCheckpointSchema.array());
  }

  public getCheckpoint(
    checkpointId: string,
  ): Promise<{ checkpoint: TerminalCheckpoint; text: string }> {
    return request(
      this.client,
      path("terminal-checkpoints", checkpointId),
      TerminalCheckpointContentSchema,
    );
  }
}
