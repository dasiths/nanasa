import type { Group, NanasaConfig, PortalSnapshot } from "@nanasa/contracts";
import {
  Bell,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  GitBranch,
  Info,
  Laptop,
  Menu,
  Moon,
  Network,
  PackageCheck,
  ServerCog,
  Settings,
  SquareTerminal,
  Stethoscope,
  Sun,
  X,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useRef, useState } from "react";
import { Dialog } from "../a11y/primitives.js";
import type { ThemePreference, WorkspaceSection } from "../hooks/use-portal-preferences.js";
import { memberStatusView } from "../member-status.js";
import {
  type GlobalDestination,
  type GlobalDestinationDefinition,
  globalDestinationDefinitions,
  groupDestinations,
} from "../router/portal-destinations.js";
import { groupRoute, type PortalRoute } from "../router/portal-router.js";

export type PortalLinkHandler = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => void;

const destinationIcons: Record<GlobalDestination, ReactNode> = {
  foreman: <Bot aria-hidden="true" size={15} />,
  attention: <Bell aria-hidden="true" size={15} />,
  agents: <Bot aria-hidden="true" size={15} />,
  checkouts: <GitBranch aria-hidden="true" size={15} />,
  extensions: <PackageCheck aria-hidden="true" size={15} />,
  diagnostics: <Stethoscope aria-hidden="true" size={15} />,
  service: <ServerCog aria-hidden="true" size={15} />,
  remote: <Network aria-hidden="true" size={15} />,
  settings: <Settings aria-hidden="true" size={15} />,
  help: <CircleHelp aria-hidden="true" size={15} />,
  release: <Info aria-hidden="true" size={15} />,
};

function displayCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

const primaryDestinations = ["foreman", "checkouts", "agents", "attention"].map(
  (id) => globalDestinationDefinitions.find((destination) => destination.id === id)!,
);

function DestinationLink({
  destination,
  currentDestination,
  attentionCount,
  onLink,
  onSelected,
}: {
  destination: GlobalDestinationDefinition;
  currentDestination: GlobalDestination | undefined;
  attentionCount: number;
  onLink: PortalLinkHandler;
  onSelected?(): void;
}) {
  const selected = destination.id === currentDestination;
  return (
    <a
      className="portal-nav-link"
      href={`/${destination.id}`}
      aria-current={selected ? "page" : undefined}
      onClick={(event) => {
        const handled =
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey;
        onLink(`/${destination.id}`)(event);
        if (handled) onSelected?.();
      }}
    >
      {destinationIcons[destination.id]}
      <span>{destination.label}</span>
      {destination.id === "attention" && attentionCount > 0 && (
        <span
          className="navigation-badge attention-navigation-badge"
          aria-label={`${attentionCount} ${attentionCount === 1 ? "review item requires" : "review items require"} attention across all groups`}
        >
          {displayCount(attentionCount)}
        </span>
      )}
    </a>
  );
}

export function RepositoryNavigation({
  currentDestination,
  attentionCount,
  onLink,
}: {
  currentDestination: GlobalDestination | undefined;
  attentionCount: number;
  onLink: PortalLinkHandler;
}) {
  return (
    <section className="repository-navigation" aria-labelledby="repository-navigation-title">
      <span id="repository-navigation-title" className="rail-section-label">
        Workspace
      </span>
      <nav className="portal-navigation-list" aria-label="Operations">
        {primaryDestinations.map((destination) => (
          <DestinationLink
            key={destination.id}
            destination={destination}
            currentDestination={currentDestination}
            attentionCount={attentionCount}
            onLink={onLink}
          />
        ))}
      </nav>
    </section>
  );
}

export function PortalUtilities({
  currentDestination,
  theme,
  onSetTheme,
  onLink,
}: {
  currentDestination: GlobalDestination | undefined;
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  onLink: PortalLinkHandler;
}) {
  const utilities = globalDestinationDefinitions.filter(({ group }) => group === "utilities");
  const utilitySelected = utilities.some(({ id }) => id === currentDestination);
  const menuRef = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={menuRef} className="portal-utilities-menu">
      <summary
        className={`compact-button${utilitySelected ? " has-active-destination" : ""}`}
        aria-label="Portal utilities"
      >
        <Menu aria-hidden="true" size={15} />
        <span>More</span>
      </summary>
      <div className="portal-utilities-popover">
        <span className="rail-section-label">Theme</span>
        <div className="utility-theme-switch" role="group" aria-label="Color theme">
          <button
            type="button"
            aria-label="Use light theme"
            aria-pressed={theme === "light"}
            onClick={() => onSetTheme("light")}
          >
            <Sun aria-hidden="true" size={14} />
            Light
          </button>
          <button
            type="button"
            aria-label="Use system theme"
            aria-pressed={theme === "system"}
            onClick={() => onSetTheme("system")}
          >
            <Laptop aria-hidden="true" size={14} />
            System
          </button>
          <button
            type="button"
            aria-label="Use dark theme"
            aria-pressed={theme === "dark"}
            onClick={() => onSetTheme("dark")}
          >
            <Moon aria-hidden="true" size={14} />
            Dark
          </button>
        </div>
        <nav className="portal-navigation-list" aria-label="Portal utilities">
          {utilities.map((destination) => (
            <DestinationLink
              key={destination.id}
              destination={destination}
              currentDestination={currentDestination}
              attentionCount={0}
              onLink={onLink}
              onSelected={() => menuRef.current?.removeAttribute("open")}
            />
          ))}
        </nav>
      </div>
    </details>
  );
}

export function GroupNavigation({
  group,
  route,
  unreadCount,
  attentionCount,
  actions,
  onLink,
}: {
  group: Group;
  route: PortalRoute;
  unreadCount: number;
  attentionCount: number;
  actions?: ReactNode;
  onLink: PortalLinkHandler;
}) {
  return (
    <nav className="route-navigation" aria-label={`${group.name} sections`}>
      {groupDestinations.map((destination) => {
        const count =
          destination.id === "messages"
            ? unreadCount
            : destination.id === "activity"
              ? attentionCount
              : 0;
        return (
          <a
            key={destination.id}
            href={groupRoute(group.id, destination.id)}
            aria-current={
              route.kind === "group" && route.section === destination.id ? "page" : undefined
            }
            onClick={onLink(groupRoute(group.id, destination.id))}
          >
            {destination.label}
            {count > 0 && (
              <span
                className={`navigation-badge ${destination.id === "messages" ? "message-navigation-badge" : "attention-navigation-badge"}`}
                aria-label={
                  destination.id === "messages"
                    ? `${count} unread messages in ${group.name}`
                    : `${count} ${count === 1 ? "review item requires" : "review items require"} attention in ${group.name}`
                }
              >
                {displayCount(count)}
              </span>
            )}
          </a>
        );
      })}
      {actions !== undefined && <div className="route-navigation-actions">{actions}</div>}
    </nav>
  );
}

export function MobileNavigationDialog({
  open,
  route,
  groups,
  config,
  snapshot,
  selectedGroupId,
  lastSectionByGroup,
  attentionCount,
  theme,
  onSetTheme,
  onLink,
  onSelectGroup,
  onOpenCommandPalette,
  onOpenConsole,
  onClose,
}: {
  open: boolean;
  route: PortalRoute;
  groups: Group[];
  config: NanasaConfig;
  snapshot: PortalSnapshot;
  selectedGroupId?: string;
  lastSectionByGroup: Record<string, WorkspaceSection>;
  attentionCount: number;
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  onLink: PortalLinkHandler;
  onSelectGroup(groupId: string, section: WorkspaceSection): void;
  onOpenCommandPalette(): void;
  onOpenConsole(): void;
  onClose(): void;
}) {
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const currentDestination = route.kind === "global" ? route.destination : undefined;
  const utilities = globalDestinationDefinitions.filter(({ group }) => group === "utilities");
  const closeAfterLink: PortalLinkHandler = (path) => (event) => {
    const handled =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    onLink(path)(event);
    if (handled) onClose();
  };
  return (
    <Dialog
      open={open}
      labelledBy="mobile-navigation-title"
      onClose={onClose}
      className="mobile-navigation-dialog"
      closeOnBackdrop
    >
      <div className="mobile-navigation-shell">
        <header className="mobile-navigation-heading">
          <div>
            <span className="eyebrow">Operations</span>
            <h2 id="mobile-navigation-title">Nanasa</h2>
          </div>
          <div className="mobile-navigation-heading-actions">
            <button
              type="button"
              className="compact-button mobile-command-button"
              aria-label="Open command palette"
              title="Open command palette"
              onClick={() => {
                onClose();
                onOpenCommandPalette();
              }}
            >
              <Command aria-hidden="true" size={16} />
              Commands
            </button>
            <button type="button" className="icon-button" aria-label="Close menu" onClick={onClose}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        </header>
        <div className="mobile-navigation-scroll">
          <section aria-labelledby="mobile-operations-title">
            <span id="mobile-operations-title" className="rail-section-label">
              Workspace
            </span>
            <nav className="portal-navigation-list" aria-label="Operations">
              {primaryDestinations.map((destination) => (
                <DestinationLink
                  key={destination.id}
                  destination={destination}
                  currentDestination={currentDestination}
                  attentionCount={attentionCount}
                  onLink={closeAfterLink}
                />
              ))}
            </nav>
          </section>
          <section className="mobile-groups" aria-labelledby="mobile-groups-title">
            <span id="mobile-groups-title" className="rail-section-label">
              Teams
            </span>
            <nav className="portal-navigation-list" aria-label="Groups">
              {groups.map((group) => {
                const section = lastSectionByGroup[group.id] ?? "terminals";
                const path = groupRoute(group.id, section);
                const members = Object.values(config.groups[group.id]?.agents ?? {});
                const expanded = expandedTeams.has(group.id);
                return (
                  <div className="mobile-team" key={group.id}>
                    <div className="mobile-team-heading">
                      <button
                        className="icon-button"
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name} members`}
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedTeams((current) => {
                            const next = new Set(current);
                            if (expanded) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          })
                        }
                      >
                        {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                      </button>
                      <a
                        className="portal-nav-link"
                        href={path}
                        aria-label={group.name}
                        aria-current={selectedGroupId === group.id ? "page" : undefined}
                        onClick={(event) => {
                          const handled =
                            event.button === 0 &&
                            !event.metaKey &&
                            !event.ctrlKey &&
                            !event.shiftKey &&
                            !event.altKey;
                          if (!handled) return;
                          event.preventDefault();
                          onSelectGroup(group.id, section);
                          onClose();
                        }}
                      >
                        <span>{group.name}</span>
                        <span className="navigation-badge">{members.length}</span>
                      </a>
                    </div>
                    {expanded && (
                      <div className="mobile-team-members">
                        {members.map((agent) => {
                          const membership = snapshot.memberships.find(
                            (member) =>
                              member.groupId === group.id && member.memberId === agent.memberId,
                          );
                          const status =
                            membership === undefined
                              ? undefined
                              : memberStatusView(snapshot.agentStatuses, snapshot.runs, membership);
                          const destination = groupRoute(group.id, "terminals", status?.run?.id);
                          return (
                            <a
                              key={agent.memberId}
                              className="mobile-member-link"
                              href={destination}
                              onClick={closeAfterLink(destination)}
                            >
                              <span
                                className={`status-dot status-${status?.key ?? "idle"}`}
                                aria-hidden="true"
                              />
                              <span>
                                <strong>{agent.name}</strong>
                                <small>
                                  {agent.roleId
                                    ? (config.roles[agent.roleId]?.name ?? agent.roleId)
                                    : "Unassigned"}{" "}
                                  · {status?.label ?? "Not started"}
                                </small>
                              </span>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
          </section>
          <section className="mobile-utility-links" aria-label="Utilities">
            <span className="rail-section-label">Utilities</span>
            <nav className="portal-navigation-list" aria-label="Portal utilities">
              <button
                type="button"
                className="portal-nav-link"
                onClick={() => {
                  onClose();
                  onOpenConsole();
                }}
              >
                <SquareTerminal size={17} aria-hidden="true" />
                <span>Console</span>
              </button>
              {utilities.map((destination) => (
                <DestinationLink
                  key={destination.id}
                  destination={destination}
                  currentDestination={currentDestination}
                  attentionCount={0}
                  onLink={closeAfterLink}
                />
              ))}
            </nav>
          </section>
        </div>
        <footer className="mobile-navigation-footer">
          <div className="utility-theme-switch" role="group" aria-label="Color theme">
            <button
              type="button"
              aria-label="Use light theme"
              aria-pressed={theme === "light"}
              onClick={() => onSetTheme("light")}
            >
              <Sun aria-hidden="true" size={14} />
              Light
            </button>
            <button
              type="button"
              aria-label="Use system theme"
              aria-pressed={theme === "system"}
              onClick={() => onSetTheme("system")}
            >
              <Laptop aria-hidden="true" size={14} />
              System
            </button>
            <button
              type="button"
              aria-label="Use dark theme"
              aria-pressed={theme === "dark"}
              onClick={() => onSetTheme("dark")}
            >
              <Moon aria-hidden="true" size={14} />
              Dark
            </button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
