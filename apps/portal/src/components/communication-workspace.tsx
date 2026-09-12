import {
  type DeliveryOutcome,
  type ForemanChannelMessage,
  type ForemanConversationRequest,
  type ForemanWorkspace,
  type Group,
  type Message,
  type MessagePage,
  type NanasaConfig,
  type SendForemanMessageCommand,
  SubmitMessageCommandSchema,
} from "@nanasa/contracts";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Hash,
  MessageSquare,
  Search,
  Send,
  Square,
  Users,
  WrapText,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";
import {
  type CommunicationEntry,
  type CommunicationThread,
  communicationThreads,
} from "./communication-threads.js";
import "./communication-workspace.css";

type Destination =
  | { kind: "foreman" }
  | { kind: "group"; groupId: string }
  | { kind: "member"; groupId: string; memberId: string }
  | { kind: "multicast"; groupId: string; memberIds: string[] };
interface Props {
  client: PortalClient;
  config: NanasaConfig;
  groups: Group[];
  messages: ForemanChannelMessage[];
  requests: ForemanConversationRequest[];
  inbox: ForemanWorkspace["inbox"];
  teamId: string;
  onTeamChange(id: string): void;
  hasMore: boolean;
  onLoadMore(): void;
  onSendForeman(command: SendForemanMessageCommand): Promise<ForemanChannelMessage>;
  onCancelRequest(id: string): Promise<unknown>;
  onNavigate(path: string): void;
}

const pendingStates = new Set(["queued", "submitted"]);
const attentionStates = new Set(["ambiguous", "failed", "expired"]);
const requestLabels: Record<ForemanConversationRequest["state"], string> = {
  queued: "Queued for delivery",
  submitted: "Delivered · awaiting reply",
  answered: "Replied",
  failed: "Delivery failed",
  expired: "Expired",
  cancelled: "Cancelled",
  ambiguous: "Delivery uncertain",
};
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (value: string) =>
  new Date(value).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

function CodeBlock({ children }: { children?: ReactNode }) {
  const [wrapCode, setWrapCode] = useState(true);
  return (
    <div className="comms-code">
      <button
        type="button"
        className="comms-code-toggle"
        aria-label="Wrap code"
        aria-pressed={wrapCode}
        onClick={() => setWrapCode(!wrapCode)}
        title={wrapCode ? "Code wrapping enabled" : "Wrap long code lines"}
      >
        <WrapText size={13} />
        Wrap code
      </button>
      <pre className={wrapCode ? "comms-code-wrapped" : ""}>{children}</pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: CodeBlock,
};

function MessageBody({ text, compact = false }: { text: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = compact && (text.length > 600 || text.split("\n").length > 8);
  return (
    <div className="comms-message-body">
      <div
        className={`comms-markdown${expandable && !expanded ? " comms-markdown-collapsed" : ""}`}
      >
        <Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
          {text}
        </Markdown>
      </div>
      {expandable && (
        <button className="comms-text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show full message"}
        </button>
      )}
    </div>
  );
}

export function CommunicationWorkspace({
  client,
  config,
  groups,
  messages,
  requests,
  inbox,
  teamId,
  onTeamChange,
  hasMore,
  onLoadMore,
  onSendForeman,
  onCancelRequest,
  onNavigate,
}: Props) {
  const [teamPages, setTeamPages] = useState<Record<string, Message[]>>({});
  const [deliveries, setDeliveries] = useState<DeliveryOutcome[]>([]);
  const [older, setOlder] = useState<Record<string, boolean>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadFailures, setLoadFailures] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [activityFilter, setActivityFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [replyEntryId, setReplyEntryId] = useState<string>();
  const [destination, setDestination] = useState<Destination>({ kind: "foreman" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string>();
  const [error, setError] = useState<PortalError>();
  const [newActivity, setNewActivity] = useState(false);
  const [newThreadActivity, setNewThreadActivity] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const retries = useRef(new Map<string, { signature: string; id: string }>());
  const feedRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const feedNearBottom = useRef(true);
  const threadNearBottom = useRef(true);
  const previousThread = useRef<string | undefined>(undefined);
  const groupIds = groups.map((group) => group.id).join("\n");

  const mergePage = (groupId: string, page: MessagePage, initial: boolean) => {
    setTeamPages((current) => {
      const retained = (current[groupId] ?? []).filter(
        (message) =>
          page.state.retainedMessageCount > 0 &&
          message.groupSeq >= (page.state.oldestRetainedGroupSeq ?? 0),
      );
      const merged = new Map(
        [...retained, ...page.messages].map((message) => [message.id, message]),
      );
      return {
        ...current,
        [groupId]: [...merged.values()].sort((left, right) => left.groupSeq - right.groupSeq),
      };
    });
    setDeliveries((current) => {
      const incoming = new Set(page.messages.map((message) => message.id));
      return [
        ...current.filter((outcome) => !incoming.has(outcome.messageId)),
        ...page.deliveryOutcomes,
      ];
    });
    if (initial) setOlder((current) => ({ ...current, [groupId]: page.pageInfo.hasOlder }));
  };
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const ids = groupIds ? groupIds.split("\n") : [];
    const load = async () => {
      const failures: string[] = [];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const page = await client.loadMessages(id, { limit: 100 });
            if (!cancelled && page !== undefined) mergePage(id, page, first);
          } catch {
            failures.push(id);
          }
        }),
      );
      if (!cancelled) {
        setLoadFailures(failures);
        first = false;
        timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, groupIds, refresh]);

  const memberName = (groupId: string, memberId: string) =>
    Object.values(config.groups[groupId]?.agents ?? {}).find(
      (member) => member.memberId === memberId,
    )?.name ?? memberId;
  const groupName = (id: string) =>
    groups.find((group) => group.id === id)?.name ?? "Unavailable team";
  const targetName = (target: Destination) =>
    target.kind === "foreman"
      ? "Foreman"
      : target.kind === "group"
        ? `${groupName(target.groupId)} · everyone`
        : target.kind === "multicast"
          ? target.memberIds.map((id) => memberName(target.groupId, id)).join(", ")
          : `${groupName(target.groupId)} · ${memberName(target.groupId, target.memberId)}`;
  const actor = (entry: CommunicationEntry) => {
    if (entry.kind === "member-question")
      return {
        name: "Foreman",
        kind: "foreman",
        detail: `to ${memberName(entry.request.groupId, entry.request.memberId)}`,
      };
    if (entry.kind === "member-reply")
      return {
        name: memberName(entry.request.groupId, entry.request.memberId),
        kind: "agent",
        detail: groupName(entry.request.groupId),
      };
    if (entry.kind === "foreman-message")
      return {
        name: entry.message.sender.kind === "operator" ? "You" : "Foreman",
        kind: entry.message.sender.kind === "operator" ? "human" : "foreman",
        detail: entry.message.teamId ? groupName(entry.message.teamId) : "Repository",
      };
    const sender = entry.message.sender;
    const audience = entry.message.audience;
    const recipient =
      audience.kind === "dm"
        ? memberName(entry.message.groupId, audience.memberId)
        : audience.kind === "multicast"
          ? `${audience.memberIds.length} members`
          : "everyone";
    return {
      name: sender.kind === "operator" ? "You" : memberName(entry.message.groupId, sender.memberId),
      kind: sender.kind === "operator" ? "human" : "agent",
      detail: `${groupName(entry.message.groupId)} · to ${recipient}`,
    };
  };
  const threads = communicationThreads(
    messages,
    requests,
    groups.flatMap((group) => teamPages[group.id] ?? []),
  );
  const visibleThreads = threads.filter((thread) => {
    if (
      teamId &&
      thread.groupId !== teamId &&
      !thread.requests.some((request) => request.groupId === teamId)
    )
      return false;
    if (
      activityFilter === "pending" &&
      !thread.requests.some((request) => pendingStates.has(request.state))
    )
      return false;
    if (
      activityFilter === "attention" &&
      !thread.requests.some((request) => attentionStates.has(request.state))
    )
      return false;
    const search = query.trim().toLocaleLowerCase();
    return (
      !search ||
      thread.entries.some((entry) =>
        `${entry.text} ${actor(entry).name} ${actor(entry).detail}`
          .toLocaleLowerCase()
          .includes(search),
      )
    );
  });
  const selected = threads.find((thread) => thread.id === selectedId);
  const selectedEntry =
    selected?.entries.find((entry) => entry.id === replyEntryId) ?? selected?.entries.at(-1);
  const activityKey = threads
    .map((thread) => `${thread.id}:${thread.entries.length}:${thread.updatedAt}`)
    .join("|");
  useEffect(() => {
    const feed = feedRef.current;
    if (feed === null) return;
    if (feedNearBottom.current) feed.scrollTop = feed.scrollHeight;
    else setNewActivity(true);
  }, [activityKey]);
  useEffect(() => {
    const panel = threadRef.current;
    if (panel === null) return;
    if (previousThread.current !== selectedId) {
      panel.scrollTop = 0;
      previousThread.current = selectedId;
      threadNearBottom.current = panel.scrollHeight <= panel.clientHeight + 80;
      setNewThreadActivity(false);
    } else if (threadNearBottom.current) panel.scrollTop = panel.scrollHeight;
    else setNewThreadActivity(true);
  }, [selectedId, selected?.entries.length]);

  const openThread = (thread: CommunicationThread, entry?: CommunicationEntry) => {
    threadNearBottom.current = true;
    setSelectedId(thread.id);
    setReplyEntryId(entry?.id ?? thread.entries.at(-1)?.id);
    setError(undefined);
  };
  const replyDestination = (): Destination => {
    if (selectedEntry?.kind !== "team-message") return { kind: "foreman" };
    const message = selectedEntry.message;
    if (message.sender.kind === "agent")
      return { kind: "member", groupId: message.groupId, memberId: message.sender.memberId };
    if (message.audience.kind === "dm")
      return { kind: "member", groupId: message.groupId, memberId: message.audience.memberId };
    if (message.audience.kind === "multicast")
      return { kind: "multicast", groupId: message.groupId, memberIds: message.audience.memberIds };
    return { kind: "group", groupId: message.groupId };
  };
  const destinations: Destination[] = [
    { kind: "foreman" },
    ...groups.flatMap((group): Destination[] => [
      { kind: "group", groupId: group.id },
      ...Object.values(config.groups[group.id]?.agents ?? {}).map(
        (member): Destination => ({ kind: "member", groupId: group.id, memberId: member.memberId }),
      ),
    ]),
  ];
  const send = async (draftKey: string, target: Destination, thread?: CommunicationThread) => {
    const text = drafts[draftKey] ?? "";
    if (!text.trim() || sending !== undefined) return;
    const signature = JSON.stringify({ text, target, threadId: thread?.id, replyEntryId, teamId });
    const previous = retries.current.get(draftKey);
    const requestId = previous?.signature === signature ? previous.id : crypto.randomUUID();
    retries.current.set(draftKey, { signature, id: requestId });
    setSending(draftKey);
    setError(undefined);
    try {
      if (target.kind === "foreman") {
        const parent = thread?.entries.find((entry) => entry.kind === "foreman-message");
        const context =
          parent?.kind === "foreman-message" ? parent.message.teamId : teamId || undefined;
        const relatedRequest = thread?.requests[0];
        const outgoing =
          parent === undefined && relatedRequest !== undefined
            ? `Regarding the conversation with ${memberName(relatedRequest.groupId, relatedRequest.memberId)} (${relatedRequest.id}):\n\n${text}`
            : text;
        await onSendForeman({
          requestId,
          text: outgoing,
          ...(context === undefined ? {} : { teamId: context }),
          ...(parent?.kind === "foreman-message" ? { replyTo: parent.message.id } : {}),
        });
      } else {
        const group = groups.find((entry) => entry.id === target.groupId);
        if (group === undefined) throw new Error("The selected team is unavailable.");
        const parent =
          selectedEntry?.kind === "team-message" && thread !== undefined
            ? selectedEntry.message
            : undefined;
        const command = SubmitMessageCommandSchema.parse({
          sender: { kind: "operator", operatorId: "portal-operator" },
          intent: parent === undefined ? "request" : "response",
          audience:
            target.kind === "member"
              ? { kind: "dm", memberId: target.memberId }
              : target.kind === "multicast"
                ? { kind: "multicast", memberIds: target.memberIds }
                : { kind: "group", membershipRevision: group.membershipRevision },
          body: { contentType: "text/markdown", text },
          delivery: {},
          ...(parent === undefined
            ? {}
            : { conversationId: parent.conversationId, replyTo: parent.id }),
        });
        const result = await client.submitMessage(target.groupId, command, requestId);
        setTeamPages((current) => ({
          ...current,
          [target.groupId]: [
            ...(current[target.groupId] ?? []).filter(
              (message) => message.id !== result.message.id,
            ),
            result.message,
          ],
        }));
        setDeliveries((current) => [
          ...current.filter((outcome) => outcome.messageId !== result.message.id),
          ...result.deliveryOutcomes,
        ]);
      }
      retries.current.delete(draftKey);
      setDrafts((current) => ({ ...current, [draftKey]: "" }));
      feedNearBottom.current = true;
      threadNearBottom.current = true;
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(
        toPortalError(
          cause,
          target.kind === "foreman" ? "Foreman operation failed" : "Unable to send message",
        ),
      );
    } finally {
      setSending(undefined);
    }
  };
  const loadEarlier = async () => {
    setLoadingOlder(true);
    try {
      if (hasMore) onLoadMore();
      await Promise.all(
        groups
          .filter((group) => older[group.id] && (!teamId || teamId === group.id))
          .map(async (group) => {
            const first = teamPages[group.id]?.[0]?.groupSeq;
            if (first === undefined) return;
            const page = await client.loadMessages(group.id, { limit: 100, before: first });
            const feed = feedRef.current;
            const height = feed?.scrollHeight ?? 0;
            mergePage(group.id, page, true);
            requestAnimationFrame(() => {
              if (feed !== null) feed.scrollTop += feed.scrollHeight - height;
            });
          }),
      );
    } catch (cause) {
      setError(toPortalError(cause, "Unable to load earlier messages"));
    } finally {
      setLoadingOlder(false);
    }
  };

  const delivery = (entry: CommunicationEntry) => {
    if (entry.kind === "member-question")
      return (
        <span
          className={`comms-status${attentionStates.has(entry.request.state) ? " comms-status-warning" : ""}`}
          title={entry.request.problem}
        >
          {requestLabels[entry.request.state]}
        </span>
      );
    if (entry.kind === "member-reply")
      return (
        <span className="comms-status comms-status-replied">
          <CheckCheck size={12} />
          Reply received
        </span>
      );
    if (entry.kind === "foreman-message") {
      if (entry.message.sender.kind === "foreman") return null;
      const state = inbox.find((item) => item.messageId === entry.message.id)?.state;
      const replied = messages.some(
        (message) => message.replyTo === entry.message.id && message.sender.kind === "foreman",
      );
      return (
        <span className="comms-status">
          {replied ? (
            <>
              <CheckCheck size={12} />
              Foreman responded
            </>
          ) : state === "submitted" ? (
            "Sent to Foreman"
          ) : state === "ambiguous" ? (
            "Delivery uncertain"
          ) : state === "cancelled" ? (
            "Cancelled"
          ) : (
            "Queued for Foreman"
          )}
        </span>
      );
    }
    const outcomes = deliveries.filter((outcome) => outcome.messageId === entry.message.id);
    const delivered = outcomes.filter((outcome) => outcome.status === "terminal_injected").length;
    return outcomes.length === 0 ? null : (
      <details className="comms-delivery">
        <summary title="Terminal delivery receipts; replies are shown separately in the thread">
          {delivered === outcomes.length ? <Check size={13} /> : <Clock size={13} />}Delivery:{" "}
          {delivered}/{outcomes.length} terminal receipts
          <ChevronDown size={13} />
        </summary>
        <ul>
          {outcomes.map((outcome) => (
            <li key={outcome.recipientMemberId}>
              {memberName(entry.message.groupId, outcome.recipientMemberId)}:{" "}
              {outcome.status === "terminal_injected" ? "Delivered to terminal" : outcome.status}
              {outcome.reason && ` · ${outcome.reason}`}
            </li>
          ))}
        </ul>
      </details>
    );
  };
  const row = (entry: CommunicationEntry, compact = false) => {
    const sender = actor(entry);
    return (
      <article key={entry.id} className={`comms-message comms-message-${sender.kind}`}>
        <span className={`comms-avatar comms-avatar-${sender.kind}`} aria-hidden="true">
          {sender.kind === "foreman" ? (
            <Bot size={19} />
          ) : (
            sender.name
              .split(/\s+/)
              .map((part) => part[0])
              .slice(0, 2)
              .join("")
          )}
        </span>
        <div className="comms-message-content">
          <header>
            <strong>{sender.name}</strong>
            <span className="comms-message-context">{sender.detail}</span>
            <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>
              {time(entry.createdAt)}
            </time>
          </header>
          <MessageBody text={entry.text} compact={compact} />
          <div className="comms-message-meta">{delivery(entry)}</div>
          {entry.kind === "member-question" && entry.request.problem && (
            <p className="comms-problem">{entry.request.problem}</p>
          )}
        </div>
      </article>
    );
  };
  const composer = (draftKey: string, target: Destination, thread?: CommunicationThread) => {
    const text = drafts[draftKey] ?? "";
    const limit = target.kind === "foreman" ? 32768 : 1_048_576;
    const tooLong = new TextEncoder().encode(text).length > limit;
    const missing = teamId !== "" && !groups.some((group) => group.id === teamId);
    return (
      <form
        className="comms-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draftKey, target, thread);
        }}
      >
        <div className="comms-composer-label">
          {thread ? "Reply in this thread" : "New message"}
        </div>
        <div className="comms-composer-target">
          <span>To</span>
          {thread ? (
            <strong>{targetName(target)}</strong>
          ) : (
            <select
              aria-label="Message recipient"
              value={JSON.stringify(destination)}
              onChange={(event) =>
                setDestination(
                  destinations.find((option) => JSON.stringify(option) === event.target.value) ?? {
                    kind: "foreman",
                  },
                )
              }
            >
              {destinations.map((option) => (
                <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
                  {targetName(option)}
                </option>
              ))}
            </select>
          )}
          {target.kind === "foreman" && teamId && (
            <span className="comms-context-tag">{groupName(teamId)}</span>
          )}
        </div>
        <textarea
          ref={thread ? replyRef : undefined}
          aria-label={
            thread
              ? "Reply in thread"
              : target.kind === "foreman"
                ? "Message Foreman"
                : "Message agents"
          }
          placeholder={thread ? `Reply to ${targetName(target)}` : `Message ${targetName(target)}`}
          rows={2}
          value={text}
          disabled={sending === draftKey}
          onChange={(event) =>
            setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="comms-composer-footer">
          <span>{tooLong ? "Message exceeds the size limit" : ""}</span>
          <button
            className="comms-send"
            type="submit"
            title={thread ? "Send thread reply" : "Start a new conversation"}
            aria-label={thread ? "Send reply" : "Send"}
            disabled={!text.trim() || tooLong || missing || sending !== undefined}
          >
            <Send size={16} />
            <span>{sending === draftKey ? "Sending…" : thread ? "Reply" : "Send"}</span>
          </button>
        </div>
      </form>
    );
  };

  return (
    <div className={`comms-workspace${selected ? " comms-thread-open" : ""}`}>
      <header className="comms-toolbar">
        <div className="comms-channel-name">
          <Hash size={21} />
          <select
            aria-label="Context"
            value={teamId}
            onChange={(event) => {
              onTeamChange(event.target.value);
              setSelectedId(undefined);
            }}
          >
            {teamId && !groups.some((group) => group.id === teamId) && (
              <option value={teamId}>Unavailable team</option>
            )}
            <option value="">Repository</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          <span className="comms-member-count" title="Configured team members">
            <Users size={14} />
            {Object.values(config.groups).flatMap((group) => Object.values(group.agents)).length}
          </span>
        </div>
        <div className="comms-filters">
          <label className="comms-search">
            <Search size={15} />
            <input
              type="search"
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Conversation status"
            value={activityFilter}
            onChange={(event) => setActivityFilter(event.target.value)}
          >
            <option value="all">All activity</option>
            <option value="pending">Awaiting replies</option>
            <option value="attention">Needs attention</option>
          </select>
          {teamId && (
            <button
              className="icon-button"
              title={`Open ${groupName(teamId)} messages`}
              aria-label="Back to team"
              onClick={() => onNavigate(`/groups/${encodeURIComponent(teamId)}/messages`)}
            >
              <ArrowUpRight size={16} />
            </button>
          )}
        </div>
      </header>
      {loadFailures.length > 0 && (
        <div className="comms-load-error" role="status">
          Messages unavailable: {loadFailures.map(groupName).join(", ")}.{" "}
          <button onClick={() => setRefresh((value) => value + 1)}>Retry</button>
        </div>
      )}
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      <div className="comms-columns">
        <section className="comms-main" aria-label="Channel">
          <div
            className="comms-feed"
            role="log"
            aria-label="Repository communication"
            aria-live="polite"
            ref={feedRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              feedNearBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
              if (feedNearBottom.current) setNewActivity(false);
            }}
          >
            {(hasMore || Object.values(older).some(Boolean)) && (
              <button
                className="comms-history-button"
                disabled={loadingOlder}
                onClick={() => void loadEarlier()}
              >
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {visibleThreads.length === 0 && (
              <div className="comms-empty">
                <MessageSquare size={28} />
                <strong>
                  {query || activityFilter !== "all"
                    ? "No matching conversations"
                    : "No messages yet"}
                </strong>
                {(query || activityFilter !== "all") && (
                  <button
                    className="comms-text-button"
                    onClick={() => {
                      setQuery("");
                      setActivityFilter("all");
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
            {visibleThreads.map((thread, index) => {
              const root = thread.entries[0]!;
              const responses = thread.entries.slice(1);
              const preview = responses.at(-1);
              const queued = thread.requests.filter((request) => request.state === "queued").length;
              const awaiting = thread.requests.filter(
                (request) => request.state === "submitted",
              ).length;
              const attention = thread.requests.filter((request) =>
                attentionStates.has(request.state),
              ).length;
              return (
                <div
                  className={`comms-thread-summary${selectedId === thread.id ? " comms-thread-selected" : ""}`}
                  key={thread.id}
                >
                  {(index === 0 ||
                    day(visibleThreads[index - 1]!.startedAt) !== day(thread.startedAt)) && (
                    <div className="comms-day-divider">
                      <span>{day(thread.startedAt)}</span>
                    </div>
                  )}
                  {row(root, true)}
                  <div className="comms-thread-footer">
                    <button
                      className="comms-thread-button"
                      onClick={() => openThread(thread)}
                      aria-label={`Open thread: ${root.text.slice(0, 80)}`}
                      aria-expanded={selectedId === thread.id}
                    >
                      <MessageSquare size={14} />
                      <strong>
                        {responses.length
                          ? `${responses.length} ${responses.length === 1 ? "update" : "updates"}`
                          : "Reply in thread"}
                      </strong>
                      {preview && <span>Last update {time(preview.createdAt)}</span>}
                    </button>
                    {queued > 0 && <span className="comms-pending">{queued} queued</span>}
                    {awaiting > 0 && (
                      <span className="comms-pending">{awaiting} awaiting reply</span>
                    )}
                    {attention > 0 && (
                      <span className="comms-attention">{attention} need attention</span>
                    )}
                  </div>
                  {preview && (
                    <button className="comms-latest-preview" onClick={() => openThread(thread)}>
                      <strong>{actor(preview).name}</strong>
                      <span className="comms-preview-text">
                        <Markdown
                          skipHtml
                          disallowedElements={["a", "img", "pre", "table"]}
                          unwrapDisallowed
                        >
                          {preview.text}
                        </Markdown>
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {newActivity && (
            <button
              className="comms-jump"
              onClick={() => {
                if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
                feedNearBottom.current = true;
                setNewActivity(false);
              }}
            >
              <ArrowDown size={14} />
              New activity
            </button>
          )}
          {composer(`new:${JSON.stringify(destination)}:${teamId}`, destination)}
        </section>
        {selected && (
          <aside className="comms-thread" aria-label="Conversation thread">
            <header className="comms-thread-heading">
              <button
                className="icon-button comms-thread-back"
                title="Back to channel"
                aria-label="Back to channel"
                onClick={() => setSelectedId(undefined)}
              >
                <ArrowLeft size={17} />
              </button>
              <div>
                <h3>Thread</h3>
                <span>
                  {selected.channel === "foreman"
                    ? "Foreman coordination"
                    : groupName(selected.groupId!)}
                </span>
              </div>
              <button
                className="icon-button"
                title="Close thread"
                aria-label="Close thread"
                onClick={() => setSelectedId(undefined)}
              >
                <X size={17} />
              </button>
            </header>
            <div className="comms-thread-topic">
              <strong>{actor(selected.entries[0]!).name}</strong>
              <p>{selected.entries[0]!.text.split("\n")[0]}</p>
            </div>
            <div
              className="comms-thread-feed"
              ref={threadRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                threadNearBottom.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                if (threadNearBottom.current) setNewThreadActivity(false);
              }}
            >
              {selected.entries.map((entry) => (
                <div key={entry.id}>
                  {row(entry)}
                  <div className="comms-entry-actions">
                    <button
                      className="comms-text-button"
                      onClick={() => {
                        setReplyEntryId(entry.id);
                        replyRef.current?.focus();
                      }}
                    >
                      <MessageSquare size={12} />
                      {selected.channel === "foreman"
                        ? "Reply to Foreman"
                        : `Reply to ${actor(entry).name === "You" ? "recipient" : actor(entry).name}`}
                    </button>
                    {entry.kind === "member-question" &&
                      (pendingStates.has(entry.request.state) ||
                        entry.request.state === "ambiguous") && (
                        <button
                          className="comms-text-button"
                          onClick={() => void onCancelRequest(entry.request.id)}
                        >
                          <Square size={12} />
                          Cancel request
                        </button>
                      )}
                  </div>
                </div>
              ))}
            </div>
            {newThreadActivity && (
              <button
                className="comms-thread-jump"
                onClick={() => {
                  if (threadRef.current)
                    threadRef.current.scrollTop = threadRef.current.scrollHeight;
                  threadNearBottom.current = true;
                  setNewThreadActivity(false);
                }}
              >
                <ArrowDown size={13} />
                New thread activity
              </button>
            )}
            {composer(selected.id, replyDestination(), selected)}
          </aside>
        )}
      </div>
    </div>
  );
}
