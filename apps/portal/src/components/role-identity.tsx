import type { RoleDefinition, RolePresentationIcon } from "@nanasa/contracts";
import {
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
  const Icon = presentation === undefined ? BriefcaseBusiness : roleIcons[presentation.icon];
  const label = compact ? (presentation?.shortName ?? role.name) : role.name;

  return (
    <span
      className={`role-identity ${roleColorClass(role)}`}
      aria-label={`Role ${role.name}`}
      title={role.name}
    >
      <Icon aria-hidden="true" size={13} />
      <span>{label}</span>
    </span>
  );
}
