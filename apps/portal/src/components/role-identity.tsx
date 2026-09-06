import type { RoleDefinition, RolePresentationIcon } from "@nanasa/contracts";
import {
  Bot,
  BriefcaseBusiness,
  ClipboardList,
  Code,
  Hammer,
  ScanSearch,
  ShieldCheck,
  Waypoints,
  Wrench,
} from "lucide-react";

const roleIcons = {
  "briefcase-business": BriefcaseBusiness,
  "clipboard-list": ClipboardList,
  code: Code,
  hammer: Hammer,
  "scan-search": ScanSearch,
  "shield-check": ShieldCheck,
  waypoints: Waypoints,
  wrench: Wrench,
} satisfies Record<RolePresentationIcon, typeof Hammer>;

export function roleColorClass(role: RoleDefinition | undefined): string {
  return `role-color-${role?.presentation?.color ?? "slate"}`;
}

export function RoleGlyph({
  role,
  size = 13,
}: {
  role: RoleDefinition | undefined;
  size?: number;
}) {
  const Icon =
    role === undefined
      ? Bot
      : role.presentation === undefined
        ? BriefcaseBusiness
        : roleIcons[role.presentation.icon];
  return <Icon aria-hidden="true" size={size} />;
}

export function RoleIdentity({
  role,
  compact = false,
}: {
  role: RoleDefinition | undefined;
  compact?: boolean;
}) {
  if (role === undefined) {
    return (
      <span className="role-identity role-unassigned" aria-label="Unassigned role">
        Unassigned
      </span>
    );
  }

  const presentation = role.presentation;
  const label = compact ? (presentation?.shortName ?? role.name) : role.name;

  return (
    <span
      className={`role-identity ${roleColorClass(role)}`}
      aria-label={`Role ${role.name}`}
      title={role.name}
    >
      <RoleGlyph role={role} />
      <span>{label}</span>
    </span>
  );
}
