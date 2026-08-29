import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  NativeSessionReferenceSchema,
  type AgentKind,
  type NativeSessionReference,
} from "@nanasa/contracts";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;

export function generatedAgentName(membershipId: string): string {
  return `nanasa-${createHash("sha256").update(membershipId).digest("hex").slice(0, 16)}`;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeSessionReference(
  provider: AgentKind,
  report: { source: string; referenceKind: "id" | "path"; referenceValue: string },
  stateRoot: string,
): NativeSessionReference {
  if (
    Buffer.byteLength(report.referenceValue, "utf8") > 4_096 ||
    /[\0\r\n]/.test(report.referenceValue)
  ) {
    throw new Error("Native session reference is malformed or oversized");
  }
  if (report.referenceKind === "path") {
    if (!isAbsolute(report.referenceValue)) throw new Error("Native session path must be absolute");
    const path = resolve(report.referenceValue);
    const root = resolve(stateRoot);
    const child = relative(root, path);
    if (child === "" || child === ".." || child.startsWith("../") || isAbsolute(child)) {
      throw new Error("Native session path must remain inside provider state");
    }
  } else if (!SESSION_ID.test(report.referenceValue)) {
    throw new Error("Native session ID contains unsupported characters");
  }
  const dedupeHash = createHash("sha256")
    .update(provider)
    .update("\0")
    .update(report.referenceKind)
    .update("\0")
    .update(report.referenceValue)
    .digest("hex");
  return NativeSessionReferenceSchema.parse({
    provider,
    source: report.source,
    referenceKind: report.referenceKind,
    referenceValue: report.referenceValue,
    dedupeHash,
  });
}

export async function unsupportedSessionMutation(): Promise<boolean> {
  return false;
}
