import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ConfiguredAgentProfile,
  ConfiguredMembership,
  InstructionPath,
  NanasaConfig,
  RoleDefinition,
} from "@nanasa/contracts";

import { NANASA_COORDINATION_INSTRUCTIONS } from "./coordination-instructions.js";

const MAX_INSTRUCTION_FILE_BYTES = 64 * 1024;
const MAX_EFFECTIVE_PROMPT_BYTES = 256 * 1024;

export interface PromptInstructionSource {
  scope: "builtin" | "global" | "group" | "role" | "profile" | "membership";
  reference: string;
}

export interface EffectiveAgentPrompt {
  roleId?: string;
  role?: RoleDefinition;
  text: string;
  revision: string;
  sources: PromptInstructionSource[];
}

export interface ResolveEffectiveAgentPromptInput {
  repoRoot: string;
  config: NanasaConfig;
  profileId: string;
  groupId: string;
  membershipId: string;
}

function assertInsideRepository(repoRoot: string, path: InstructionPath): string {
  const root = realpathSync(repoRoot);
  const candidate = resolve(root, path);
  const lexicalRelative = relative(root, candidate);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error(`Instruction path must remain beneath the repository root: ${path}`);
  }
  const status = lstatSync(candidate);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Instruction path must reference a regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Instruction file must be owned by the current user: ${path}`);
  }
  if (status.size > MAX_INSTRUCTION_FILE_BYTES) {
    throw new Error(`Instruction file exceeds ${MAX_INSTRUCTION_FILE_BYTES} bytes: ${path}`);
  }
  const realCandidate = realpathSync(candidate);
  const realRelative = relative(root, realCandidate);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`Instruction file symlink must remain beneath the repository root: ${path}`);
  }
  return realCandidate;
}

function readInstruction(repoRoot: string, path: InstructionPath): string {
  const bytes = readFileSync(assertInsideRepository(repoRoot, path));
  try {
    const content = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replaceAll("\r\n", "\n");
    if (content.includes("\0")) throw new Error("nul");
    return content;
  } catch {
    throw new Error(`Instruction file must contain valid UTF-8 without NUL characters: ${path}`);
  }
}

function configuredInputs(input: ResolveEffectiveAgentPromptInput): {
  profile: ConfiguredAgentProfile;
  membership: ConfiguredMembership;
} {
  const profile = input.config.agentProfiles[input.profileId];
  if (profile === undefined) throw new Error(`Configured profile not found: ${input.profileId}`);
  const membership = input.config.groups[input.groupId]?.memberships[input.membershipId];
  if (membership === undefined) {
    throw new Error(`Configured membership not found: ${input.membershipId}`);
  }
  if (membership.agentProfileId !== input.profileId) {
    throw new Error(
      `Membership ${input.membershipId} does not reference profile ${input.profileId}`,
    );
  }
  return { profile, membership };
}

export function resolveEffectiveAgentPrompt(
  input: ResolveEffectiveAgentPromptInput,
): EffectiveAgentPrompt {
  const { profile, membership } = configuredInputs(input);
  const group = input.config.groups[input.groupId];
  if (group === undefined) throw new Error(`Configured group not found: ${input.groupId}`);
  const roleId = membership.roleId ?? profile.defaultRoleId;
  const role = roleId === undefined ? undefined : input.config.roles[roleId];
  if (roleId !== undefined && role === undefined)
    throw new Error(`Configured role not found: ${roleId}`);

  const sections: Array<{ source: PromptInstructionSource; content: string }> = [
    {
      source: { scope: "builtin", reference: "builtin:nanasa-coordination-v1" },
      content: NANASA_COORDINATION_INSTRUCTIONS,
    },
    {
      source: { scope: "builtin", reference: "builtin:nanasa-assignment-v1" },
      content: [
        `Nanasa member ID: ${membership.memberId}`,
        `Nanasa member alias: ${membership.alias}`,
        roleId === undefined ? "Nanasa role: unassigned" : `Nanasa role: ${role!.name} (${roleId})`,
        ...(role?.description === undefined ? [] : [`Role purpose: ${role.description}`]),
      ].join("\n"),
    },
  ];
  const references: Array<{
    scope: PromptInstructionSource["scope"];
    paths: readonly InstructionPath[];
  }> = [
    { scope: "global", paths: input.config.instructions },
    { scope: "group", paths: group.instructions },
    { scope: "role", paths: role?.instructions ?? [] },
    { scope: "profile", paths: profile.instructions },
    { scope: "membership", paths: membership.instructions },
  ];
  const seen = new Set<string>();
  for (const { scope, paths } of references) {
    for (const path of paths) {
      if (seen.has(path)) throw new Error(`Instruction file is referenced more than once: ${path}`);
      seen.add(path);
      sections.push({
        source: { scope, reference: path },
        content: readInstruction(input.repoRoot, path),
      });
    }
  }

  const text = `${sections
    .map(({ source, content }) => `## ${source.scope}: ${source.reference}\n\n${content.trim()}`)
    .join("\n\n")}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_EFFECTIVE_PROMPT_BYTES) {
    throw new Error(`Effective prompt exceeds ${MAX_EFFECTIVE_PROMPT_BYTES} bytes`);
  }
  return {
    ...(roleId === undefined ? {} : { roleId }),
    ...(role === undefined ? {} : { role }),
    text,
    revision: createHash("sha256").update(text).digest("hex"),
    sources: sections.map(({ source }) => source),
  };
}

export function validateInstructionFiles(repoRoot: string, config: NanasaConfig): void {
  const references = [
    ...config.instructions,
    ...Object.values(config.roles).flatMap((role) => role.instructions),
    ...Object.values(config.agentProfiles).flatMap((profile) => profile.instructions),
    ...Object.values(config.groups).flatMap((group) => [
      ...group.instructions,
      ...Object.values(group.memberships).flatMap((membership) => membership.instructions),
    ]),
  ];
  const seen = new Set<string>();
  for (const path of references) {
    if (seen.has(path)) throw new Error(`Instruction file is referenced more than once: ${path}`);
    seen.add(path);
    readInstruction(repoRoot, path);
  }
}
