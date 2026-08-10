import type {
  AgentProfile,
  AgentRun,
  Group,
  GroupMembership,
  NanasaConfig,
  PortalSnapshot,
} from "@nanasa/contracts";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Play,
  Plus,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import { type FormEvent, useState } from "react";

export interface AddAgentInput {
  groupId: string;
  alias: string;
  profileId?: string;
  newProfile?: { name: string; agentType: string };
}

interface GroupTreeProps {
  snapshot: PortalSnapshot;
  config: NanasaConfig;
  selectedGroupId?: string;
  unreadCounts: ReadonlyMap<string, number>;
  busyAction?: string;
  onSelectGroup(groupId: string): void;
  onCreateGroup(name: string): Promise<void>;
  onAddAgent(input: AddAgentInput): Promise<void>;
  onStartRun(groupId: string, memberId: string): Promise<void>;
  onStopRun(groupId: string, memberId: string): Promise<void>;
}

function currentRun(runs: AgentRun[], member: GroupMembership): AgentRun | undefined {
  return runs
    .filter((run) => run.groupId === member.groupId && run.memberId === member.memberId)
    .sort((left, right) => right.generation - left.generation)[0];
}

function statusLabel(run: AgentRun | undefined): string {
  if (run === undefined) return "offline";
  return run.recoveryPhase === "idle" ? run.status : run.recoveryPhase;
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

function CreateGroupForm({ onCreate }: { onCreate(name: string): Promise<void> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onCreate(name);
      setName("");
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
      {error !== undefined && <p className="form-error">{error}</p>}
    </form>
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
  const [error, setError] = useState<string>();
  const selectedProfileId = profileId || profiles[0]?.id || "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onAdd({
        groupId: group.id,
        alias,
        ...(creatingProfile
          ? { newProfile: { name: profileName, agentType } }
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
  onAddAgent,
  onStartRun,
  onStopRun,
}: GroupTreeProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(selectedGroupId === undefined ? [] : [selectedGroupId]),
  );
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const failedMemberIds = new Set(
    snapshot.deliveryOutcomes
      .filter((outcome) => ["failed", "dead-letter", "rejected"].includes(outcome.status))
      .map((outcome) => outcome.recipientMemberId),
  );

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

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
                {selectedGroupId === group.id && (
                  <button
                    type="button"
                    className="icon-button group-action"
                    aria-label={`Add agent to ${group.name}`}
                    title={`Add agent to ${group.name}`}
                    onClick={() => setShowAddAgent(true)}
                  >
                    <UserPlus aria-hidden="true" size={15} />
                  </button>
                )}
              </div>
              {expanded && (
                <div className="tree-members">
                  {members.length === 0 && <p className="tree-empty">No members</p>}
                  {members.map((member) => {
                    const run = currentRun(snapshot.runs, member);
                    const action = runAction(run);
                    const actionKey = `${group.id}:${member.memberId}`;
                    const profile = snapshot.agentProfiles.find(
                      (candidate) => candidate.id === member.agentProfileId,
                    );
                    const configuredType =
                      profile === undefined ? undefined : config.agentTypes[profile.agentType];
                    const recoveryDetail = run?.recoveryReason;
                    return (
                      <div className="member-row" key={member.id}>
                        <span
                          className={`status-dot status-${statusLabel(run)}`}
                          aria-hidden="true"
                        />
                        <button
                          type="button"
                          className="member-select"
                          onClick={() => onSelectGroup(group.id)}
                        >
                          <span>{member.alias}</span>
                          <small title={recoveryDetail}>
                            {statusLabel(run)}
                            {configuredType !== undefined &&
                              ` · ${configuredType.name} (${configuredType.key})`}
                            {run?.recoveryNotBefore !== undefined &&
                              ` · retry ${new Date(run.recoveryNotBefore).toLocaleTimeString()}`}
                          </small>
                        </button>
                        {failedMemberIds.has(member.memberId) && (
                          <CircleAlert
                            className="attention-icon"
                            aria-label="Delivery needs attention"
                            size={15}
                          />
                        )}
                        {action !== "none" && (
                          <button
                            type="button"
                            className="icon-button member-action"
                            aria-label={`${action === "retry" ? "Retry" : action === "stop" ? "Stop" : "Start"} ${member.alias}`}
                            title={`${action === "retry" ? "Retry recovery for" : action === "stop" ? "Stop" : "Start"} ${member.alias}`}
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
                          </button>
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
    </>
  );
}
