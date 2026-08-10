import {
  type Audience,
  type DeliveryOutcome,
  type Group,
  type GroupMembership,
  type MessageIntent,
  type MessageSubmissionResult,
  MessageSubmissionResultSchema,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
} from "@nanasa/contracts";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

type AudienceKind = Audience["kind"];

export const MESSAGE_HISTORY_KEY = "nanasa.message-history.v1";
const MAX_MESSAGE_HISTORY = 100;

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
      <CheckCircle2 aria-hidden="true" size={16} />
      <span className="outcome-recipient">{alias}</span>
      <strong>{outcome.status}</strong>
      {outcome.reason !== undefined && <small>{outcome.reason}</small>}
    </li>
  );
}

interface MessageWorkspaceProps {
  group: Group;
  members: GroupMembership[];
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
        <p>This permanently removes all saved message history from this browser.</p>
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
  deliveryOutcomes = [],
  onSubmit,
}: MessageWorkspaceProps) {
  const [expanded, setExpanded] = useState(
    () =>
      typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 720px)").matches,
  );
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("dm");
  const [recipientIds, setRecipientIds] = useState<string[]>(
    members[0] === undefined ? [] : [members[0].memberId],
  );
  const [intent, setIntent] = useState<MessageIntent>("request");
  const [body, setBody] = useState("");
  const [history, setHistory] = useState(loadMessageHistory);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const contextKey = `${group.id}:${members.map((member) => member.memberId).join(",")}`;
  const contextVersionRef = useRef(0);

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
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);

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
      saveMessageHistory(next);
      return next;
    });
  }, [deliveryOutcomes]);

  const groupHistory = history.filter((entry) => entry.submission.message.groupId === group.id);

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
        saveMessageHistory(next);
        return next;
      });
      setBody("");
      setError(undefined);
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
  };

  return (
    <section className="message-drawer" aria-label="Messages">
      <header className="message-toolbar">
        <div className="message-toolbar-title">
          <MessageSquareText aria-hidden="true" size={17} />
          <strong>Messages</strong>
          <span>{groupHistory.length === 0 ? "No history" : `${groupHistory.length} saved`}</span>
        </div>
        <div className="message-toolbar-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Clear all message history"
            title="Clear all message history"
            disabled={history.length === 0}
            onClick={() => setConfirmingClear(true)}
          >
            <Trash2 aria-hidden="true" size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-expanded={expanded}
            aria-controls="message-drawer-content"
            aria-label={expanded ? "Collapse messages" : "Expand messages"}
            title={expanded ? "Collapse messages" : "Expand messages"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? (
              <ChevronUp aria-hidden="true" size={16} />
            ) : (
              <ChevronDown aria-hidden="true" size={16} />
            )}
          </button>
        </div>
      </header>
      {expanded && (
        <div id="message-drawer-content" className="message-workspace">
          <form className="message-composer" onSubmit={(event) => void submit(event)}>
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
                <strong>revision {group.membershipRevision}</strong>
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
                type="submit"
                className="primary-button"
                disabled={submitting || members.length === 0 || !audienceIsValid}
              >
                <Send aria-hidden="true" size={16} />
                {submitting ? "Sending..." : "Send message"}
              </button>
            </div>
          </form>
          <section className="message-history" aria-label="Message history">
            {groupHistory.length === 0 ? (
              <div className="empty-state compact-empty">
                <p>Sent messages and recipient outcomes will appear here.</p>
              </div>
            ) : (
              <ol className="message-history-list">
                {groupHistory.map(({ storedAt, submission }) => (
                  <li key={submission.message.id} className="message-history-item">
                    <div className="message-history-heading">
                      <strong>message #{submission.message.groupSeq}</strong>
                      <time dateTime={storedAt}>
                        {new Date(storedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <p>{submission.message.body.text}</p>
                    <ul className="outcome-list">
                      {submission.deliveryOutcomes.map((outcome) => (
                        <OutcomeRow
                          key={`${outcome.messageId}:${outcome.recipientMemberId}`}
                          outcome={outcome}
                          members={members}
                        />
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
      {confirmingClear && (
        <ConfirmClearHistoryDialog
          onCancel={() => setConfirmingClear(false)}
          onConfirm={clearHistory}
        />
      )}
    </section>
  );
}
