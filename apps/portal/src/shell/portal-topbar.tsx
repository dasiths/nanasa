import { Command, Layers, Menu, Search } from "lucide-react";

export function PortalTopbar({
  onOpenCommands,
  onOpenNavigation,
}: {
  onOpenCommands(): void;
  onOpenNavigation(): void;
}) {
  return (
    <header className="portal-topbar">
      <div className="portal-product-identity">
        <button
          type="button"
          className="icon-button mobile-navigation-trigger"
          aria-label="Open application menu"
          onClick={onOpenNavigation}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <Layers size={23} aria-hidden="true" />
        <strong>
          nanasa<span>.</span>
        </strong>
        <span className="portal-product-context">Agent workspace</span>
      </div>
      <button
        type="button"
        className="portal-command-search"
        aria-label="Open command palette"
        onClick={onOpenCommands}
      >
        <Search size={15} aria-hidden="true" />
        <span>Find an entity or action</span>
        <Command size={13} aria-hidden="true" />
      </button>
    </header>
  );
}
