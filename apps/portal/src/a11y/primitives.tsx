import {
  type ComponentPropsWithoutRef,
  createContext,
  type KeyboardEvent,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type Politeness = "polite" | "assertive";
type Announcement = { id: number; message: string; politeness: Politeness };

const AnnouncementContext = createContext<(message: string, politeness?: Politeness) => void>(
  () => undefined,
);

export function LiveAnnouncer({ children }: PropsWithChildren) {
  const [announcement, setAnnouncement] = useState<Announcement>({
    id: 0,
    message: "",
    politeness: "polite",
  });
  const announce = useCallback((message: string, politeness: Politeness = "polite") => {
    setAnnouncement((current) => ({ id: current.id + 1, message, politeness }));
  }, []);
  return (
    <AnnouncementContext.Provider value={announce}>
      {children}
      <div
        key={announcement.id}
        className="visually-hidden"
        role={announcement.politeness === "assertive" ? "alert" : "status"}
        aria-live={announcement.politeness}
        aria-atomic="true"
      >
        {announcement.message}
      </div>
    </AnnouncementContext.Provider>
  );
}

export function useAnnounce() {
  return useContext(AnnouncementContext);
}

export function RouteAnnouncer({ label }: { label: string }) {
  const announce = useAnnounce();
  useEffect(() => {
    announce(`${label} loaded`);
  }, [announce, label]);
  return null;
}

export function SkipLink({ target = "portal-content" }: { target?: string }) {
  return (
    <a className="skip-link" href={`#${target}`}>
      Skip to main content
    </a>
  );
}

export function useFocusReturn(open: boolean) {
  const originRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      originRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    originRef.current?.focus();
    originRef.current = null;
  }, [open]);
}

export function useRovingFocus<T extends HTMLElement>(
  orientation: "horizontal" | "vertical" = "vertical",
) {
  const containerRef = useRef<T>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      const items = [
        ...(containerRef.current?.querySelectorAll<HTMLElement>("[data-roving-item]") ?? []),
      ].filter(
        (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
      );
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      if (items.length === 0 || activeIndex < 0) return;
      const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
      const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      let nextIndex: number | undefined;
      if (event.key === previousKey) nextIndex = (activeIndex - 1 + items.length) % items.length;
      if (event.key === nextKey) nextIndex = (activeIndex + 1) % items.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      items[nextIndex]?.focus();
    },
    [orientation],
  );
  return { containerRef, onKeyDown };
}

export function Dialog({
  open,
  labelledBy,
  onClose,
  children,
  className = "confirmation-dialog",
  closeOnBackdrop = false,
}: PropsWithChildren<{
  open: boolean;
  labelledBy: string;
  onClose(): void;
  className?: string;
  closeOnBackdrop?: boolean;
}>) {
  const ref = useRef<HTMLDialogElement>(null);
  useFocusReturn(open);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

export function Menu(props: ComponentPropsWithoutRef<"div">) {
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();
  return <div {...props} ref={containerRef} role="menu" onKeyDown={onKeyDown} />;
}

export function MenuItem(props: ComponentPropsWithoutRef<"button">) {
  return <button {...props} data-roving-item="" type="button" role="menuitem" />;
}

export function TabList(props: ComponentPropsWithoutRef<"div">) {
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>("horizontal");
  return <div {...props} ref={containerRef} role="tablist" onKeyDown={onKeyDown} />;
}

export function Tab(props: ComponentPropsWithoutRef<"button">) {
  return <button {...props} data-roving-item="" type="button" role="tab" />;
}
