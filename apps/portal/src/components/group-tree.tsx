import type {
  AgentRun,
  ConfiguredAgent,
  Group,
  NanasaConfig,
  PortalSnapshot,
  ReorderGroupAgentsCommand,
  RoleDefinition,
  UpdateGroupAgentCommand,
  UpdateGroupCommand,
  UpdateRolePresentationCommand,
} from "@nanasa/contracts";
import {
  InstructionPathSchema,
  RolePresentationColorSchema,
  RolePresentationIconSchema,
} from "@nanasa/contracts";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  EllipsisVertical,
  MailWarning,
  MoveRight,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  SquareTerminal,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { copyToClipboard } from "../copy-to-clipboard.js";
import { memberStatusView } from "../member-status.js";
import { RoleIdentity } from "./role-identity.js";

export interface AddAgentInput {
  groupId: string;
  name: string;
  integrationId: string;
  roleId?: string;
  instructions: string[];
}

interface GroupTreeProps {
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  repositoryNavigation?: ReactNode;
  utilities?: ReactNode;
  selectedGroupId?: string;
  unreadCounts: ReadonlyMap<string, number>;
  busyAction?: string;
  onSelectGroup(groupId: string): void;
  onOpenMessages?(groupId: string): void;
  onCreateGroup(name: string, instructions: string[]): Promise<void>;
  onRenameGroup(groupId: string, name: string): Promise<void>;
  onUpdateGroup?(groupId: string, command: UpdateGroupCommand): Promise<void>;
  onDeleteGroup(groupId: string): Promise<void>;
  onAddAgent(input: AddAgentInput): Promise<void>;
  onRenameAgent(groupId: string, agentId: string, name: string): Promise<void>;
  onUpdateAgent?(groupId: string, agentId: string, command: UpdateGroupAgentCommand): Promise<void>;
  onUpdateRolePresentation?(roleId: string, command: UpdateRolePresentationCommand): Promise<void>;
  onReorderAgents?(groupId: string, command: ReorderGroupAgentsCommand): Promise<void>;
  onReorderGroups?(groupIds: string[], expectedOrderRevision: number): Promise<void>;
  onReparentAgent?(sourceGroupId: string, agentId: string, targetGroupId: string): Promise<void>;
  onRemoveAgent(groupId: string, agentId: string): Promise<void>;
  onStartRun(groupId: string, agentId: string): Promise<void>;
  onStopRun(groupId: string, agentId: string): Promise<void>;
  onOpenConsole(): void;
}

type EditTarget =
  | { kind: "group"; groupId: string; name: string }
  | { kind: "agent"; groupId: string; agentId: string; name: string };

type DestructiveTarget =
  | {
      kind: "group";
      groupId: string;
      name: string;
      memberCount: number;
      runCount: number;
      messageCount: number;
    }
  | { kind: "agent"; groupId: string; agentId: string; name: string };

interface ActionMenuProps {
  label: string;
  itemCount: number;
  triggerId?: string;
  children: ReactNode;
}

function ActionMenu({ label, itemCount, triggerId, children }: ActionMenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  const close = (restoreFocus = false) => {
    setPosition(undefined);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const open = () => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const bounds = trigger.getBoundingClientRect();
    const width = 208;
    const estimatedHeight = Math.min(itemCount * 38 + 10, window.innerHeight - 16);
    setPosition({
      left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
      top:
        bounds.bottom + 4 + estimatedHeight <= window.innerHeight - 8
          ? bounds.bottom + 4
          : Math.max(8, bounds.top - estimatedHeight - 4),
    });
  };

  useEffect(() => {
    if (position === undefined) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    const closeOnViewportChange = () => close();
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [position]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div className="action-menu-anchor">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="icon-button row-action-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={position !== undefined}
        aria-controls={position === undefined ? undefined : menuId}
        title={label}
        onClick={() => (position === undefined ? open() : close())}
      >
        <EllipsisVertical aria-hidden="true" size={16} />
      </button>
      {position !== undefined &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="row-action-menu"
            style={position}
            onClick={(event) => {
              if ((event.target as Element).closest("button") !== null) close();
            }}
            onKeyDown={moveFocus}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

function parseInstructionPaths(value: string): string[] {
  const paths = value
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Instruction paths must be unique");
  }
  return InstructionPathSchema.array().max(32).parse(paths);
}

function instructionPathText(paths: readonly string[]): string {
  return paths.join("\n");
}

function roleOptions(config: NanasaConfig) {
  return Object.entries(config.roles ?? {}).map(([roleId, role]) => (
    <option key={roleId} value={roleId}>
      {role.name} ({roleId})
    </option>
  ));
}

function InlineRename({
  label,
  initialValue,
  onCancel,
  onRestoreFocus,
  onSave,
}: {
  label: string;
  initialValue: string;
  onCancel(): void;
  onRestoreFocus(): void;
  onSave(value: string): Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const close = () => {
    onCancel();
    requestAnimationFrame(onRestoreFocus);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSave(value);
      close();
    } catch (error) {
      submittingRef.current = false;
      setSubmitting(false);
      throw error;
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && !submittingRef.current) {
      event.preventDefault();
      close();
    }
  };

  return (
    <form className="inline-rename" onSubmit={(event) => void submit(event).catch(() => undefined)}>
      <input
        aria-label={label}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        required
        autoFocus
        disabled={submitting}
      />
      <button
        type="submit"
        className="icon-button"
        aria-label={`Save ${label}`}
        title="Save"
        disabled={submitting}
      >
        <Check aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Cancel ${label}`}
        title="Cancel"
        disabled={submitting}
        onClick={close}
      >
        <X aria-hidden="true" size={14} />
      </button>
    </form>
  );
}

function ConfirmRemovalDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: DestructiveTarget;
  busy: boolean;
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `confirm-${target.kind}-removal-title`;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="confirmation-dialog-body">
        <h2 id={titleId}>
          {target.kind === "group" ? `Delete ${target.name}?` : `Remove ${target.name}?`}
        </h2>
        <p>
          {target.kind === "group"
            ? `${target.runCount} runs will stop before ${target.memberCount} agents and ${target.messageCount} messages are deleted with this group. Event history remains.`
            : "This agent run will stop, queued deliveries will be revoked, and the agent will be removed from the group."}
        </p>
        <div className="confirmation-actions">
          <button type="button" className="compact-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="compact-button danger-button"
            disabled={busy}
            onClick={() =>
              void onConfirm()
                .then(onCancel)
                .catch(() => undefined)
            }
          >
            <Trash2 aria-hidden="true" size={15} />
            {target.kind === "group" ? "Delete group" : "Remove agent"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function ReparentAgentDialog({
  name,
  sourceGroupId,
  groups,
  busy,
  onClose,
  onMove,
}: {
  name: string;
  sourceGroupId: string;
  groups: readonly Group[];
  busy: boolean;
  onClose(): void;
  onMove(targetGroupId: string): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const targets = groups.filter((group) => group.id !== sourceGroupId);
  const [targetGroupId, setTargetGroupId] = useState(targets[0]?.id ?? "");
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);
  return (
    <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby="reparent-agent-title">
      <form
        className="confirmation-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void onMove(targetGroupId)
            .then(onClose)
            .catch(() => undefined);
        }}
      >
        <h2 id="reparent-agent-title">Move {name}?</h2>
        <p>The stopped agent keeps its stable ID and history. Live agents cannot be moved.</p>
        <label>
          Target group
          <select value={targetGroupId} onChange={(event) => setTargetGroupId(event.target.value)}>
            {targets.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <div className="confirmation-actions">
          <button type="button" className="compact-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="compact-button"
            disabled={busy || targetGroupId.length === 0}
          >
            <MoveRight aria-hidden="true" size={15} /> Move agent
          </button>
        </div>
      </form>
    </dialog>
  );
}

const activeRecoveryPhases = new Set(["reconciling", "resuming", "restarting"]);

function runAction(run: AgentRun | undefined): "start" | "stop" | "retry" | "none" {
  if (run === undefined) return "start";
  if (run.desiredState === "stopped") {
    return run.status === "stopped" || run.status === "failed" ? "start" : "stop";
  }
  if (activeRecoveryPhases.has(run.recoveryPhase)) return "stop";
  if (
    run.recoveryPhase === "failed" ||
    (run.desiredState === "running" && (run.status === "failed" || run.status === "stopped"))
  ) {
    return "retry";
  }
  return run.status === "running" || run.status === "starting" || run.status === "stopping"
    ? "stop"
    : "none";
}

function CreateGroupForm({
  onCreate,
}: {
  onCreate(name: string, instructions: string[]): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onCreate(name, parseInstructionPaths(instructions));
      setName("");
      setInstructions("");
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create group");
    }
  };

  return (
    <form className="rail-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor="new-group-name">Group name</label>
      <div className="inline-field">
        <input
          id="new-group-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Backend team"
          required
        />
        <button
          type="submit"
          className="icon-button"
          aria-label="Create group"
          title="Create group"
        >
          <Plus aria-hidden="true" size={16} />
        </button>
      </div>
      <label htmlFor="new-group-instructions">Group instruction files</label>
      <textarea
        id="new-group-instructions"
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        rows={3}
        placeholder=".nanasa/instructions/groups/backend.md"
      />
      {error !== undefined && <p className="form-error">{error}</p>}
    </form>
  );
}

function GroupSettingsDialog({
  group,
  instructions,
  onClose,
  onUpdate,
}: {
  group: Group;
  instructions: readonly string[];
  onClose(): void;
  onUpdate(command: UpdateGroupCommand): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(group.name);
  const [instructionText, setInstructionText] = useState(instructionPathText(instructions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onUpdate({ name, instructions: parseInstructionPaths(instructionText) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update group settings");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog agent-settings-dialog"
      aria-labelledby="group-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form className="confirmation-dialog-body" onSubmit={(event) => void submit(event)}>
        <header className="agent-settings-heading">
          <div>
            <span className="eyebrow">Group settings</span>
            <h2 id="group-settings-title">{group.name}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close group settings"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <label>
          Group name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Group instruction files
          <textarea
            value={instructionText}
            onChange={(event) => setInstructionText(event.target.value)}
            rows={4}
            placeholder=".nanasa/instructions/groups/backend.md"
          />
        </label>
        {error !== undefined && <p className="form-error">{error}</p>}
        <button type="submit" className="compact-button" disabled={busy}>
          <Check aria-hidden="true" size={15} />
          {busy ? "Saving..." : "Save group"}
        </button>
      </form>
    </dialog>
  );
}

function RolePresentationSection({
  roleId,
  role,
  onUpdate,
}: {
  roleId: string;
  role: RoleDefinition;
  onUpdate(command: UpdateRolePresentationCommand): Promise<void>;
}) {
  const [icon, setIcon] = useState(role.presentation?.icon ?? "briefcase-business");
  const [color, setColor] = useState(role.presentation?.color ?? "slate");
  const [shortName, setShortName] = useState(role.presentation?.shortName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onUpdate({
        icon,
        color,
        ...(shortName.trim() === "" ? {} : { shortName: shortName.trim() }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update role presentation");
    } finally {
      setBusy(false);
    }
  };

  const previewRole: RoleDefinition = {
    ...role,
    presentation: {
      icon,
      color,
      ...(shortName.trim() === "" ? {} : { shortName: shortName.trim() }),
    },
  };

  return (
    <form
      className="agent-settings-section role-settings-section"
      onSubmit={(event) => void submit(event)}
    >
      <div className="role-settings-title">
        <div>
          <h3>{role.name}</h3>
          <code>{roleId}</code>
        </div>
        <RoleIdentity role={previewRole} />
      </div>
      <div className="role-settings-grid">
        <label>
          Icon
          <select
            value={icon}
            onChange={(event) => setIcon(RolePresentationIconSchema.parse(event.target.value))}
          >
            {RolePresentationIconSchema.options.map((option) => (
              <option key={option} value={option}>
                {option.replaceAll("-", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Color
          <select
            value={color}
            onChange={(event) => setColor(RolePresentationColorSchema.parse(event.target.value))}
          >
            {RolePresentationColorSchema.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Compact name
          <input
            value={shortName}
            maxLength={24}
            placeholder={role.name}
            onChange={(event) => setShortName(event.target.value)}
          />
        </label>
      </div>
      {error !== undefined && <p className="form-error">{error}</p>}
      <button type="submit" className="compact-button" disabled={busy}>
        <Check aria-hidden="true" size={15} />
        {busy ? "Saving..." : `Save ${role.name}`}
      </button>
    </form>
  );
}

function RoleSettingsDialog({
  roles,
  onClose,
  onUpdate,
}: {
  roles: NanasaConfig["roles"];
  onClose(): void;
  onUpdate(roleId: string, command: UpdateRolePresentationCommand): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog agent-settings-dialog"
      aria-labelledby="role-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="confirmation-dialog-body">
        <header className="agent-settings-heading">
          <div>
            <span className="eyebrow">Portal identity</span>
            <h2 id="role-settings-title">Role presentation</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close role settings"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {Object.entries(roles).map(([roleId, role]) => (
          <RolePresentationSection
            key={roleId}
            roleId={roleId}
            role={role}
            onUpdate={(command) => onUpdate(roleId, command)}
          />
        ))}
      </div>
    </dialog>
  );
}

function AgentSettingsDialog({
  groupId,
  agentId,
  agent,
  config,
  onClose,
  onUpdate,
}: {
  groupId: string;
  agentId: string;
  agent: ConfiguredAgent;
  config: NanasaConfig;
  onClose(): void;
  onUpdate(command: UpdateGroupAgentCommand): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(agent.name);
  const [integrationId, setIntegrationId] = useState(agent.integrationId);
  const [roleId, setRoleId] = useState(agent.roleId ?? "");
  const [instructions, setInstructions] = useState(instructionPathText(agent.instructions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inheritedInstructions = [
    ...config.instructions.map((path) => ({ source: "Global", path })),
    ...(config.groups[groupId]?.instructions ?? []).map((path) => ({
      source: "Group",
      path,
    })),
    ...(roleId === "" ? [] : (config.roles[roleId]?.instructions ?? [])).map((path) => ({
      source: `Role · ${config.roles[roleId]?.name ?? roleId}`,
      path,
    })),
  ];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onUpdate({
        name,
        integrationId,
        roleId: roleId === "" ? null : roleId,
        instructions: parseInstructionPaths(instructions),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update agent settings");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog agent-settings-dialog"
      aria-labelledby="agent-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form className="confirmation-dialog-body" onSubmit={(event) => void submit(event)}>
        <header className="agent-settings-heading">
          <div>
            <span className="eyebrow">Agent settings</span>
            <h2 id="agent-settings-title">{agent.name}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close agent settings"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <section className="agent-settings-section inherited-instructions-section">
          <h3>Inherited instruction files</h3>
          <ul className="instruction-layer-list">
            {inheritedInstructions.map(({ source, path }) => (
              <li key={`${source}:${path}`}>
                <span>{source}</span>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </section>
        <section className="agent-settings-section">
          <h3>Agent</h3>
          <div className="form-row form-row-split">
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              Integration
              <select
                value={integrationId}
                onChange={(event) => setIntegrationId(event.target.value)}
              >
                {Object.entries(config.integrations).map(([id, integration]) => (
                  <option key={id} value={id}>
                    {integration.name} ({id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Role
            <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              <option value="">Unassigned</option>
              {roleOptions(config)}
            </select>
          </label>
          <label>
            Agent instruction files
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={3}
            />
          </label>
          {instructions === "" && (
            <small className="instruction-empty-state">
              No agent-specific instruction files configured
            </small>
          )}
          <dl className="agent-settings-identifiers">
            <div>
              <dt>Member ID</dt>
              <dd>
                <code>{agent.memberId}</code>
              </dd>
            </div>
            <div>
              <dt>
                Agent ID <span>Internal</span>
              </dt>
              <dd>
                <code>{agentId}</code>
              </dd>
            </div>
          </dl>
          {error !== undefined && <p className="form-error">{error}</p>}
          <button type="submit" className="compact-button" disabled={busy}>
            <Check aria-hidden="true" size={15} />
            {busy ? "Saving..." : "Save agent"}
          </button>
        </section>
      </form>
    </dialog>
  );
}

function AddAgentDialog({
  group,
  config,
  onAdd,
  onClose,
}: {
  group: Group;
  config: NanasaConfig;
  onAdd(input: AddAgentInput): Promise<void>;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const integrations = Object.entries(config.integrations);
  const [name, setName] = useState("");
  const [integrationId, setIntegrationId] = useState(integrations[0]?.[0] ?? "");
  const [roleId, setRoleId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onAdd({
        groupId: group.id,
        name,
        integrationId,
        instructions: parseInstructionPaths(instructions),
        ...(roleId === "" ? {} : { roleId }),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add agent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirmation-dialog agent-settings-dialog"
      aria-labelledby="add-agent-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form className="confirmation-dialog-body" onSubmit={(event) => void submit(event)}>
        <header className="agent-settings-heading">
          <div>
            <span className="eyebrow">{group.name}</span>
            <h2 id="add-agent-title">Add agent</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close Add agent"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="form-row form-row-split">
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Integration
            <select
              value={integrationId}
              onChange={(event) => setIntegrationId(event.target.value)}
            >
              {integrations.map(([id, integration]) => (
                <option key={id} value={id}>
                  {integration.name} ({id})
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Role
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">Unassigned</option>
            {roleOptions(config)}
          </select>
        </label>
        <label>
          Agent instruction files
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            placeholder=".nanasa/instructions/agents/reviewer.md"
          />
        </label>
        <button type="submit" className="compact-button" disabled={busy}>
          <UserPlus aria-hidden="true" size={15} />
          {busy ? "Adding..." : "Add agent"}
        </button>
        {error !== undefined && <p className="form-error">{error}</p>}
      </form>
    </dialog>
  );
}

export function GroupTree({
  snapshot,
  config,
  repositoryNavigation,
  utilities,
  selectedGroupId,
  busyAction,
  onSelectGroup,
  onOpenMessages,
  onCreateGroup,
  onRenameGroup,
  onUpdateGroup,
  onDeleteGroup,
  onAddAgent,
  onRenameAgent,
  onUpdateAgent,
  onUpdateRolePresentation,
  onReorderAgents,
  onReorderGroups,
  onReparentAgent,
  onRemoveAgent,
  onStartRun,
  onStopRun,
  onOpenConsole,
}: GroupTreeProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(selectedGroupId === undefined ? [] : [selectedGroupId]),
  );
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showRoleSettings, setShowRoleSettings] = useState(false);
  const [settingsGroupId, setSettingsGroupId] = useState<string>();
  const [editTarget, setEditTarget] = useState<EditTarget>();
  const [settingsTarget, setSettingsTarget] = useState<{
    groupId: string;
    agentId: string;
  }>();
  const [destructiveTarget, setDestructiveTarget] = useState<DestructiveTarget>();
  const [reparentTarget, setReparentTarget] = useState<{
    sourceGroupId: string;
    agentId: string;
    name: string;
  }>();
  const [statusPopover, setStatusPopover] = useState<{
    membershipId: string;
    left: number;
    top: number;
  }>();
  const failedRecipientsByGroup = new Map(
    (snapshot.messageGroups ?? []).map(
      (state) => [state.groupId, new Set(state.failedRecipientMemberIds)] as const,
    ),
  );
  const settingsAgent =
    settingsTarget === undefined
      ? undefined
      : config.groups[settingsTarget.groupId]?.agents[settingsTarget.agentId];

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const toggleStatusPopover = (membershipId: string, element: HTMLElement) => {
    if (statusPopover?.membershipId === membershipId) {
      setStatusPopover(undefined);
      return;
    }
    const bounds = element.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const opensRight = bounds.right + 8 + width <= window.innerWidth - 8;
    setStatusPopover({
      membershipId,
      left: opensRight ? bounds.right + 8 : Math.max(8, window.innerWidth - width - 8),
      top: Math.max(8, Math.min(bounds.top, window.innerHeight - 300)),
    });
  };

  useEffect(() => {
    const active = statusPopover;
    if (active === undefined) return;
    const trigger = document.getElementById(`member-status-trigger-${active.membershipId}`);
    const popover = document.getElementById(`member-status-${active.membershipId}`);
    const frame = requestAnimationFrame(() => popover?.focus());
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger?.contains(target) || popover?.contains(target)) return;
      setStatusPopover(undefined);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setStatusPopover(undefined);
      requestAnimationFrame(() => trigger?.focus());
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [statusPopover]);

  return (
    <>
      <div className="rail-heading">
        <div>
          <span className="eyebrow">Operations</span>
          <strong className="brand">Nanasa</strong>
        </div>
        <div className="rail-heading-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Role settings"
            title="Role settings"
            onClick={() => setShowRoleSettings(true)}
          >
            <Palette aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Create group"
            title="Create group"
            onClick={() => setShowCreateGroup((visible) => !visible)}
          >
            <Plus aria-hidden="true" size={17} />
          </button>
        </div>
      </div>
      {showCreateGroup && <CreateGroupForm onCreate={onCreateGroup} />}
      {repositoryNavigation}
      <nav className="group-tree" aria-label="Group tree">
        {snapshot.groups.length === 0 && (
          <div className="empty-state compact-empty">
            <p>No groups yet.</p>
            <button type="button" onClick={() => setShowCreateGroup(true)}>
              Create the first group
            </button>
          </div>
        )}
        {snapshot.groups.map((group, groupIndex) => {
          const agents = Object.entries(config.groups[group.id]?.agents ?? {})
            .map(([agentId, agent], index) => ({ agentId, agent, index }))
            .sort(
              (left, right) =>
                (left.agent.order ?? left.index) - (right.agent.order ?? right.index),
            )
            .flatMap(({ agentId, agent }) => {
              const member = snapshot.memberships.find(
                (candidate) =>
                  candidate.groupId === group.id &&
                  candidate.state === "active" &&
                  (candidate.agentProfileId === agentId || candidate.memberId === agent.memberId),
              );
              return member === undefined ? [] : [{ agentId, agent, member }];
            });
          const expanded = expandedGroups.has(group.id);
          return (
            <div className="tree-group" key={group.id}>
              <div className={`tree-group-row ${selectedGroupId === group.id ? "selected" : ""}`}>
                <button
                  type="button"
                  className="tree-toggle"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.id)}
                >
                  {expanded ? (
                    <ChevronDown aria-hidden="true" size={16} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={16} />
                  )}
                </button>
                {editTarget?.kind === "group" && editTarget.groupId === group.id ? (
                  <InlineRename
                    label={`group name for ${group.name}`}
                    initialValue={editTarget.name}
                    onCancel={() => setEditTarget(undefined)}
                    onRestoreFocus={() =>
                      document.getElementById(`group-actions-${group.id}`)?.focus()
                    }
                    onSave={(name) => onRenameGroup(group.id, name)}
                  />
                ) : (
                  <button
                    type="button"
                    className="tree-select"
                    aria-current={selectedGroupId === group.id ? "page" : undefined}
                    onClick={() => {
                      onSelectGroup(group.id);
                      setExpandedGroups((current) => new Set(current).add(group.id));
                    }}
                  >
                    <span>{group.name}</span>
                    <span className="tree-count">{agents.length}</span>
                  </button>
                )}
                {editTarget?.groupId !== group.id && (
                  <ActionMenu
                    label={`Actions for group ${group.name}`}
                    itemCount={6}
                    triggerId={`group-actions-${group.id}`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="action-menu-item"
                      aria-label={`Add agent to ${group.name}`}
                      onClick={() => {
                        onSelectGroup(group.id);
                        setShowAddAgent(true);
                      }}
                    >
                      <UserPlus aria-hidden="true" size={15} />
                      <span>Add agent</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="action-menu-item"
                      aria-label={`Edit group settings ${group.name}`}
                      onClick={() => setSettingsGroupId(group.id)}
                    >
                      <Settings2 aria-hidden="true" size={14} />
                      <span>Group settings</span>
                    </button>
                    <button
                      id={`rename-group-${group.id}`}
                      type="button"
                      role="menuitem"
                      className="action-menu-item"
                      aria-label={`Rename group ${group.name}`}
                      onClick={() =>
                        setEditTarget({ kind: "group", groupId: group.id, name: group.name })
                      }
                    >
                      <Pencil aria-hidden="true" size={14} />
                      <span>Rename</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="action-menu-item"
                      aria-label={`Move group ${group.name} up`}
                      disabled={groupIndex === 0 || onReorderGroups === undefined}
                      onClick={() => {
                        const groupIds = snapshot.groups.map((candidate) => candidate.id);
                        [groupIds[groupIndex - 1], groupIds[groupIndex]] = [
                          groupIds[groupIndex] as string,
                          groupIds[groupIndex - 1] as string,
                        ];
                        void onReorderGroups?.(groupIds, snapshot.orderRevision).catch(
                          () => undefined,
                        );
                      }}
                    >
                      <ArrowUp aria-hidden="true" size={14} />
                      <span>Move group up</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="action-menu-item"
                      aria-label={`Move group ${group.name} down`}
                      disabled={
                        groupIndex === snapshot.groups.length - 1 || onReorderGroups === undefined
                      }
                      onClick={() => {
                        const groupIds = snapshot.groups.map((candidate) => candidate.id);
                        [groupIds[groupIndex], groupIds[groupIndex + 1]] = [
                          groupIds[groupIndex + 1] as string,
                          groupIds[groupIndex] as string,
                        ];
                        void onReorderGroups?.(groupIds, snapshot.orderRevision).catch(
                          () => undefined,
                        );
                      }}
                    >
                      <ArrowDown aria-hidden="true" size={14} />
                      <span>Move group down</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="action-menu-item danger-action"
                      aria-label={`Delete group ${group.name}`}
                      onClick={() =>
                        setDestructiveTarget({
                          kind: "group",
                          groupId: group.id,
                          name: group.name,
                          memberCount: agents.length,
                          runCount: snapshot.runs.filter((run) => run.groupId === group.id).length,
                          messageCount:
                            snapshot.messageGroups?.find((state) => state.groupId === group.id)
                              ?.retainedMessageCount ?? 0,
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      <span>Delete group</span>
                    </button>
                  </ActionMenu>
                )}
              </div>
              {expanded && (
                <div className="tree-members">
                  {agents.length === 0 && <p className="tree-empty">No agents</p>}
                  {agents.map(({ agentId, agent, member }, agentIndex) => {
                    const {
                      run,
                      status: agentStatus,
                      key: statusKey,
                      label: statusLabel,
                    } = memberStatusView(snapshot.agentStatuses, snapshot.runs, member);
                    const deliveryFailed =
                      failedRecipientsByGroup.get(group.id)?.has(member.memberId) === true;
                    const action = runAction(run);
                    const actionKey = `${group.id}:${agentId}`;
                    const integration = config.integrations[agent.integrationId];
                    const checkout = snapshot.checkouts.find(
                      (candidate) => candidate.id === member.checkoutId,
                    );
                    const role =
                      agent.roleId === undefined ? undefined : config.roles[agent.roleId];
                    const recoveryDetail = run?.recoveryReason;
                    const statusTitle = [
                      recoveryDetail,
                      agentStatus?.blocker,
                      agentStatus?.lastProgressSummary,
                    ]
                      .filter((value): value is string => value !== undefined)
                      .join(" · ");
                    const popoverId = `member-status-${member.id}`;
                    const popoverVisible = statusPopover?.membershipId === member.id;
                    return (
                      <div className="member-row" key={agentId}>
                        <span className={`status-dot status-${statusKey}`} aria-hidden="true" />
                        {editTarget?.kind === "agent" &&
                        editTarget.groupId === group.id &&
                        editTarget.agentId === agentId ? (
                          <InlineRename
                            label={`agent name for ${agent.name}`}
                            initialValue={editTarget.name}
                            onCancel={() => setEditTarget(undefined)}
                            onRestoreFocus={() =>
                              document
                                .getElementById(`member-actions-${group.id}-${member.memberId}`)
                                ?.focus()
                            }
                            onSave={(name) => onRenameAgent(group.id, agentId, name)}
                          />
                        ) : (
                          <button
                            id={`member-status-trigger-${member.id}`}
                            type="button"
                            className="member-select"
                            aria-label={`View details for ${agent.name}, status ${statusLabel}`}
                            aria-haspopup="dialog"
                            aria-expanded={popoverVisible}
                            aria-controls={popoverVisible ? popoverId : undefined}
                            onClick={(event) => {
                              onSelectGroup(group.id);
                              toggleStatusPopover(member.id, event.currentTarget);
                            }}
                          >
                            <span>{agent.name}</span>
                            <RoleIdentity role={role} />
                            <small title={statusTitle || undefined}>
                              {statusLabel}
                              {run?.recoveryNotBefore !== undefined &&
                                ` · retry ${new Date(run.recoveryNotBefore).toLocaleTimeString()}`}
                            </small>
                          </button>
                        )}
                        {popoverVisible &&
                          createPortal(
                            <div
                              id={popoverId}
                              role="dialog"
                              aria-label={`Agent details for ${agent.name}`}
                              tabIndex={-1}
                              className="member-status-popover"
                              style={{ left: statusPopover.left, top: statusPopover.top }}
                            >
                              <div className="member-status-popover-heading">
                                <span
                                  className={`status-dot status-${statusKey}`}
                                  aria-hidden="true"
                                />
                                <strong>{agent.name}</strong>
                                <span>{statusLabel}</span>
                                <button
                                  type="button"
                                  className="icon-button status-popover-close"
                                  aria-label={`Close details for ${agent.name}`}
                                  onClick={() => {
                                    setStatusPopover(undefined);
                                    requestAnimationFrame(() =>
                                      document
                                        .getElementById(`member-status-trigger-${member.id}`)
                                        ?.focus(),
                                    );
                                  }}
                                >
                                  <X aria-hidden="true" size={14} />
                                </button>
                              </div>
                              <dl>
                                <div>
                                  <dt>Member ID</dt>
                                  <dd>{member.memberId}</dd>
                                </div>
                                <div>
                                  <dt>Integration</dt>
                                  <dd>
                                    {integration === undefined
                                      ? agent.integrationId
                                      : `${integration.name} (${agent.integrationId})`}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Kind</dt>
                                  <dd>{integration?.kind ?? "Unknown"}</dd>
                                </div>
                                <div>
                                  <dt>Role</dt>
                                  <dd>{role?.name ?? agent.roleId ?? "Unassigned"}</dd>
                                </div>
                                <div>
                                  <dt>Checkout</dt>
                                  <dd>
                                    {checkout === undefined
                                      ? "Unassigned"
                                      : `${checkout.branch ?? "detached"} · ${checkout.path}`}
                                  </dd>
                                </div>
                                <div>
                                  <dt>User-facing status</dt>
                                  <dd>{statusLabel}</dd>
                                </div>
                                {agentStatus !== undefined && (
                                  <>
                                    <div>
                                      <dt>Backend state</dt>
                                      <dd>{agentStatus.state.replaceAll("_", " ")}</dd>
                                    </div>
                                    <div>
                                      <dt>Phase</dt>
                                      <dd>{agentStatus.phase.replaceAll("_", " ")}</dd>
                                    </div>
                                    <div>
                                      <dt>Outcome</dt>
                                      <dd>{agentStatus.outcome.replaceAll("_", " ")}</dd>
                                    </div>
                                    <div>
                                      <dt>Attention</dt>
                                      <dd>{agentStatus.attention.replaceAll("_", " ")}</dd>
                                    </div>
                                    {agentStatus.progressStage !== undefined && (
                                      <div>
                                        <dt>Progress stage</dt>
                                        <dd>{agentStatus.progressStage}</dd>
                                      </div>
                                    )}
                                    <div>
                                      <dt>Confidence</dt>
                                      <dd>{agentStatus.confidence}</dd>
                                    </div>
                                    <div>
                                      <dt>Authority</dt>
                                      <dd>
                                        {agentStatus.authorityKind.replaceAll("_", " ")}
                                        {agentStatus.authorityId === undefined
                                          ? ""
                                          : ` (${agentStatus.authorityId})`}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Stale authority</dt>
                                      <dd>{agentStatus.staleAuthority ? "Yes" : "No"}</dd>
                                    </div>
                                    <div>
                                      <dt>Process state</dt>
                                      <dd>{agentStatus.processState.replaceAll("_", " ")}</dd>
                                    </div>
                                  </>
                                )}
                                {agentStatus?.lastProgressSummary !== undefined && (
                                  <div>
                                    <dt>Progress summary</dt>
                                    <dd>{agentStatus.lastProgressSummary}</dd>
                                  </div>
                                )}
                                {agentStatus?.blocker !== undefined && (
                                  <div>
                                    <dt>Blocker</dt>
                                    <dd>{agentStatus.blocker}</dd>
                                  </div>
                                )}
                                {agentStatus?.nextStep !== undefined && (
                                  <div>
                                    <dt>Next step</dt>
                                    <dd>{agentStatus.nextStep}</dd>
                                  </div>
                                )}
                                {(agentStatus?.lastActivityKind !== undefined ||
                                  agentStatus?.lastActivityAt !== undefined) && (
                                  <div>
                                    <dt>Last activity</dt>
                                    <dd>
                                      {[
                                        agentStatus.lastActivityKind?.replaceAll("_", " "),
                                        agentStatus.lastActivityAt === undefined
                                          ? undefined
                                          : new Date(agentStatus.lastActivityAt).toLocaleString(),
                                      ]
                                        .filter((value): value is string => value !== undefined)
                                        .join(" · ")}
                                    </dd>
                                  </div>
                                )}
                                {run !== undefined && (
                                  <>
                                    <div>
                                      <dt>Terminal status</dt>
                                      <dd>{run.status}</dd>
                                    </div>
                                    <div>
                                      <dt>Recovery phase</dt>
                                      <dd>{run.recoveryPhase}</dd>
                                    </div>
                                    {run.recoveryReason !== undefined && (
                                      <div>
                                        <dt>Recovery reason</dt>
                                        <dd>{run.recoveryReason}</dd>
                                      </div>
                                    )}
                                  </>
                                )}
                              </dl>
                            </div>,
                            document.body,
                          )}
                        {deliveryFailed && (
                          <button
                            type="button"
                            className="delivery-warning-button"
                            aria-label={`Open failed delivery for ${agent.name} in ${group.name}`}
                            title={`Open ${group.name} Messages for failed delivery to ${agent.name}`}
                            onClick={() =>
                              onOpenMessages === undefined
                                ? onSelectGroup(group.id)
                                : onOpenMessages(group.id)
                            }
                          >
                            <MailWarning aria-hidden="true" size={15} />
                          </button>
                        )}
                        {editTarget?.kind !== "agent" && (
                          <ActionMenu
                            label={`Actions for agent ${agent.name}`}
                            itemCount={action === "none" ? 7 : 8}
                            triggerId={`member-actions-${group.id}-${member.memberId}`}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item"
                              aria-label={`Copy member ID ${member.memberId}`}
                              onClick={() =>
                                void copyToClipboard(member.memberId).catch(() => undefined)
                              }
                            >
                              <Copy aria-hidden="true" size={14} />
                              <span>Copy member ID</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item"
                              aria-label={`Move ${agent.name} up`}
                              disabled={
                                agentIndex === 0 ||
                                onReorderAgents === undefined ||
                                busyAction === `${group.id}:reorder`
                              }
                              onClick={() => {
                                const agentIds = agents.map((candidate) => candidate.agentId);
                                [agentIds[agentIndex - 1], agentIds[agentIndex]] = [
                                  agentIds[agentIndex] as string,
                                  agentIds[agentIndex - 1] as string,
                                ];
                                void onReorderAgents?.(group.id, {
                                  agentIds,
                                  expectedOrderRevision: snapshot.orderRevision,
                                }).catch(() => undefined);
                              }}
                            >
                              <ArrowUp aria-hidden="true" size={14} />
                              <span>Move up</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item"
                              aria-label={`Move ${agent.name} down`}
                              disabled={
                                agentIndex === agents.length - 1 ||
                                onReorderAgents === undefined ||
                                busyAction === `${group.id}:reorder`
                              }
                              onClick={() => {
                                const agentIds = agents.map((candidate) => candidate.agentId);
                                [agentIds[agentIndex], agentIds[agentIndex + 1]] = [
                                  agentIds[agentIndex + 1] as string,
                                  agentIds[agentIndex] as string,
                                ];
                                void onReorderAgents?.(group.id, {
                                  agentIds,
                                  expectedOrderRevision: snapshot.orderRevision,
                                }).catch(() => undefined);
                              }}
                            >
                              <ArrowDown aria-hidden="true" size={14} />
                              <span>Move down</span>
                            </button>
                            {action !== "none" && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                aria-label={`${action === "retry" ? "Retry" : action === "stop" ? "Stop" : "Start"} ${agent.name}`}
                                disabled={busyAction === actionKey}
                                onClick={() => {
                                  const operation =
                                    action === "stop"
                                      ? onStopRun(group.id, agentId)
                                      : onStartRun(group.id, agentId);
                                  void operation.catch(() => undefined);
                                }}
                              >
                                {action === "stop" ? (
                                  <CircleStop aria-hidden="true" size={15} />
                                ) : action === "retry" ? (
                                  <RefreshCw aria-hidden="true" size={15} />
                                ) : (
                                  <Play aria-hidden="true" size={15} />
                                )}
                                <span>
                                  {action === "retry"
                                    ? "Retry recovery"
                                    : action === "stop"
                                      ? "Stop agent"
                                      : "Start agent"}
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item"
                              aria-label={`Edit agent settings ${agent.name}`}
                              onClick={() =>
                                setSettingsTarget({
                                  groupId: group.id,
                                  agentId,
                                })
                              }
                            >
                              <Settings2 aria-hidden="true" size={14} />
                              <span>Agent settings</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item"
                              aria-label={`Rename agent ${agent.name}`}
                              onClick={() =>
                                setEditTarget({
                                  kind: "agent",
                                  groupId: group.id,
                                  agentId,
                                  name: agent.name,
                                })
                              }
                            >
                              <Pencil aria-hidden="true" size={14} />
                              <span>Rename</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item"
                              aria-label={`Move ${agent.name} to another group`}
                              disabled={
                                action !== "start" ||
                                onReparentAgent === undefined ||
                                snapshot.groups.length < 2
                              }
                              onClick={() =>
                                setReparentTarget({
                                  sourceGroupId: group.id,
                                  agentId,
                                  name: agent.name,
                                })
                              }
                            >
                              <MoveRight aria-hidden="true" size={14} />
                              <span>Move to group</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item danger-action"
                              aria-label={`Remove agent ${agent.name}`}
                              onClick={() =>
                                setDestructiveTarget({
                                  kind: "agent",
                                  groupId: group.id,
                                  agentId,
                                  name: agent.name,
                                })
                              }
                            >
                              <Trash2 aria-hidden="true" size={14} />
                              <span>Remove agent</span>
                            </button>
                          </ActionMenu>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="rail-footer">
        <button type="button" className="compact-button" onClick={onOpenConsole}>
          <SquareTerminal aria-hidden="true" size={15} />
          Console
        </button>
        {utilities}
      </div>
      {destructiveTarget !== undefined && (
        <ConfirmRemovalDialog
          target={destructiveTarget}
          busy={
            busyAction ===
            (destructiveTarget.kind === "group"
              ? `${destructiveTarget.groupId}:delete`
              : `${destructiveTarget.groupId}:${destructiveTarget.agentId}:remove`)
          }
          onCancel={() => setDestructiveTarget(undefined)}
          onConfirm={() =>
            destructiveTarget.kind === "group"
              ? onDeleteGroup(destructiveTarget.groupId)
              : onRemoveAgent(destructiveTarget.groupId, destructiveTarget.agentId)
          }
        />
      )}
      {reparentTarget !== undefined && onReparentAgent !== undefined && (
        <ReparentAgentDialog
          name={reparentTarget.name}
          sourceGroupId={reparentTarget.sourceGroupId}
          groups={snapshot.groups}
          busy={busyAction === `${reparentTarget.sourceGroupId}:${reparentTarget.agentId}:reparent`}
          onClose={() => setReparentTarget(undefined)}
          onMove={(targetGroupId) =>
            onReparentAgent(reparentTarget.sourceGroupId, reparentTarget.agentId, targetGroupId)
          }
        />
      )}
      {settingsGroupId !== undefined && onUpdateGroup !== undefined && (
        <GroupSettingsDialog
          group={snapshot.groups.find((group) => group.id === settingsGroupId)!}
          instructions={config.groups[settingsGroupId]?.instructions ?? []}
          onClose={() => setSettingsGroupId(undefined)}
          onUpdate={(command) => onUpdateGroup(settingsGroupId, command)}
        />
      )}
      {showRoleSettings && onUpdateRolePresentation !== undefined && (
        <RoleSettingsDialog
          roles={config.roles}
          onClose={() => setShowRoleSettings(false)}
          onUpdate={onUpdateRolePresentation}
        />
      )}
      {showAddAgent && selectedGroupId !== undefined && (
        <AddAgentDialog
          group={snapshot.groups.find((group) => group.id === selectedGroupId)!}
          config={config}
          onAdd={onAddAgent}
          onClose={() => setShowAddAgent(false)}
        />
      )}
      {settingsTarget !== undefined &&
        settingsAgent !== undefined &&
        onUpdateAgent !== undefined && (
          <AgentSettingsDialog
            groupId={settingsTarget.groupId}
            agentId={settingsTarget.agentId}
            agent={settingsAgent}
            config={config}
            onClose={() => setSettingsTarget(undefined)}
            onUpdate={(command) =>
              onUpdateAgent(settingsTarget.groupId, settingsTarget.agentId, command)
            }
          />
        )}
    </>
  );
}
