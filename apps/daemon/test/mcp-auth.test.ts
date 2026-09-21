import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { McpCredentialIssuer } from "../src/mcp-auth.js";
import { NanasaStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "nanasa-mcp-auth-"));
  temporaryDirectories.push(directory);
  const store = new NanasaStore(":memory:");
  const group = store.createGroup({ name: "MCP auth" });
  const profile = store.createInternalAgentProfile({
    name: "Fixture",
    agentType: "fixture",
    kind: "opencode",
    command: "node",
    args: ["--version"],
    environment: {},
  });
  const membership = store.addMembership(group.id, {
    memberId: "sender",
    agentProfileId: profile.id,
    alias: "Sender",
  });
  const run = store.createRunForMembership(group.id, membership.memberId).run;
  const secretPath = join(directory, "mcp-secret");
  const issuer = new McpCredentialIssuer(store, {
    secretPath,
    operatorToken: "operator-token-with-at-least-32-characters",
  });
  return { store, group, membership, run, secretPath, issuer };
}

describe("McpCredentialIssuer", () => {
  it("fences Foreman credentials by repository, generation, and authority revision", () => {
    const fixture = createFixture();
    const other = createFixture();
    try {
      const profile = fixture.store.createInternalAgentProfile({
        name: "Foreman",
        agentType: "fixture",
        kind: "opencode",
        command: "node",
        args: [],
        environment: {},
      });
      const configured = { id: "foreman", agentProfileId: profile.id, enabled: true };
      fixture.store.upsertForeman(configured);
      const { run } = fixture.store.createRunForForeman("foreman");
      const token = fixture.issuer.issueForeman(run);
      expect(fixture.issuer.authenticate(`Bearer ${token}`)).toEqual({
        kind: "foreman",
        foremanId: "foreman",
        runId: run.id,
        generation: 1,
        authorityRevision: 0,
      });
      fixture.store.upsertForeman(configured);
      expect(fixture.issuer.authenticate(`Bearer ${token}`).kind).toBe("foreman");
      expect(() => other.issuer.authenticate(`Bearer ${token}`)).toThrowError(
        expect.objectContaining({ code: "mcp_unauthorized" }),
      );
      const spoofedTeamToken = fixture.issuer.issueAgent({
        ...run,
        groupId: fixture.group.id,
        memberId: fixture.membership.memberId,
      });
      expect(() => fixture.issuer.authenticate(`Bearer ${spoofedTeamToken}`)).toThrowError(
        expect.objectContaining({ code: "mcp_credential_revoked" }),
      );
      fixture.store.upsertForeman({ ...configured, enabled: false });
      expect(() => fixture.issuer.authenticate(`Bearer ${token}`)).toThrowError(
        expect.objectContaining({ code: "mcp_credential_revoked" }),
      );
      fixture.store.upsertForeman(configured);
      expect(() => fixture.issuer.authenticate(`Bearer ${token}`)).toThrowError(
        expect.objectContaining({ code: "mcp_credential_revoked" }),
      );
      const currentToken = fixture.issuer.issueForeman(run);
      expect(fixture.issuer.authenticate(`Bearer ${currentToken}`)).toMatchObject({
        authorityRevision: 2,
      });
      fixture.store.updateRuntimeRunStatus(run.id, "failed");
      const replacement = fixture.store.createRunForForeman("foreman").run;
      expect(replacement.generation).toBe(2);
      expect(() => fixture.issuer.authenticate(`Bearer ${currentToken}`)).toThrowError(
        expect.objectContaining({ code: "mcp_credential_revoked" }),
      );
      expect(() => fixture.issuer.issueForeman(run)).toThrowError(
        expect.objectContaining({ code: "mcp_credential_revoked" }),
      );
      expect(
        fixture.issuer.authenticate(`Bearer ${fixture.issuer.issueForeman(replacement)}`),
      ).toMatchObject({ generation: 2 });
    } finally {
      fixture.store.close();
      other.store.close();
    }
  });

  it("authenticates live generation-scoped agent and configured operator credentials", () => {
    const fixture = createFixture();
    const token = fixture.issuer.issueAgent(fixture.run);

    expect(fixture.issuer.authenticate(`Bearer ${token}`)).toEqual({
      kind: "agent",
      groupId: fixture.group.id,
      memberId: fixture.membership.memberId,
      runId: fixture.run.id,
      generation: fixture.run.generation,
    });
    expect(
      fixture.issuer.authenticate("Bearer operator-token-with-at-least-32-characters"),
    ).toEqual({ kind: "operator", operatorId: "remote-operator" });
    fixture.store.close();
  });

  it("persists the signing secret and rejects absent or tampered credentials", () => {
    const fixture = createFixture();
    const token = fixture.issuer.issueAgent(fixture.run);
    const reopened = new McpCredentialIssuer(fixture.store, { secretPath: fixture.secretPath });

    expect(reopened.authenticate(`Bearer ${token}`)).toMatchObject({ runId: fixture.run.id });
    expect(() => reopened.authenticate(undefined)).toThrowError(
      expect.objectContaining({ code: "mcp_unauthorized", statusCode: 401 }),
    );
    expect(() => reopened.authenticate(`Bearer ${token.slice(0, -1)}x`)).toThrowError(
      expect.objectContaining({ code: "mcp_unauthorized", statusCode: 401 }),
    );
    expect(lstatSync(fixture.secretPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(fixture.secretPath)).mode & 0o777).toBe(0o700);
    fixture.store.close();
  });

  it("rejects secret symlinks, non-regular files, broad modes, and wrong owners", () => {
    for (const attack of ["symlink", "directory", "mode", "owner"] as const) {
      const fixture = createFixture();
      if (attack === "symlink") {
        rmSync(fixture.secretPath);
        const target = `${fixture.secretPath}-target`;
        writeFileSync(target, Buffer.alloc(32), { mode: 0o600 });
        symlinkSync(target, fixture.secretPath);
      } else if (attack === "directory") {
        rmSync(fixture.secretPath);
        mkdirSync(fixture.secretPath);
      } else if (attack === "mode") {
        chmodSync(fixture.secretPath, 0o644);
      }

      expect(
        () =>
          new McpCredentialIssuer(fixture.store, {
            secretPath: fixture.secretPath,
            ...(attack === "owner"
              ? { expectedUid: (process.getuid?.() ?? lstatSync(fixture.secretPath).uid) + 1 }
              : {}),
          }),
      ).toThrow(
        attack === "symlink"
          ? "must not be a symlink"
          : attack === "directory"
            ? "must be a regular file"
            : attack === "mode"
              ? "permissions must be 0600"
              : "owned by the current user",
      );
      fixture.store.close();
    }
  });

  it("repairs an existing secret directory to owner-only access", () => {
    const fixture = createFixture();
    const directory = dirname(fixture.secretPath);
    chmodSync(directory, 0o755);

    new McpCredentialIssuer(fixture.store, { secretPath: fixture.secretPath });

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    fixture.store.close();
  });

  it("revokes credentials when a run stops, is replaced, or loses active membership", () => {
    const stopped = createFixture();
    const stoppedToken = stopped.issuer.issueAgent(stopped.run);
    stopped.store.updateRunStatus(stopped.run.id, "stopping");
    expect(() => stopped.issuer.authenticate(`Bearer ${stoppedToken}`)).toThrowError(
      expect.objectContaining({ code: "mcp_credential_revoked" }),
    );
    stopped.store.close();

    const replaced = createFixture();
    const staleToken = replaced.issuer.issueAgent(replaced.run);
    replaced.store.updateRunStatus(replaced.run.id, "failed");
    const replacement = replaced.store.createRunForMembership(
      replaced.group.id,
      replaced.membership.memberId,
    ).run;
    expect(replacement.generation).toBe(replaced.run.generation + 1);
    expect(() => replaced.issuer.authenticate(`Bearer ${staleToken}`)).toThrowError(
      expect.objectContaining({ code: "mcp_credential_revoked" }),
    );
    replaced.store.close();

    const removed = createFixture();
    const removedToken = removed.issuer.issueAgent(removed.run);
    removed.store.removeMembership(removed.group.id, removed.membership.memberId);
    expect(() => removed.issuer.authenticate(`Bearer ${removedToken}`)).toThrowError(
      expect.objectContaining({ code: "mcp_credential_revoked" }),
    );
    removed.store.close();
  });
});
