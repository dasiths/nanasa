import type { PortalSnapshot } from "@nanasa/contracts";
import { ArrowRight } from "lucide-react";
import { memberStatusView } from "../member-status.js";
import { groupRoute } from "../router/portal-router.js";
import type { PortalLinkHandler } from "./portal-navigation.js";

export function TeamShortcuts({
  snapshot,
  selectedGroupId,
  onLink,
}: {
  snapshot: PortalSnapshot;
  selectedGroupId?: string;
  onLink: PortalLinkHandler;
}) {
  return (
    <>
      <div className="team-shortcuts-heading">
        <span className="rail-section-label">Team workspaces</span>
      </div>
      <nav className="team-shortcuts" aria-label="Team workspaces">
        {[...snapshot.groups]
          .sort((left, right) => left.order - right.order)
          .map((group) => {
            const members = snapshot.memberships.filter(
              (member) => member.groupId === group.id && member.state === "active",
            );
            const statuses = members.map((member) =>
              memberStatusView(snapshot.agentStatuses, snapshot.runs, member),
            );
            const needsHelp = statuses.filter((status) => status.attentionWorthy).length;
            const working = statuses.filter((status) => status.key === "working").length;
            const href = groupRoute(group.id, "members");
            return (
              <a
                key={group.id}
                className="team-shortcut"
                href={href}
                aria-current={group.id === selectedGroupId ? "page" : undefined}
                onClick={onLink(href)}
              >
                <span
                  className={`team-shortcut-dot ${needsHelp ? "team-attention" : working ? "team-working" : ""}`}
                />
                <span>
                  <strong>{group.name}</strong>
                  <small>
                    {needsHelp
                      ? `${needsHelp} need attention`
                      : working
                        ? `${working} working`
                        : `${members.length} members`}
                  </small>
                </span>
                <ArrowRight size={12} />
              </a>
            );
          })}
      </nav>
    </>
  );
}
