import type { Group } from "@nanasa/contracts";
import {
  Bell,
  Bot,
  Boxes,
  CircleHelp,
  GitBranch,
  Info,
  Laptop,
  Menu,
  Moon,
  Network,
  PackageCheck,
  ServerCog,
  Settings,
  Stethoscope,
  Sun,
  X,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useRef } from "react";
import { Dialog } from "../a11y/primitives.js";
import type { ThemePreference, WorkspaceSection } from "../hooks/use-portal-preferences.js";
import {
  globalDestinationDefinitions,
  groupDestinations,
  type GlobalDestination,
  type GlobalDestinationDefinition,
} from "../router/portal-destinations.js";
import { groupRoute, type PortalRoute } from "../router/portal-router.js";

export type PortalLinkHandler = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => void;

const destinationIcons: Record<GlobalDestination, ReactNode> = {
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
  const operations = globalDestinationDefinitions.filter(({ group }) => group === "operations");
  const system = globalDestinationDefinitions.filter(({ group }) => group === "system");
  const systemSelected = system.some(({ id }) => id === currentDestination);
  return (
    <section className="repository-navigation" aria-labelledby="repository-navigation-title">
      <span id="repository-navigation-title" className="rail-section-label">
        Repository operations
      </span>
      <nav className="portal-navigation-list" aria-label="Repository operations">
        {operations.map((destination) => (
          <DestinationLink
            key={destination.id}
            destination={destination}
            currentDestination={currentDestination}
            attentionCount={attentionCount}
            onLink={onLink}
          />
        ))}
        <details className="portal-navigation-disclosure" open={systemSelected || undefined}>
          <summary className={systemSelected ? "has-active-destination" : undefined}>
            <Boxes aria-hidden="true" size={15} />
            <span>System</span>
            <span className="disclosure-chevron" aria-hidden="true">
              ›
            </span>
          </summary>
          <div className="portal-navigation-sublist">
            {system.map((destination) => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                currentDestination={currentDestination}
                attentionCount={attentionCount}
                onLink={onLink}
              />
            ))}
          </div>
        </details>
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
  onLink,
}: {
  group: Group;
  route: PortalRoute;
  unreadCount: number;
  attentionCount: number;
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
    </nav>
  );
}

export function MobileNavigationDialog({
  open,
  route,
  groups,
  selectedGroupId,
  lastSectionByGroup,
  attentionCount,
  theme,
  onSetTheme,
  onLink,
  onSelectGroup,
  onClose,
}: {
  open: boolean;
  route: PortalRoute;
  groups: Group[];
  selectedGroupId?: string;
  lastSectionByGroup: Record<string, WorkspaceSection>;
  attentionCount: number;
  theme: ThemePreference;
  onSetTheme(theme: ThemePreference): void;
  onLink: PortalLinkHandler;
  onSelectGroup(groupId: string, section: WorkspaceSection): void;
  onClose(): void;
}) {
  const currentDestination = route.kind === "global" ? route.destination : undefined;
  const operations = globalDestinationDefinitions.filter(({ group }) => group === "operations");
  const system = globalDestinationDefinitions.filter(({ group }) => group === "system");
  const utilities = globalDestinationDefinitions.filter(({ group }) => group === "utilities");
  const systemSelected = system.some(({ id }) => id === currentDestination);
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
          <button type="button" className="icon-button" aria-label="Close menu" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="mobile-navigation-scroll">
          <section aria-labelledby="mobile-operations-title">
            <span id="mobile-operations-title" className="rail-section-label">
              Repository operations
            </span>
            <nav className="portal-navigation-list" aria-label="Repository operations">
              {operations.map((destination) => (
                <DestinationLink
                  key={destination.id}
                  destination={destination}
                  currentDestination={currentDestination}
                  attentionCount={attentionCount}
                  onLink={closeAfterLink}
                />
              ))}
              <details className="portal-navigation-disclosure" open={systemSelected || undefined}>
                <summary className={systemSelected ? "has-active-destination" : undefined}>
                  <Boxes aria-hidden="true" size={15} />
                  <span>System</span>
                  <span className="disclosure-chevron" aria-hidden="true">
                    ›
                  </span>
                </summary>
                <div className="portal-navigation-sublist">
                  {system.map((destination) => (
                    <DestinationLink
                      key={destination.id}
                      destination={destination}
                      currentDestination={currentDestination}
                      attentionCount={attentionCount}
                      onLink={closeAfterLink}
                    />
                  ))}
                </div>
              </details>
            </nav>
          </section>
          <section className="mobile-groups" aria-labelledby="mobile-groups-title">
            <span id="mobile-groups-title" className="rail-section-label">
              Switch group
            </span>
            <nav className="portal-navigation-list" aria-label="Groups">
              {groups.map((group) => {
                const section = lastSectionByGroup[group.id] ?? "terminals";
                const path = groupRoute(group.id, section);
                return (
                  <a
                    key={group.id}
                    className="portal-nav-link"
                    href={path}
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
                    <Bot aria-hidden="true" size={15} />
                    <span>{group.name}</span>
                  </a>
                );
              })}
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
          <nav className="portal-navigation-list" aria-label="Portal utilities">
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
        </footer>
      </div>
    </Dialog>
  );
}
