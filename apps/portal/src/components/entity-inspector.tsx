import { ArrowLeft, type LucideIcon, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import "./entity-workspace.css";

export function EntityInspector({
  title,
  context,
  icon: Icon,
  children,
  onClose,
  actions,
}: {
  title: string;
  context?: string;
  icon?: LucideIcon;
  children: ReactNode;
  onClose(): void;
  actions?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (
        origin.current?.isConnected &&
        (document.activeElement === document.body || document.activeElement === heading.current)
      )
        origin.current.focus({ preventScroll: true });
    };
  }, []);
  const close = () => {
    const target = origin.current;
    onClose();
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  };
  return (
    <aside className="entity-inspector" aria-labelledby={titleId}>
      <button type="button" className="entity-detail-back" onClick={close}>
        <ArrowLeft size={15} aria-hidden="true" />
        Back to list
      </button>
      <header className="entity-inspector-heading">
        {Icon && (
          <span className="entity-glyph">
            <Icon size={20} aria-hidden="true" />
          </span>
        )}
        <div>
          {context && <span className="eyebrow">{context}</span>}
          <h2 ref={heading} id={titleId} tabIndex={-1}>
            {title}
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close details"
          title="Close details"
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {actions && <div className="entity-inspector-actions">{actions}</div>}
      {children}
    </aside>
  );
}

export function EntitySection({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="entity-section">
      <header>
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function EntityTabs({
  label,
  tabs,
  selected,
  onSelect,
}: {
  label: string;
  tabs: readonly string[];
  selected: string;
  onSelect(tab: string): void;
}) {
  return (
    <nav className="entity-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab}
          aria-current={selected === tab ? "page" : undefined}
          onClick={() => onSelect(tab)}
        >
          {tab}
        </button>
      ))}
    </nav>
  );
}
