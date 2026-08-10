import {
  type Audience,
  type DeliveryMode,
  type DeliveryOutcome,
  type Group,
  type GroupMembership,
  type MessageIntent,
  type MessageSubmissionResult,
  type SubmitMessageCommand,
  SubmitMessageCommandSchema,
} from "@nanasa/contracts";
import { CheckCircle2, CircleAlert, MessageSquareText, Send, Users } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { PortalClient } from "../api.js";

type AudienceKind = Audience["kind"];

export interface MessageDraft {
  audienceKind: AudienceKind;
  recipientIds: string[];
  intent: MessageIntent;
  deliveryMode: DeliveryMode;
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
    delivery: { mode: draft.deliveryMode },
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
      <span>requested {outcome.requestedMode}</span>
      <span>applied {outcome.appliedMode ?? "pending"}</span>
      <strong>{outcome.status}</strong>
      {outcome.reason !== undefined && <small>{outcome.reason}</small>}
    </li>
  );
}

interface MessageWorkspaceProps {
  client: Pick<PortalClient, "getEffectiveDeliveryModes">;
  group: Group;
  members: GroupMembership[];
  onSubmit(command: SubmitMessageCommand): Promise<MessageSubmissionResult>;
}

type DeliveryModesState =
  | { status: "loading"; modes: DeliveryMode[] }
  | { status: "ready"; modes: DeliveryMode[] }
  | { status: "error"; modes: DeliveryMode[]; message: string };

const deliveryModeLabels: Record<DeliveryMode, string> = {
  queue: "Queue",
  steer: "Steer current work",
  terminal: "Terminal input",
};

export function MessageWorkspace({ client, group, members, onSubmit }: MessageWorkspaceProps) {
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("dm");
  const [recipientIds, setRecipientIds] = useState<string[]>(
    members[0] === undefined ? [] : [members[0].memberId],
  );
  const [intent, setIntent] = useState<MessageIntent>("request");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("queue");
  const [deliveryModes, setDeliveryModes] = useState<DeliveryModesState>({
    status: "loading",
    modes: [],
  });
  const [body, setBody] = useState("");
  const [result, setResult] = useState<MessageSubmissionResult>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const deliveryModesRequest = useRef(0);

  const targetMemberIds =
    audienceKind === "group" ? members.map((member) => member.memberId) : recipientIds;
  const targetMemberIdsKey = JSON.stringify(targetMemberIds);
  const audienceIsValid =
    audienceKind === "dm"
      ? targetMemberIds.length === 1
      : audienceKind === "multicast"
        ? targetMemberIds.length >= 2
        : targetMemberIds.length > 0;

  useEffect(() => {
    const requestId = ++deliveryModesRequest.current;
    if (!audienceIsValid) {
      setDeliveryModes({ status: "ready", modes: [] });
      return;
    }
    setDeliveryModes({ status: "loading", modes: [] });
    void client
      .getEffectiveDeliveryModes(group.id, { memberIds: targetMemberIds })
      .then((result) => {
        if (deliveryModesRequest.current !== requestId) return;
        setDeliveryModes({ status: "ready", modes: result.modes });
      })
      .catch((cause: unknown) => {
        if (deliveryModesRequest.current !== requestId) return;
        setDeliveryModes({
          status: "error",
          modes: [],
          message: cause instanceof Error ? cause.message : "Unable to resolve delivery modes",
        });
      });
  }, [audienceIsValid, client, group.id, targetMemberIdsKey]);

  useEffect(() => {
    if (deliveryModes.status !== "ready" || deliveryModes.modes.length === 0) return;
    setDeliveryMode((current) =>
      deliveryModes.modes.includes(current)
        ? current
        : deliveryModes.modes.includes("queue")
          ? "queue"
          : deliveryModes.modes[0]!,
    );
  }, [deliveryModes]);

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
    setSubmitting(true);
    try {
      const command = buildMessageCommand(group, {
        audienceKind,
        recipientIds,
        intent,
        deliveryMode,
        body,
      });
      const submission = await onSubmit(command);
      setResult(submission);
      setBody("");
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send message");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="message-workspace">
      <form className="message-composer" onSubmit={(event) => void submit(event)}>
        <div className="composer-heading">
          <div>
            <span className="eyebrow">Structured routing</span>
            <h2>Message composer</h2>
          </div>
          <MessageSquareText aria-hidden="true" size={20} />
        </div>
        <div className="form-row form-row-triple">
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
          <label>
            Delivery mode
            <select
              value={deliveryModes.modes.includes(deliveryMode) ? deliveryMode : ""}
              onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode)}
              disabled={deliveryModes.status !== "ready" || deliveryModes.modes.length === 0}
            >
              {deliveryModes.modes.length === 0 && <option value="">No mode available</option>}
              {deliveryModes.modes.map((mode) => (
                <option key={mode} value={mode}>
                  {deliveryModeLabels[mode]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {deliveryModes.status === "loading" && (
          <p className="delivery-mode-status" role="status">
            Checking delivery modes...
          </p>
        )}
        {deliveryModes.status === "error" && (
          <p className="form-error" role="alert">
            Delivery modes unavailable: {deliveryModes.message}
          </p>
        )}
        {deliveryModes.status === "ready" && deliveryModes.modes.length === 0 && (
          <p className="form-error" role="alert">
            No common delivery mode is available for the selected recipients.
          </p>
        )}
        {deliveryMode === "terminal" && deliveryModes.modes.includes("terminal") && (
          <div className="terminal-delivery-warning" role="note">
            <CircleAlert aria-hidden="true" size={17} />
            <p>
              Terminal input pastes this message directly into each selected TUI and sends Enter. It
              has no semantic completion acknowledgement and may retry while another browser owns
              ttyd. Terminal Mode remains the separate direct keyboard workspace.
            </p>
          </div>
        )}
        <div className="audience-panel">
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
          {audienceKind === "multicast" && (
            <fieldset>
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
              <Users aria-hidden="true" size={18} />
              <span>{members.length} eligible members</span>
              <strong>membership revision {group.membershipRevision}</strong>
            </div>
          )}
        </div>
        <label className="message-body-label">
          Message body
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={7}
            placeholder="Send scoped context or a concrete request..."
            required
          />
        </label>
        <div className="composer-actions">
          <p>Messages are routed separately from terminal input.</p>
          <button
            type="submit"
            className="primary-button"
            disabled={
              submitting ||
              members.length === 0 ||
              deliveryModes.status !== "ready" ||
              deliveryModes.modes.length === 0
            }
          >
            <Send aria-hidden="true" size={16} />
            {submitting ? "Sending..." : "Send message"}
          </button>
        </div>
        {error !== undefined && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <section className="delivery-panel" aria-label="Delivery outcomes">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Latest submission</span>
            <h2>Recipient outcomes</h2>
          </div>
          {result !== undefined && <span>message #{result.message.groupSeq}</span>}
        </div>
        {result === undefined ? (
          <div className="empty-state compact-empty">
            <p>Delivery resolution appears here after a message is submitted.</p>
          </div>
        ) : (
          <ul className="outcome-list">
            {result.deliveryOutcomes.map((outcome) => (
              <OutcomeRow
                key={`${outcome.messageId}:${outcome.recipientMemberId}`}
                outcome={outcome}
                members={members}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
