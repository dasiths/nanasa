import type {
  AgentProfile,
  AgentRun,
  ConfiguredAgentProfile,
  ConfiguredMembership,
  Group,
  GroupMembership,
  NanasaConfig,
  PortalSnapshot,
  UpdateAgentProfileCommand,
  UpdateGroupCommand,
  UpdateGroupMembershipCommand,
} from "@nanasa/contracts";
import { InstructionPathSchema } from "@nanasa/contracts";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Copy,
  EllipsisVertical,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings2,
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

export interface AddAgentInput {
  groupId: string;
  alias: string;
  profileId?: string;
  newProfile?: {
    name: string;
    agentType: string;
    defaultRoleId?: string;
    instructions: string[];
  };
  roleId?: string;
  instructions: string[];
}

interface GroupTreeProps {
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  selectedGroupId?: string;
  unreadCounts: ReadonlyMap<string, number>;
  busyAction?: string;
  onSelectGroup(groupId: string): void;
  onCreateGroup(name: string, instructions: string[]): Promise<void>;
  onRenameGroup(groupId: string, name: string): Promise<void>;
  onUpdateGroup?(groupId: string, command: UpdateGroupCommand): Promise<void>;
  onDeleteGroup(groupId: string): Promise<void>;
  onAddAgent(input: AddAgentInput): Promise<void>;
  onRenameAgent(groupId: string, memberId: string, alias: string): Promise<void>;
  onUpdateAgent?(
    groupId: string,
    memberId: string,
    command: UpdateGroupMembershipCommand,
  ): Promise<void>;
  onUpdateAgentProfile?(profileId: string, command: UpdateAgentProfileCommand): Promise<void>;
  onRemoveAgent(groupId: string, memberId: string): Promise<void>;
  onStartRun(groupId: string, memberId: string): Promise<void>;
  onStopRun(groupId: string, memberId: string): Promise<void>;
}

type EditTarget =
  | { kind: "group"; groupId: string; name: string }
  | { kind: "member"; groupId: string; memberId: string; name: string };

type DestructiveTarget =
  | {
      kind: "group";
      groupId: string;
      name: string;
      memberCount: number;
      runCount: number;
      messageCount: number;
    }
  | { kind: "member"; groupId: string; memberId: string; name: string };

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
            ? `${target.runCount} runs will stop before ${target.memberCount} memberships and ${target.messageCount} messages are deleted with this group. Reusable agent profiles and event history remain.`
            : "This agent run will stop, queued deliveries will be revoked, and the membership will be removed. Its reusable agent profile remains available."}
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

function AgentSettingsDialog({
  member,
  profile,
  configuredMember,
  configuredProfile,
  config,
  onClose,
  onUpdateMember,
  onUpdateProfile,
}: {
  member: GroupMembership;
  profile: AgentProfile;
  configuredMember: ConfiguredMembership | undefined;
  configuredProfile: ConfiguredAgentProfile | undefined;
  config: NanasaConfig;
  onClose(): void;
  onUpdateMember(command: UpdateGroupMembershipCommand): Promise<void>;
  onUpdateProfile(command: UpdateAgentProfileCommand): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [alias, setAlias] = useState(member.alias);
  const [roleId, setRoleId] = useState(configuredMember?.roleId ?? "");
  const [memberInstructions, setMemberInstructions] = useState(
    instructionPathText(configuredMember?.instructions ?? []),
  );
  const [profileName, setProfileName] = useState(configuredProfile?.name ?? profile.name);
  const [defaultRoleId, setDefaultRoleId] = useState(configuredProfile?.defaultRoleId ?? "");
  const [profileInstructions, setProfileInstructions] = useState(
    instructionPathText(configuredProfile?.instructions ?? []),
  );
  const [memberBusy, setMemberBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [memberError, setMemberError] = useState<string>();
  const [profileError, setProfileError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const saveMember = async (event: FormEvent) => {
    event.preventDefault();
    setMemberBusy(true);
    setMemberError(undefined);
    try {
      await onUpdateMember({
        alias,
        roleId: roleId === "" ? null : roleId,
        instructions: parseInstructionPaths(memberInstructions),
      });
    } catch (cause) {
      setMemberError(cause instanceof Error ? cause.message : "Unable to update member settings");
    } finally {
      setMemberBusy(false);
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setProfileBusy(true);
    setProfileError(undefined);
    try {
      await onUpdateProfile({
        name: profileName,
        defaultRoleId: defaultRoleId === "" ? null : defaultRoleId,
        instructions: parseInstructionPaths(profileInstructions),
      });
    } catch (cause) {
      setProfileError(cause instanceof Error ? cause.message : "Unable to update profile defaults");
    } finally {
      setProfileBusy(false);
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
      <div className="confirmation-dialog-body">
        <header className="agent-settings-heading">
          <div>
            <span className="eyebrow">Agent settings</span>
            <h2 id="agent-settings-title">{member.alias}</h2>
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
        <form className="agent-settings-section" onSubmit={(event) => void saveMember(event)}>
          <h3>Membership</h3>
          <div className="form-row form-row-split">
            <label>
              Member alias
              <input value={alias} onChange={(event) => setAlias(event.target.value)} required />
            </label>
            <label>
              Role override
              <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                <option value="">
                  Profile default
                  {configuredProfile?.defaultRoleId === undefined
                    ? " or unassigned"
                    : ` (${config.roles[configuredProfile.defaultRoleId]?.name ?? configuredProfile.defaultRoleId})`}
                </option>
                {roleOptions(config)}
              </select>
            </label>
          </div>
          <label>
            Assignment instruction files
            <textarea
              value={memberInstructions}
              onChange={(event) => setMemberInstructions(event.target.value)}
              rows={3}
              placeholder=".nanasa/instructions/memberships/reviewer.md"
            />
          </label>
          {memberError !== undefined && <p className="form-error">{memberError}</p>}
          <button type="submit" className="compact-button" disabled={memberBusy}>
            <Check aria-hidden="true" size={15} />
            {memberBusy ? "Saving..." : "Save membership"}
          </button>
        </form>
        <form className="agent-settings-section" onSubmit={(event) => void saveProfile(event)}>
          <h3>Reusable profile</h3>
          <div className="form-row form-row-split">
            <label>
              Profile name
              <input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                required
              />
            </label>
            <label>
              Default role
              <select
                value={defaultRoleId}
                onChange={(event) => setDefaultRoleId(event.target.value)}
              >
                <option value="">Unassigned</option>
                {roleOptions(config)}
              </select>
            </label>
          </div>
          <label>
            Profile instruction files
            <textarea
              value={profileInstructions}
              onChange={(event) => setProfileInstructions(event.target.value)}
              rows={3}
              placeholder=".nanasa/instructions/profiles/copilot.md"
            />
          </label>
          {profileError !== undefined && <p className="form-error">{profileError}</p>}
          <button type="submit" className="compact-button" disabled={profileBusy}>
            <Check aria-hidden="true" size={15} />
            {profileBusy ? "Saving..." : "Save profile"}
          </button>
        </form>
      </div>
    </dialog>
  );
}

function AddAgentForm({
  group,
  profiles,
  config,
  onAdd,
}: {
  group: Group;
  profiles: AgentProfile[];
  config: NanasaConfig;
  onAdd(input: AddAgentInput): Promise<void>;
}) {
  const [creatingProfile, setCreatingProfile] = useState(profiles.length === 0);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [alias, setAlias] = useState("");
  const [profileName, setProfileName] = useState("");
  const agentTypes = Object.values(config.agentTypes);
  const [agentType, setAgentType] = useState(agentTypes[0]?.key ?? "");
  const [roleId, setRoleId] = useState("");
  const [defaultRoleId, setDefaultRoleId] = useState("");
  const [profileInstructions, setProfileInstructions] = useState("");
  const [memberInstructions, setMemberInstructions] = useState("");
  const [error, setError] = useState<string>();
  const selectedProfileId = profileId || profiles[0]?.id || "";
  const selectedProfileDefaultRole = config.agentProfiles[selectedProfileId]?.defaultRoleId;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onAdd({
        groupId: group.id,
        alias,
        instructions: parseInstructionPaths(memberInstructions),
        ...(roleId === "" ? {} : { roleId }),
        ...(creatingProfile
          ? {
              newProfile: {
                name: profileName,
                agentType,
                instructions: parseInstructionPaths(profileInstructions),
                ...(defaultRoleId === "" ? {} : { defaultRoleId }),
              },
            }
          : { profileId: selectedProfileId }),
      });
      setAlias("");
      setProfileName("");
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add agent");
    }
  };

  return (
    <form className="agent-form" onSubmit={(event) => void submit(event)}>
      <div className="form-row form-row-split">
        <label>
          Member alias
          <input value={alias} onChange={(event) => setAlias(event.target.value)} required />
        </label>
        <label>
          Profile source
          <select
            value={creatingProfile ? "new" : "existing"}
            onChange={(event) => setCreatingProfile(event.target.value === "new")}
          >
            {profiles.length > 0 && <option value="existing">Existing profile</option>}
            <option value="new">New profile</option>
          </select>
        </label>
      </div>
      {creatingProfile ? (
        <>
          <div className="form-row form-row-split">
            <label>
              Profile name
              <input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                required
              />
            </label>
            <label>
              Agent type
              <select value={agentType} onChange={(event) => setAgentType(event.target.value)}>
                {agentTypes.map((configuredType) => (
                  <option key={configuredType.key} value={configuredType.key}>
                    {configuredType.name} ({configuredType.key})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Profile default role
            <select
              value={defaultRoleId}
              onChange={(event) => setDefaultRoleId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {roleOptions(config)}
            </select>
          </label>
          <label>
            Profile instruction files
            <textarea
              value={profileInstructions}
              onChange={(event) => setProfileInstructions(event.target.value)}
              rows={3}
              placeholder=".nanasa/instructions/profiles/copilot.md"
            />
          </label>
        </>
      ) : (
        <label>
          Agent profile
          <select value={selectedProfileId} onChange={(event) => setProfileId(event.target.value)}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({config.agentTypes[profile.agentType]?.name ?? profile.agentType};{" "}
                {profile.agentType})
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Role override
        <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          <option value="">
            {creatingProfile
              ? defaultRoleId === ""
                ? "Profile default: unassigned"
                : `Profile default: ${config.roles[defaultRoleId]?.name ?? defaultRoleId}`
              : selectedProfileDefaultRole === undefined
                ? "Profile default: unassigned"
                : `Profile default: ${config.roles[selectedProfileDefaultRole]?.name ?? selectedProfileDefaultRole}`}
          </option>
          {roleOptions(config)}
        </select>
      </label>
      <label>
        Assignment instruction files
        <textarea
          value={memberInstructions}
          onChange={(event) => setMemberInstructions(event.target.value)}
          rows={3}
          placeholder=".nanasa/instructions/memberships/reviewer.md"
        />
      </label>
      <button type="submit" className="compact-button">
        <UserPlus aria-hidden="true" size={15} />
        Add member
      </button>
      {error !== undefined && <p className="form-error">{error}</p>}
    </form>
  );
}

export function GroupTree({
  snapshot,
  config,
  selectedGroupId,
  unreadCounts,
  busyAction,
  onSelectGroup,
  onCreateGroup,
  onRenameGroup,
  onUpdateGroup,
  onDeleteGroup,
  onAddAgent,
  onRenameAgent,
  onUpdateAgent,
  onUpdateAgentProfile,
  onRemoveAgent,
  onStartRun,
  onStopRun,
}: GroupTreeProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(selectedGroupId === undefined ? [] : [selectedGroupId]),
  );
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [settingsGroupId, setSettingsGroupId] = useState<string>();
  const [editTarget, setEditTarget] = useState<EditTarget>();
  const [settingsTarget, setSettingsTarget] = useState<{
    groupId: string;
    memberId: string;
  }>();
  const [destructiveTarget, setDestructiveTarget] = useState<DestructiveTarget>();
  const [statusPopover, setStatusPopover] = useState<{
    membershipId: string;
    left: number;
    top: number;
  }>();
  const failedMemberIds = new Set(
    snapshot.messageGroups?.flatMap((state) => state.failedRecipientMemberIds) ?? [],
  );
  const settingsMember =
    settingsTarget === undefined
      ? undefined
      : snapshot.memberships.find(
          (membership) =>
            membership.groupId === settingsTarget.groupId &&
            membership.memberId === settingsTarget.memberId,
        );
  const settingsProfile =
    settingsMember === undefined
      ? undefined
      : snapshot.agentProfiles.find((profile) => profile.id === settingsMember.agentProfileId);
  const configuredSettingsMember =
    settingsTarget === undefined
      ? undefined
      : Object.values(config.groups[settingsTarget.groupId]?.memberships ?? {}).find(
          (membership) => membership.memberId === settingsTarget.memberId,
        );
  const configuredSettingsProfile =
    settingsProfile === undefined ? undefined : config.agentProfiles[settingsProfile.id];

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
      {showCreateGroup && <CreateGroupForm onCreate={onCreateGroup} />}
      <nav className="group-tree" aria-label="Group tree">
        {snapshot.groups.length === 0 && (
          <div className="empty-state compact-empty">
            <p>No groups yet.</p>
            <button type="button" onClick={() => setShowCreateGroup(true)}>
              Create the first group
            </button>
          </div>
        )}
        {snapshot.groups.map((group) => {
          const members = snapshot.memberships.filter(
            (member) => member.groupId === group.id && member.state === "active",
          );
          const expanded = expandedGroups.has(group.id);
          const unread = unreadCounts.get(group.id) ?? 0;
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
                    <span className="tree-count">{members.length}</span>
                    {unread > 0 && (
                      <span className="unread-badge" aria-label={`${unread} unread`}>
                        {unread}
                      </span>
                    )}
                  </button>
                )}
                {editTarget?.groupId !== group.id && (
                  <ActionMenu
                    label={`Actions for group ${group.name}`}
                    itemCount={4}
                    triggerId={`group-actions-${group.id}`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="action-menu-item"
                      aria-label={`Add agent to ${group.name}`}
                      onClick={() => setShowAddAgent(true)}
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
                      className="action-menu-item danger-action"
                      aria-label={`Delete group ${group.name}`}
                      onClick={() =>
                        setDestructiveTarget({
                          kind: "group",
                          groupId: group.id,
                          name: group.name,
                          memberCount: snapshot.memberships.filter(
                            (member) => member.groupId === group.id,
                          ).length,
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
                  {members.length === 0 && <p className="tree-empty">No members</p>}
                  {members.map((member) => {
                    const {
                      run,
                      status: agentStatus,
                      label: semanticLabel,
                    } = memberStatusView(snapshot.agentStatuses, snapshot.runs, member);
                    const action = runAction(run);
                    const actionKey = `${group.id}:${member.memberId}`;
                    const profile = snapshot.agentProfiles.find(
                      (candidate) => candidate.id === member.agentProfileId,
                    );
                    const configuredType =
                      profile === undefined ? undefined : config.agentTypes[profile.agentType];
                    const role =
                      member.roleId === undefined ? undefined : config.roles?.[member.roleId];
                    const recoveryDetail = run?.recoveryReason;
                    const semanticDetail = [
                      agentStatus?.phase,
                      agentStatus?.attention === "none"
                        ? undefined
                        : agentStatus?.attention.replaceAll("_", " "),
                      agentStatus?.progressStage,
                    ]
                      .filter((value): value is string => value !== undefined)
                      .join(" · ");
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
                      <div className="member-row" key={member.id}>
                        <span className={`status-dot status-${semanticLabel}`} aria-hidden="true" />
                        {editTarget?.kind === "member" &&
                        editTarget.groupId === group.id &&
                        editTarget.memberId === member.memberId ? (
                          <InlineRename
                            label={`agent alias for ${member.alias}`}
                            initialValue={editTarget.name}
                            onCancel={() => setEditTarget(undefined)}
                            onRestoreFocus={() =>
                              document
                                .getElementById(`member-actions-${group.id}-${member.memberId}`)
                                ?.focus()
                            }
                            onSave={(alias) => onRenameAgent(group.id, member.memberId, alias)}
                          />
                        ) : (
                          <button
                            id={`member-status-trigger-${member.id}`}
                            type="button"
                            className="member-select"
                            aria-label={`View details for ${member.alias}`}
                            aria-haspopup="dialog"
                            aria-expanded={popoverVisible}
                            aria-controls={popoverVisible ? popoverId : undefined}
                            onClick={(event) => {
                              onSelectGroup(group.id);
                              toggleStatusPopover(member.id, event.currentTarget);
                            }}
                          >
                            <span>{member.alias}</span>
                            <code title={member.memberId}>{member.memberId}</code>
                            <small title={statusTitle || undefined}>
                              {semanticLabel}
                              {semanticDetail.length > 0 && ` · ${semanticDetail}`}
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
                              aria-label={`Agent details for ${member.alias}`}
                              tabIndex={-1}
                              className="member-status-popover"
                              style={{ left: statusPopover.left, top: statusPopover.top }}
                            >
                              <div className="member-status-popover-heading">
                                <span
                                  className={`status-dot status-${semanticLabel}`}
                                  aria-hidden="true"
                                />
                                <strong>{member.alias}</strong>
                                <span>{semanticLabel.replaceAll("_", " ")}</span>
                                <button
                                  type="button"
                                  className="icon-button status-popover-close"
                                  aria-label={`Close details for ${member.alias}`}
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
                                  <dt>Agent type</dt>
                                  <dd>
                                    {configuredType === undefined
                                      ? (profile?.agentType ?? "Unknown")
                                      : `${configuredType.name} (${configuredType.key})`}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Role</dt>
                                  <dd>{role?.name ?? member.roleId ?? "Unassigned"}</dd>
                                </div>
                                <div>
                                  <dt>Semantic status</dt>
                                  <dd>
                                    {semanticLabel.replaceAll("_", " ")}
                                    {agentStatus === undefined
                                      ? ""
                                      : ` / ${agentStatus.phase.replaceAll("_", " ")}`}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Terminal</dt>
                                  <dd>
                                    {run === undefined
                                      ? "Not started"
                                      : `${run.status} / ${run.recoveryPhase}`}
                                  </dd>
                                </div>
                                {agentStatus !== undefined && (
                                  <>
                                    <div>
                                      <dt>Confidence</dt>
                                      <dd>{agentStatus.confidence}</dd>
                                    </div>
                                    <div>
                                      <dt>Attention</dt>
                                      <dd>{agentStatus.attention.replaceAll("_", " ")}</dd>
                                    </div>
                                  </>
                                )}
                                {agentStatus?.lastProgressSummary !== undefined && (
                                  <div>
                                    <dt>Progress</dt>
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
                                {agentStatus?.lastActivityKind !== undefined && (
                                  <div>
                                    <dt>Last activity</dt>
                                    <dd>{agentStatus.lastActivityKind.replaceAll("_", " ")}</dd>
                                  </div>
                                )}
                              </dl>
                            </div>,
                            document.body,
                          )}
                        {(failedMemberIds.has(member.memberId) ||
                          (agentStatus !== undefined && agentStatus.attention !== "none")) && (
                          <CircleAlert
                            className="attention-icon"
                            aria-label={
                              agentStatus !== undefined && agentStatus.attention !== "none"
                                ? `${member.alias} needs ${agentStatus.attention.replaceAll("_", " ")}`
                                : "Delivery needs attention"
                            }
                            size={15}
                          />
                        )}
                        {editTarget?.kind !== "member" && (
                          <ActionMenu
                            label={`Actions for agent ${member.alias}`}
                            itemCount={action === "none" ? 4 : 5}
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
                            {action !== "none" && (
                              <button
                                type="button"
                                role="menuitem"
                                className="action-menu-item"
                                aria-label={`${action === "retry" ? "Retry" : action === "stop" ? "Stop" : "Start"} ${member.alias}`}
                                disabled={busyAction === actionKey}
                                onClick={() => {
                                  const operation =
                                    action === "stop"
                                      ? onStopRun(group.id, member.memberId)
                                      : onStartRun(group.id, member.memberId);
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
                              aria-label={`Edit agent settings ${member.alias}`}
                              onClick={() =>
                                setSettingsTarget({
                                  groupId: group.id,
                                  memberId: member.memberId,
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
                              aria-label={`Rename agent ${member.alias}`}
                              onClick={() =>
                                setEditTarget({
                                  kind: "member",
                                  groupId: group.id,
                                  memberId: member.memberId,
                                  name: member.alias,
                                })
                              }
                            >
                              <Pencil aria-hidden="true" size={14} />
                              <span>Rename</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="action-menu-item danger-action"
                              aria-label={`Remove agent ${member.alias}`}
                              onClick={() =>
                                setDestructiveTarget({
                                  kind: "member",
                                  groupId: group.id,
                                  memberId: member.memberId,
                                  name: member.alias,
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
      {selectedGroupId !== undefined && (
        <div className="rail-footer">
          <button
            type="button"
            className="compact-button"
            onClick={() => setShowAddAgent((visible) => !visible)}
          >
            <UserPlus aria-hidden="true" size={15} />
            Add agent
          </button>
          {showAddAgent && (
            <AddAgentForm
              group={snapshot.groups.find((group) => group.id === selectedGroupId)!}
              profiles={snapshot.agentProfiles}
              config={config}
              onAdd={onAddAgent}
            />
          )}
        </div>
      )}
      {destructiveTarget !== undefined && (
        <ConfirmRemovalDialog
          target={destructiveTarget}
          busy={
            busyAction ===
            (destructiveTarget.kind === "group"
              ? `${destructiveTarget.groupId}:delete`
              : `${destructiveTarget.groupId}:${destructiveTarget.memberId}:remove`)
          }
          onCancel={() => setDestructiveTarget(undefined)}
          onConfirm={() =>
            destructiveTarget.kind === "group"
              ? onDeleteGroup(destructiveTarget.groupId)
              : onRemoveAgent(destructiveTarget.groupId, destructiveTarget.memberId)
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
      {settingsTarget !== undefined &&
        settingsMember !== undefined &&
        settingsProfile !== undefined &&
        onUpdateAgent !== undefined &&
        onUpdateAgentProfile !== undefined && (
          <AgentSettingsDialog
            member={settingsMember}
            profile={settingsProfile}
            configuredMember={configuredSettingsMember}
            configuredProfile={configuredSettingsProfile}
            config={config}
            onClose={() => setSettingsTarget(undefined)}
            onUpdateMember={(command) =>
              onUpdateAgent(settingsTarget.groupId, settingsTarget.memberId, command)
            }
            onUpdateProfile={(command) => onUpdateAgentProfile(settingsProfile.id, command)}
          />
        )}
    </>
  );
}
