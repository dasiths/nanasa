import {
  type Audience,
  type DeliveryOutcome,
  type Group,
  type GroupMembership,
  type Message,
  type MessageIntent,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
} from "@nanasa/contracts";
import {
  ChevronDown,
  ChevronRight,
  CircleArrowDown,
  MessageCircle,
  MessageSquareText,
  Send,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

type AudienceKind = Audience["kind"];

export const MESSAGE_HISTORY_KEY = "nanasa.message-history.v1";
export const MESSAGE_HISTORY_CLEARED_KEY = "nanasa.message-history-cleared.v1";
export const MESSAGE_OVERLAY_OPEN_KEY = "nanasa.message-overlay-open.v1";
const MAX_MESSAGE_HISTORY = 100;
const intentDescriptions: Record<MessageIntent, string> = {
  inform: "Share context or a status update. No response is required.",
  request: "Ask an agent to perform work or provide an answer.",
  response: "Reply to an earlier request or message.",
  control: "Send a Human operator instruction for coordination or execution.",
};

interface MessageHistoryEntry {
  storedAt: string;
  submission: MessageSubmissionResult;
}

function loadMessageHistory(): MessageHistoryEntry[] {
  try {
    const value = window.localStorage.getItem(MESSAGE_HISTORY_KEY);
    if (value === null) return [];
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || !("submission" in entry)) return [];
      const result = MessageSubmissionResultSchema.safeParse(entry.submission);
      const storedAt =
        "storedAt" in entry && typeof entry.storedAt === "string" ? entry.storedAt : "";
      return result.success && storedAt !== "" ? [{ storedAt, submission: result.data }] : [];
    });
  } catch {
    return [];
  }
}

function saveMessageHistory(history: MessageHistoryEntry[]): void {
  window.localStorage.setItem(MESSAGE_HISTORY_KEY, JSON.stringify(history));
}

function loadClearedHistory(): Record<string, number> {
  try {
    const value = window.localStorage.getItem(MESSAGE_HISTORY_CLEARED_KEY);
    if (value === null) return {};
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

function loadOverlayOpen(): boolean {
  try {
    return window.localStorage.getItem(MESSAGE_OVERLAY_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

export interface MessageDraft {
  audienceKind: AudienceKind;
  recipientIds: string[];
  intent: MessageIntent;
  body: string;
}

export function buildMessageCommand(group: Group, draft: MessageDraft): SubmitMessageCommand {
  let audience: Audience;
  if (draft.audienceKind === "dm") {
    audience = { kind: "dm", memberId: draft.recipientIds[0] ?? "" };
  } else if (draft.audienceKind === "multicast") {
    audience = { kind: "multicast", memberIds: draft.recipientIds };
  } else {
    audience = { kind: "group", membershipRevision: group.membershipRevision };
  }

  return SubmitMessageCommandSchema.parse({
    intent: draft.intent,
    sender: { kind: "operator", operatorId: "portal-operator" },
    audience,
    body: { contentType: "text/markdown", text: draft.body },
    delivery: {},
    hop: 0,
  });
}

function OutcomeRow({
  outcome,
  members,
}: {
  outcome: DeliveryOutcome;
  members: GroupMembership[];
}) {
  const alias =
    members.find((member) => member.memberId === outcome.recipientMemberId)?.alias ??
    outcome.recipientMemberId;
  return (
    <li className={`outcome-row outcome-${outcome.status}`}>
      <ActorAvatar name={alias} memberId={outcome.recipientMemberId} />
      <span className="outcome-recipient">{alias}</span>
      <strong>{outcome.status}</strong>
      {outcome.attempts > 1 && (
        <span>
          {outcome.attempts === 2 ? "Retried once" : `Retried ${outcome.attempts - 1} times`}
        </span>
      )}
      {outcome.reason !== undefined && <small>{outcome.reason}</small>}
    </li>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
}

function ActorAvatar({
  name,
  memberId,
  human = false,
}: {
  name: string;
  memberId?: string;
  human?: boolean;
}) {
  const title = human ? "Human via portal" : `${name} · ${memberId ?? "unknown member"}`;
  return (
    <span
      className={`actor-avatar${human ? " actor-avatar-human" : ""}`}
      aria-hidden="true"
      title={title}
    >
      {human ? "H" : initials(name)}
    </span>
  );
}

function deliverySummary(outcomes: DeliveryOutcome[]): string {
  if (outcomes.length === 0) return "No recipients";
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
  }
  const statuses = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
  return `Sent to ${outcomes.length} · ${statuses}`;
}

function DeliveryDetails({
  messageId,
  outcomes,
  members,
}: {
  messageId: string;
  outcomes: DeliveryOutcome[];
  members: GroupMembership[];
}) {
  const [expanded, setExpanded] = useState(false);
  const generatedId = useId();
  const detailsId = `delivery-${messageId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}-${generatedId.replaceAll(":", "")}`;
  return (
    <div className="delivery-details">
      <button
        type="button"
        className="delivery-summary"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" size={14} />
        )}
        <span>{deliverySummary(outcomes)}</span>
      </button>
      {expanded && (
        <ul id={detailsId} className="outcome-list">
          {outcomes.map((outcome) => (
            <OutcomeRow
              key={`${outcome.messageId}:${outcome.recipientMemberId}`}
              outcome={outcome}
              members={members}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChatMessage({
  message,
  outcomes,
  members,
}: {
  message: Message;
  outcomes: DeliveryOutcome[];
  members: GroupMembership[];
}) {
  const senderMemberId = message.sender.kind === "agent" ? message.sender.memberId : undefined;
  const human = senderMemberId === undefined;
  const actorName =
    senderMemberId === undefined
      ? "Human"
      : (members.find((member) => member.memberId === senderMemberId)?.alias ?? senderMemberId);
  return (
    <li className={`chat-message${human ? " chat-message-human" : ""}`}>
      <ActorAvatar
        name={actorName}
        {...(senderMemberId === undefined ? {} : { memberId: senderMemberId })}
        human={human}
      />
      <article className="chat-bubble">
        <header className="chat-message-heading">
          <strong>
            From: {actorName}
            {senderMemberId !== undefined && (
              <>
                <span> · </span>
                <code>{senderMemberId}</code>
              </>
            )}
          </strong>
          <span className="chat-intent">{message.intent}</span>
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </header>
        <p>{message.body.text}</p>
        <DeliveryDetails messageId={message.id} outcomes={outcomes} members={members} />
      </article>
    </li>
  );
}

interface MessageWorkspaceProps {
  group: Group;
  members: GroupMembership[];
  historyMembers?: GroupMembership[];
  messages?: Message[];
  deliveryOutcomes?: DeliveryOutcome[];
  onSubmit(command: SubmitMessageCommand): Promise<MessageSubmissionResult>;
}

function ConfirmClearHistoryDialog({
  onCancel,
  onConfirm,
}: {
  onCancel(): void;
  onConfirm(): void;
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
      className="confirmation-dialog"
      aria-labelledby="confirm-clear-message-history-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="confirmation-dialog-body">
        <h2 id="confirm-clear-message-history-title">Clear all message history?</h2>
        <p>
          This hides the current group history in this browser. Messages remain persisted by the
          Nanasa daemon, and new messages will still appear.
        </p>
        <div className="confirmation-actions">
          <button type="button" className="compact-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="compact-button danger-button"
            onClick={() => {
              onConfirm();
              onCancel();
            }}
          >
            <Trash2 aria-hidden="true" size={15} />
            Clear history
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function MessageWorkspace({
  group,
  members,
  historyMembers = members,
  messages = [],
  deliveryOutcomes = [],
  onSubmit,
}: MessageWorkspaceProps) {
  const initialMessageSequence = Math.max(
    0,
    ...messages
      .filter((message) => message.groupId === group.id)
      .map((message) => message.groupSeq),
  );
  const [open, setOpen] = useState(loadOverlayOpen);
  const [composing, setComposing] = useState(false);
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("dm");
  const [recipientIds, setRecipientIds] = useState<string[]>(
    members[0] === undefined ? [] : [members[0].memberId],
  );
  const [intent, setIntent] = useState<MessageIntent>("request");
  const [body, setBody] = useState("");
  const [history, setHistory] = useState(loadMessageHistory);
  const [clearedHistory, setClearedHistory] = useState(loadClearedHistory);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const contextKey = `${group.id}:${members.map((member) => member.memberId).join(",")}`;
  const contextVersionRef = useRef(0);
  const historyRef = useRef<HTMLElement>(null);
  const composerDialogRef = useRef<HTMLDialogElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const nearBottomRef = useRef(true);
  const [seenSequence, setSeenSequence] = useState(initialMessageSequence);
  const previousTimelineRef = useRef<{ groupId: string; latestId: string | undefined }>({
    groupId: group.id,
    latestId: undefined,
  });

  useEffect(() => {
    contextVersionRef.current += 1;
    setRecipientIds((current) => {
      const activeMemberIds = new Set(members.map((member) => member.memberId));
      const activeRecipients = current.filter((memberId) => activeMemberIds.has(memberId));

      if (audienceKind === "dm") {
        return activeRecipients.slice(0, 1).length === 1
          ? activeRecipients.slice(0, 1)
          : members[0] === undefined
            ? []
            : [members[0].memberId];
      }

      if (audienceKind === "multicast") {
        return activeRecipients.length >= 2
          ? activeRecipients
          : members.slice(0, 2).map((member) => member.memberId);
      }

      return [];
    });
    setError(undefined);
    setSubmitting(false);
  }, [audienceKind, contextKey]);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key === MESSAGE_HISTORY_KEY) setHistory(loadMessageHistory());
      if (event.key === MESSAGE_HISTORY_CLEARED_KEY) setClearedHistory(loadClearedHistory());
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);

  useEffect(() => {
    if (history.length > 0) saveMessageHistory(history);
  }, [history]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MESSAGE_OVERLAY_OPEN_KEY, String(open));
    } catch {
      // The overlay remains usable when browser storage is blocked.
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || composing || confirmingClear) return;
      const overlay = document.getElementById("message-overlay");
      const target = event.target;
      if (
        target instanceof Node &&
        target !== launcherRef.current &&
        overlay?.contains(target) !== true
      ) {
        return;
      }
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => launcherRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [composing, confirmingClear, open]);

  useEffect(() => {
    const dialog = composerDialogRef.current;
    if (!composing || dialog === null) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, [composing]);

  useEffect(() => {
    setHistory((current) => {
      let changed = false;
      const next = current.map((entry) => {
        const authoritative = deliveryOutcomes.filter(
          (outcome) => outcome.messageId === entry.submission.message.id,
        );
        if (authoritative.length === 0) return entry;
        if (JSON.stringify(authoritative) === JSON.stringify(entry.submission.deliveryOutcomes)) {
          return entry;
        }
        changed = true;
        return {
          ...entry,
          submission: { ...entry.submission, deliveryOutcomes: authoritative },
        };
      });
      if (!changed) return current;
      return next;
    });
  }, [deliveryOutcomes]);

  const timelineById = new Map(
    history
      .filter((entry) => entry.submission.message.groupId === group.id)
      .map((entry) => [entry.submission.message.id, entry] as const),
  );
  for (const message of messages.filter((candidate) => candidate.groupId === group.id)) {
    const authoritativeOutcomes = deliveryOutcomes.filter(
      (outcome) => outcome.messageId === message.id,
    );
    const localOutcomes = timelineById.get(message.id)?.submission.deliveryOutcomes ?? [];
    timelineById.set(message.id, {
      storedAt: message.createdAt,
      submission: {
        message,
        deliveryOutcomes:
          authoritativeOutcomes.length === 0 ? localOutcomes : authoritativeOutcomes,
      },
    });
  }
  const groupHistory = [...timelineById.values()]
    .sort(
      (left, right) =>
        left.submission.message.groupSeq - right.submission.message.groupSeq ||
        left.submission.message.createdAt.localeCompare(right.submission.message.createdAt),
    )
    .filter((entry) => entry.submission.message.groupSeq > (clearedHistory[group.id] ?? 0));
  const latestMessageId = groupHistory.at(-1)?.submission.message.id;
  const latestMessageSequence = groupHistory.at(-1)?.submission.message.groupSeq ?? 0;
  const unreadCount = Math.max(0, latestMessageSequence - seenSequence);

  useEffect(() => {
    setSeenSequence(latestMessageSequence);
  }, [group.id]);

  useEffect(() => {
    if (open) setSeenSequence(latestMessageSequence);
  }, [latestMessageSequence, open]);

  const scrollToLatest = () => {
    const viewport = historyRef.current;
    if (viewport !== null) viewport.scrollTop = viewport.scrollHeight;
    nearBottomRef.current = true;
    setShowJumpToLatest(false);
  };

  useEffect(() => {
    const previous = previousTimelineRef.current;
    const groupChanged = previous.groupId !== group.id;
    const messageChanged = previous.latestId !== latestMessageId;
    previousTimelineRef.current = { groupId: group.id, latestId: latestMessageId };
    if (!messageChanged && !groupChanged) return;
    if (groupChanged || nearBottomRef.current) {
      requestAnimationFrame(scrollToLatest);
    } else {
      setShowJumpToLatest(true);
    }
  }, [group.id, latestMessageId]);

  const trackHistoryScroll = () => {
    const viewport = historyRef.current;
    if (viewport === null) return;
    nearBottomRef.current =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
    if (nearBottomRef.current) setShowJumpToLatest(false);
  };

  const targetMemberIds =
    audienceKind === "group" ? members.map((member) => member.memberId) : recipientIds;
  const audienceIsValid =
    audienceKind === "dm"
      ? targetMemberIds.length === 1
      : audienceKind === "multicast"
        ? targetMemberIds.length >= 2
        : targetMemberIds.length > 0;

  const setAudience = (kind: AudienceKind) => {
    setAudienceKind(kind);
    if (kind === "dm") setRecipientIds(members[0] === undefined ? [] : [members[0].memberId]);
    if (kind === "multicast") setRecipientIds(members.slice(0, 2).map((member) => member.memberId));
  };

  const toggleRecipient = (memberId: string) => {
    setRecipientIds((current) =>
      current.includes(memberId)
        ? current.filter((candidate) => candidate !== memberId)
        : [...current, memberId],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const submittedContextVersion = contextVersionRef.current;
    setSubmitting(true);
    try {
      const command = buildMessageCommand(group, {
        audienceKind,
        recipientIds,
        intent,
        body,
      });
      const submission = await onSubmit(command);
      if (contextVersionRef.current !== submittedContextVersion) return;
      setHistory((current) => {
        const authoritative = deliveryOutcomes.filter(
          (outcome) => outcome.messageId === submission.message.id,
        );
        const resolvedSubmission =
          authoritative.length === 0
            ? submission
            : { ...submission, deliveryOutcomes: authoritative };
        const next = [
          { storedAt: new Date().toISOString(), submission: resolvedSubmission },
          ...current,
        ].slice(0, MAX_MESSAGE_HISTORY);
        return next;
      });
      setBody("");
      setError(undefined);
      setComposing(false);
    } catch (cause) {
      if (contextVersionRef.current !== submittedContextVersion) return;
      setError(cause instanceof Error ? cause.message : "Unable to send message");
    } finally {
      if (contextVersionRef.current === submittedContextVersion) setSubmitting(false);
    }
  };

  const clearHistory = () => {
    window.localStorage.removeItem(MESSAGE_HISTORY_KEY);
    setHistory([]);
    const next = {
      ...clearedHistory,
      [group.id]: Math.max(0, ...groupHistory.map((entry) => entry.submission.message.groupSeq)),
    };
    window.localStorage.setItem(MESSAGE_HISTORY_CLEARED_KEY, JSON.stringify(next));
    setClearedHistory(next);
  };

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        className="message-launcher"
        aria-label="Messages"
        aria-expanded={open}
        aria-controls="message-overlay"
        title={open ? "Close messages" : "Open messages"}
        onClick={() => setOpen((current) => !current)}
      >
        <MessageCircle aria-hidden="true" size={20} />
        {unreadCount > 0 && (
          <span className="message-launcher-badge" aria-label={`${unreadCount} unread messages`}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <section id="message-overlay" className="message-overlay" aria-label="Messages overlay">
          <section className="message-panel" aria-label="Messages">
            <header className="message-panel-header">
              <div className="message-toolbar-title">
                <MessageSquareText aria-hidden="true" size={17} />
                <strong>Messages</strong>
                <span>
                  {groupHistory.length === 0
                    ? "No history"
                    : `${groupHistory.length} ${groupHistory.length === 1 ? "message" : "messages"}`}
                </span>
              </div>
              <div className="message-toolbar-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear all message history"
                  title="Clear browser message cache"
                  disabled={groupHistory.length === 0}
                  onClick={() => setConfirmingClear(true)}
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close messages"
                  title="Close messages"
                  onClick={() => {
                    setOpen(false);
                    requestAnimationFrame(() => launcherRef.current?.focus());
                  }}
                >
                  <X aria-hidden="true" size={15} />
                </button>
              </div>
            </header>
            <section
              ref={historyRef}
              className="message-history"
              aria-label="Message history"
              onScroll={trackHistoryScroll}
            >
              {groupHistory.length === 0 ? (
                <div className="empty-state compact-empty">
                  <p>Group messages will appear here.</p>
                </div>
              ) : (
                <ol className="message-history-list">
                  {groupHistory.map(({ submission }) => (
                    <ChatMessage
                      key={submission.message.id}
                      message={submission.message}
                      outcomes={submission.deliveryOutcomes}
                      members={historyMembers}
                    />
                  ))}
                </ol>
              )}
              {showJumpToLatest && (
                <button type="button" className="jump-to-latest" onClick={scrollToLatest}>
                  <CircleArrowDown aria-hidden="true" size={15} />
                  New messages
                </button>
              )}
            </section>
            <div className="message-prompt">
              <input
                aria-label="Compose message"
                placeholder="Type a message..."
                readOnly
                disabled={members.length === 0}
                onClick={() => setComposing(true)}
                onFocus={() => setComposing(true)}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Open message composer"
                title="New message"
                disabled={members.length === 0}
                onClick={() => setComposing(true)}
              >
                <Send aria-hidden="true" size={15} />
              </button>
            </div>
          </section>
        </section>
      )}
      {composing && (
        <dialog
          ref={composerDialogRef}
          className="message-compose-dialog"
          aria-labelledby="new-message-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!submitting) setComposing(false);
          }}
        >
          <form className="message-composer" onSubmit={(event) => void submit(event)}>
            <header className="message-compose-header">
              <div>
                <span className="eyebrow">Group message</span>
                <h2 id="new-message-title">New message</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close message composer"
                disabled={submitting}
                onClick={() => setComposing(false)}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            <div className="message-routing-row">
              <label>
                Audience
                <select
                  value={audienceKind}
                  onChange={(event) => setAudience(event.target.value as AudienceKind)}
                >
                  <option value="dm">Direct message</option>
                  <option value="multicast" disabled={members.length < 2}>
                    Selected members
                  </option>
                  <option value="group">Group broadcast</option>
                </select>
              </label>
              <div className="intent-field">
                <label>
                  Intent
                  <select
                    value={intent}
                    onChange={(event) => setIntent(event.target.value as MessageIntent)}
                  >
                    <option value="inform">Inform</option>
                    <option value="request">Request</option>
                    <option value="response">Response</option>
                    <option value="control">Control</option>
                  </select>
                </label>
                <small className="intent-description">{intentDescriptions[intent]}</small>
              </div>
              {audienceKind === "dm" && (
                <label>
                  Recipient
                  <select
                    value={recipientIds[0] ?? ""}
                    onChange={(event) => setRecipientIds([event.target.value])}
                    required
                  >
                    <option value="" disabled>
                      Select an agent
                    </option>
                    {members.map((member) => (
                      <option key={member.id} value={member.memberId}>
                        {member.alias}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {audienceKind === "multicast" && (
              <fieldset className="recipient-fieldset">
                <legend>Recipients (select at least two)</legend>
                <div className="recipient-list">
                  {members.map((member) => (
                    <label key={member.id}>
                      <input
                        type="checkbox"
                        checked={recipientIds.includes(member.memberId)}
                        onChange={() => toggleRecipient(member.memberId)}
                      />
                      {member.alias}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {audienceKind === "group" && (
              <div className="broadcast-summary">
                <Users aria-hidden="true" size={16} />
                <span>{members.length} eligible members</span>
              </div>
            )}
            <label className="message-body-label">
              <span>Message body</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={3}
                placeholder="Send scoped context or a concrete request..."
                required
              />
            </label>
            <div className="composer-actions">
              {error !== undefined && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button
                type="button"
                className="compact-button"
                disabled={submitting}
                onClick={() => setComposing(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={submitting || members.length === 0 || !audienceIsValid}
              >
                <Send aria-hidden="true" size={16} />
                {submitting ? "Sending..." : "Send message"}
              </button>
            </div>
          </form>
        </dialog>
      )}
      {confirmingClear && (
        <ConfirmClearHistoryDialog
          onCancel={() => setConfirmingClear(false)}
          onConfirm={clearHistory}
        />
      )}
    </>
  );
}
