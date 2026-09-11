import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CredentialProfileReference,
  ProviderStateBinding,
  ProviderStatePolicy,
} from "@nanasa/contracts";
import {
  IdentifierSchema,
  IntegrationIdSchema,
  ProviderStateBindingSchema,
} from "@nanasa/contracts";
import { resolveProviderStateHome } from "./provider-state-home.js";

export interface ProviderStatePersistence {
  upsertProviderState(binding: ProviderStateBinding): ProviderStateBinding;
  getProviderState(bindingId: string): ProviderStateBinding | undefined;
  listProviderStates(): readonly ProviderStateBinding[];
  setProviderStateLifecycle(
    bindingId: string,
    lifecycle: ProviderStateBinding["lifecycle"],
  ): ProviderStateBinding;
}

export interface ResolveProviderStateInput {
  readonly membershipId: string;
  readonly integrationId: string;
  readonly policy: ProviderStatePolicy;
  readonly credentialReference: CredentialProfileReference;
}

export function providerOverlayBindingId(membershipId: string, integrationId: string): string {
  return `overlay-${createHash("sha256")
    .update(membershipId)
    .update("\0")
    .update(integrationId)
    .digest("hex")
    .slice(0, 32)}`;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error(`Provider state path must be a regular directory: ${path}`);
  if (typeof process.getuid === "function" && status.uid !== process.getuid())
    throw new Error(`Provider state path must be owned by the current user: ${path}`);
  chmodSync(path, 0o700);
}

function ensurePrivateTree(root: string, path: string): void {
  const rootPath = resolve(root);
  const child = relative(rootPath, resolve(path));
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Provider state escaped the integrations root");
  ensurePrivateDirectory(rootPath);
  let current = rootPath;
  for (const segment of child.split(sep).filter(Boolean)) {
    current = join(current, segment);
    ensurePrivateDirectory(current);
  }
}

export class ProviderStateRepository {
  readonly #root: string;
  readonly #persistence: ProviderStatePersistence | undefined;

  public constructor(integrationsDirectory: string, persistence?: ProviderStatePersistence) {
    this.#root = resolve(integrationsDirectory);
    this.#persistence = persistence;
    ensurePrivateTree(this.#root, join(this.#root, "state"));
  }

  public resolve(input: ResolveProviderStateInput): ProviderStateBinding {
    const storageReference = resolveProviderStateHome(
      this.#root,
      input.integrationId,
      input.policy,
      input.membershipId,
    );
    return this.#resolveBinding({
      integrationId: input.integrationId,
      ownerId: input.membershipId,
      memberId: input.membershipId,
      scope: input.policy.scope,
      storageReference,
      credentialReference: input.credentialReference,
    });
  }

  public resolveForForeman(input: {
    foremanId: string;
    integrationId: string;
    credentialReference: CredentialProfileReference;
  }): ProviderStateBinding {
    const foremanId = IdentifierSchema.parse(input.foremanId);
    const integrationId = IntegrationIdSchema.parse(input.integrationId);
    const directory = createHash("sha256").update(foremanId).digest("hex");
    return this.#resolveBinding({
      integrationId,
      ownerId: foremanId,
      foremanId,
      scope: "foreman",
      storageReference: join(this.#root, "state", "foremen", directory, integrationId),
      credentialReference: input.credentialReference,
    });
  }

  #resolveBinding(input: {
    integrationId: string;
    ownerId: string;
    memberId?: string;
    foremanId?: string;
    scope: ProviderStateBinding["scope"];
    storageReference: string;
    credentialReference: CredentialProfileReference;
  }): ProviderStateBinding {
    const { storageReference } = input;
    ensurePrivateTree(this.#root, storageReference);
    const id = `provider-state-${createHash("sha256")
      .update(input.integrationId)
      .update("\0")
      .update(input.ownerId)
      .update("\0")
      .update(storageReference)
      .digest("hex")
      .slice(0, 32)}`;
    const existing = this.#persistence?.getProviderState(id);
    const now = new Date().toISOString();
    const binding = ProviderStateBindingSchema.parse({
      id,
      integrationId: input.integrationId,
      memberId: input.memberId,
      foremanId: input.foremanId,
      scope: input.scope,
      storageReference,
      credentialReference: input.credentialReference,
      lifecycle: existing?.lifecycle === "retained" ? "active" : (existing?.lifecycle ?? "active"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return this.#persistence?.upsertProviderState(binding) ?? binding;
  }

  public get(bindingId: string): ProviderStateBinding | undefined {
    return this.#persistence?.getProviderState(bindingId);
  }

  public list(): readonly ProviderStateBinding[] {
    return this.#persistence?.listProviderStates() ?? Object.freeze([]);
  }

  public retain(bindingId: string): ProviderStateBinding {
    if (this.#persistence === undefined)
      throw new Error("Provider state persistence is unavailable");
    return this.#persistence.setProviderStateLifecycle(bindingId, "retained");
  }

  public markDeleting(bindingId: string): ProviderStateBinding {
    if (this.#persistence === undefined)
      throw new Error("Provider state persistence is unavailable");
    return this.#persistence.setProviderStateLifecycle(bindingId, "deleting");
  }

  public markDeleted(bindingId: string): ProviderStateBinding {
    if (this.#persistence === undefined)
      throw new Error("Provider state persistence is unavailable");
    return this.#persistence.setProviderStateLifecycle(bindingId, "deleted");
  }
}
