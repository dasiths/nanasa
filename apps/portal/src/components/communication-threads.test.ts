import type { ForemanChannelMessage, ForemanConversationRequest } from "@nanasa/contracts";
import { describe, expect, it } from "vitest";
import { communicationThreads, type TeamCommunication } from "./communication-threads.js";

const timestamp = "2026-09-12T16:00:00.000Z";
const human: ForemanChannelMessage = {
  id: "human-one",
  sequence: 1,
  sender: { kind: "operator", operatorId: "human" },
  text: "Ask the teams for status",
  createdAt: timestamp,
};
const question: ForemanConversationRequest = {
  id: "question-one",
  requestId: "ask-one",
  foremanId: "foreman",
  conversationId: "conversation-one",
  groupId: "backend",
  memberId: "engineer-one",
  memberProfileId: "profile-one",
  authorityRevision: 0,
  sourceMessageId: human.id,
  text: "What is your status?",
  state: "submitted",
  createdAt: "2026-09-12T16:01:00.000Z",
  expiresAt: "2026-09-12T17:01:00.000Z",
  expiresInSeconds: 3600,
};

describe("repository communication threads", () => {
  it("groups a Human request, Foreman updates and actual member replies together", () => {
    const update: ForemanChannelMessage = {
      ...human,
      id: "update-one",
      sequence: 2,
      replyTo: human.id,
      sender: {
        kind: "foreman",
        foremanId: "foreman",
        runId: "foreman-run",
        generation: 1,
        authorityRevision: 0,
      },
      text: "One reply received",
      createdAt: "2026-09-12T16:03:00.000Z",
    };
    const threads = communicationThreads(
      [update, human],
      [
        {
          ...question,
          state: "answered",
          response: "Ready for review",
          answeredAt: "2026-09-12T16:02:00.000Z",
        },
      ],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]?.entries.map((entry) => entry.kind)).toEqual([
      "foreman-message",
      "member-question",
      "member-reply",
      "foreman-message",
    ]);
    expect(threads[0]?.startedAt).toBe(timestamp);
  });

  it("does not turn submitted delivery into a member reply", () => {
    const threads = communicationThreads([human], [question]);
    expect(threads[0]?.entries.some((entry) => entry.kind === "member-reply")).toBe(false);
    expect(threads[0]?.requests[0]?.state).toBe("submitted");
  });

  it("keeps follow-up questions in their original thread without a new source message", () => {
    const followup = {
      ...question,
      id: "question-two",
      sourceMessageId: undefined,
      replyTo: question.id,
      createdAt: "2026-09-12T16:04:00.000Z",
    };
    const threads = communicationThreads([human], [question, followup]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.requests).toHaveLength(2);
  });

  it("keeps identically named team conversations isolated by group", () => {
    const message: TeamCommunication = {
      id: "team-message-one",
      groupId: "backend",
      conversationId: "shared-id",
      sender: { kind: "operator", operatorId: "human" },
      audience: { kind: "dm", memberId: "engineer-one" },
      intent: "request",
      body: { contentType: "text/markdown", text: "Review this" },
      createdAt: timestamp,
    };
    expect(
      communicationThreads(
        [],
        [],
        [message, { ...message, id: "team-message-two", groupId: "frontend" }],
      ),
    ).toHaveLength(2);
  });

  it("retains orphan replies and terminates malformed reply cycles", () => {
    const orphan = { ...human, id: "reply-one", replyTo: "older-message" };
    expect(communicationThreads([orphan], [question])).toHaveLength(2);
    expect(
      communicationThreads(
        [
          { ...human, replyTo: "other" },
          { ...human, id: "other", replyTo: human.id },
        ],
        [],
      ),
    ).toHaveLength(1);
  });
});
