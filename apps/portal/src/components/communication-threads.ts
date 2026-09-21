import type { ForemanChannelMessage, ForemanConversationRequest, Message } from "@nanasa/contracts";

export type TeamCommunication = Pick<
  Message,
  | "id"
  | "groupId"
  | "conversationId"
  | "replyTo"
  | "createdAt"
  | "sender"
  | "body"
  | "audience"
  | "intent"
>;

export type CommunicationEntry =
  | {
      kind: "foreman-message";
      id: string;
      createdAt: string;
      text: string;
      message: ForemanChannelMessage;
    }
  | {
      kind: "member-question";
      id: string;
      createdAt: string;
      text: string;
      request: ForemanConversationRequest;
    }
  | {
      kind: "member-reply";
      id: string;
      createdAt: string;
      text: string;
      request: ForemanConversationRequest;
    }
  | {
      kind: "team-message";
      id: string;
      createdAt: string;
      text: string;
      message: TeamCommunication;
    };

export interface CommunicationThread {
  id: string;
  channel: "foreman" | "team";
  groupId: string | undefined;
  entries: CommunicationEntry[];
  requests: ForemanConversationRequest[];
  startedAt: string;
  updatedAt: string;
}

export function communicationThreads(
  messages: readonly ForemanChannelMessage[],
  requests: readonly ForemanConversationRequest[],
  teamMessages: readonly TeamCommunication[] = [],
): CommunicationThread[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const threads = new Map<string, CommunicationThread>();
  const rootMessage = (id: string): string => {
    const visited = new Set<string>();
    let current = id;
    while (!visited.has(current)) {
      visited.add(current);
      const parent = messagesById.get(current)?.replyTo;
      if (parent === undefined) return current;
      current = parent;
    }
    return [...visited].sort()[0]!;
  };
  const requestRoot = (request: ForemanConversationRequest): string => {
    const visited = new Set<string>();
    let current = request;
    while (!visited.has(current.id)) {
      visited.add(current.id);
      if (current.sourceMessageId !== undefined)
        return `foreman:${rootMessage(current.sourceMessageId)}`;
      const parent = current.replyTo === undefined ? undefined : requestsById.get(current.replyTo);
      if (parent === undefined) break;
      current = parent;
    }
    return `conversation:${current.conversationId}`;
  };
  const append = (
    id: string,
    channel: CommunicationThread["channel"],
    groupId: string | undefined,
    entry: CommunicationEntry,
  ) => {
    const thread: CommunicationThread = threads.get(id) ?? {
      id,
      channel,
      groupId,
      entries: [],
      requests: [],
      startedAt: entry.createdAt,
      updatedAt: entry.createdAt,
    };
    if (!thread.entries.some((existing) => existing.id === entry.id)) thread.entries.push(entry);
    if (entry.createdAt < thread.startedAt) thread.startedAt = entry.createdAt;
    if (entry.createdAt > thread.updatedAt) thread.updatedAt = entry.createdAt;
    threads.set(id, thread);
    return thread;
  };
  for (const message of messages) {
    append(
      `foreman:${rootMessage(message.id)}`,
      "foreman",
      messagesById.get(rootMessage(message.id))?.teamId ?? message.teamId,
      {
        kind: "foreman-message",
        id: `message:${message.id}`,
        createdAt: message.createdAt,
        text: message.text,
        message,
      },
    );
  }
  for (const request of requests) {
    const id = requestRoot(request);
    const thread = append(id, "foreman", request.groupId, {
      kind: "member-question",
      id: `question:${request.id}`,
      createdAt: request.createdAt,
      text: request.text,
      request,
    });
    if (!thread.requests.some((existing) => existing.id === request.id))
      thread.requests.push(request);
    if (request.state === "answered" && request.response !== undefined) {
      append(id, "foreman", request.groupId, {
        kind: "member-reply",
        id: `reply:${request.id}`,
        createdAt: request.answeredAt ?? request.createdAt,
        text: request.response,
        request,
      });
    }
  }
  for (const message of teamMessages) {
    append(`team:${message.groupId}:${message.conversationId}`, "team", message.groupId, {
      kind: "team-message",
      id: `team-message:${message.id}`,
      createdAt: message.createdAt,
      text: message.body.text,
      message,
    });
  }
  for (const thread of threads.values())
    thread.entries.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  return [...threads.values()].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
  );
}
