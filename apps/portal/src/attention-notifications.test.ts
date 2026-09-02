import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, AttentionItemKind } from "./attention-items.js";
import {
  attentionNotificationTier,
  deliverAttentionDesktopNotification,
  deriveVisibleTerminalRunIds,
  routeOwnsAttentionItem,
  useAttentionNotifications,
} from "./attention-notifications.js";
import type { PortalRoute } from "./router/portal-router.js";

function item(
  kind: AttentionItemKind,
  id = `attention:${kind}`,
  overrides: Record<string, unknown> = {},
): AttentionItem {
  return {
    id,
    sourceIdentity: `${kind}:source`,
    kind,
    category:
      kind === "wait" || kind === "response"
        ? "response"
        : kind === "action"
          ? "progress"
          : kind === "unread"
            ? "updates"
            : kind,
    urgency: "none",
    counted: kind !== "action" && kind !== "unread",
    review: kind !== "action" && kind !== "unread",
    scope: { kind: "group", groupId: "group-one" },
    groupId: "group-one",
    group: {
      id: "group-one",
      name: "Group One",
      order: 0,
      membershipRevision: 1,
      createdAt: "2026-08-31T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    },
    memberId: "member-one",
    runId: "run-one",
    generation: 1,
    label: "Builder",
    title: `Builder · ${kind}`,
    summary: `${kind} summary`,
    targetPath:
      kind === "wait" || kind === "action"
        ? `/groups/group-one/activity#${kind}-one`
        : kind === "delivery" || kind === "unread"
          ? "/groups/group-one/messages"
          : "/groups/group-one/terminals/run-one",
    ...(kind === "health" ? { healthType: "stuck" } : {}),
    ...overrides,
  } as unknown as AttentionItem;
}

const agentDirectory: PortalRoute = { kind: "global", destination: "agents" };
const preferences = {
  inApp: true,
  desktop: false,
  sound: false,
  completionNotificationMemberIdsByGroup: {},
};

function hookProps(items: readonly AttentionItem[], route: PortalRoute = agentDirectory) {
  return {
    items,
    ready: true,
    hydrationKey: "instance-one:1",
    route,
    visibleTerminalRunIds: new Set<string>(),
    preferences,
    navigate: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("typed Attention notification policy", () => {
  it("maps every source kind and health subtype to its required tier", () => {
    expect(attentionNotificationTier(item("wait"))).toBe("urgent");
    expect(attentionNotificationTier(item("response"))).toBe("urgent");
    expect(attentionNotificationTier(item("health", "failed", { healthType: "failed" }))).toBe(
      "urgent",
    );
    expect(attentionNotificationTier(item("health", "stuck", { healthType: "stuck" }))).toBe(
      "standard",
    );
    expect(attentionNotificationTier(item("delivery"))).toBe("standard");
    expect(attentionNotificationTier(item("completion"))).toBe("quiet");
    expect(attentionNotificationTier(item("action"))).toBe("none");
    expect(attentionNotificationTier(item("unread"))).toBe("none");
  });

  it("recognizes only the exact screen that owns an item", () => {
    const wait = item("wait");
    const health = item("health", "health", { healthType: "failed" });
    const delivery = item("delivery");
    expect(
      routeOwnsAttentionItem({ kind: "global", destination: "attention" }, wait, new Set()),
    ).toBe(true);
    expect(
      routeOwnsAttentionItem(
        { kind: "group", groupId: "group-one", section: "activity" },
        wait,
        new Set(),
      ),
    ).toBe(true);
    expect(
      routeOwnsAttentionItem(
        {
          kind: "group",
          groupId: "group-one",
          section: "terminals",
          runId: "run-one",
        },
        health,
        new Set(["run-one"]),
      ),
    ).toBe(true);
    expect(
      routeOwnsAttentionItem(
        { kind: "group", groupId: "group-one", section: "terminals" },
        health,
        new Set(["run-one"]),
      ),
    ).toBe(true);
    expect(
      routeOwnsAttentionItem(
        { kind: "group", groupId: "group-one", section: "messages" },
        delivery,
        new Set(),
      ),
    ).toBe(true);
  });

  it("derives terminal pane visibility for the canvas and Focus mode", () => {
    const terminalRoute: PortalRoute = {
      kind: "group",
      groupId: "group-one",
      section: "terminals",
    };
    const options = {
      route: terminalRoute,
      runIds: ["run-one", "run-two"],
    } as const;

    expect([...deriveVisibleTerminalRunIds(options)]).toEqual(["run-one", "run-two"]);
    expect([
      ...deriveVisibleTerminalRunIds({
        ...options,
        route: { ...terminalRoute, runId: "run-one" },
      }),
    ]).toEqual(["run-one", "run-two"]);
    expect([
      ...deriveVisibleTerminalRunIds({
        ...options,
        focusedRunId: "run-two",
      }),
    ]).toEqual(["run-two"]);
    expect([
      ...deriveVisibleTerminalRunIds({
        ...options,
        route: { kind: "global", destination: "agents" },
      }),
    ]).toEqual([]);
  });
});

describe("Attention notification transitions", () => {
  it("seeds hydration, resets by daemon identity, and never replays visible-target items", () => {
    const wait = item("wait");
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof hookProps>) => useAttentionNotifications(props),
      { initialProps: hookProps([wait]) },
    );
    expect(result.current.toasts).toEqual([]);

    rerender({
      ...hookProps([wait, item("delivery")]),
      route: { kind: "global", destination: "attention" },
    });
    expect(result.current.toasts).toEqual([]);
    rerender(hookProps([wait, item("delivery")]));
    expect(result.current.toasts).toEqual([]);

    rerender({ ...hookProps([wait, item("delivery")]), hydrationKey: "instance-one:2" });
    expect(result.current.toasts).toEqual([]);
  });

  it("shows bounded in-app toasts with working Open and Dismiss actions", () => {
    const initial = {
      ...hookProps([]),
      preferences: {
        ...preferences,
        completionNotificationMemberIdsByGroup: { "group-one": ["member-one"] },
      },
    };
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof hookProps>) => useAttentionNotifications(props),
      { initialProps: initial },
    );
    const additions = [
      item("wait", "one"),
      item("delivery", "two"),
      item("completion", "three"),
      item("response", "four"),
    ];
    rerender({ ...initial, items: additions });
    expect(result.current.toasts.map((toast) => toast.id)).toEqual(["two", "three", "four"]);

    act(() => result.current.openToast(result.current.toasts[0]!));
    expect(initial.navigate).toHaveBeenCalledWith("/groups/group-one/messages");
    expect(result.current.toasts.map((toast) => toast.id)).toEqual(["three", "four"]);

    act(() => result.current.dismissToast("three"));
    expect(result.current.toasts.map((toast) => toast.id)).toEqual(["four"]);
  });

  it("records additions while in-app notices are disabled", () => {
    const initial = { ...hookProps([]), preferences: { ...preferences, inApp: false } };
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof hookProps>) => useAttentionNotifications(props),
      { initialProps: initial },
    );
    const completion = item("completion");
    rerender({ ...initial, items: [completion] });
    expect(result.current.toasts).toEqual([]);
    rerender({ ...hookProps([completion]), preferences });
    expect(result.current.toasts).toEqual([]);
  });

  it("records disabled completions so enabling notifications only applies to future revisions", () => {
    const initial = hookProps([]);
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof hookProps>) => useAttentionNotifications(props),
      { initialProps: initial },
    );
    const existingCompletion = item("completion", "completion-revision-one");
    rerender({ ...initial, items: [existingCompletion] });
    expect(result.current.toasts).toEqual([]);

    const enabledPreferences = {
      ...preferences,
      completionNotificationMemberIdsByGroup: { "group-one": ["member-one"] },
    };
    rerender({ ...initial, items: [existingCompletion], preferences: enabledPreferences });
    expect(result.current.toasts).toEqual([]);
    rerender({ ...initial, items: [], preferences: enabledPreferences });
    rerender({ ...initial, items: [existingCompletion], preferences: enabledPreferences });
    expect(result.current.toasts).toEqual([]);

    const futureCompletion = item("completion", "completion-revision-two");
    rerender({
      ...initial,
      items: [existingCompletion, futureCompletion],
      preferences: enabledPreferences,
    });
    expect(result.current.toasts).toMatchObject([{ id: "completion-revision-two", tier: "quiet" }]);
  });

  it("suppresses a visible completion pane but not an unrelated run", () => {
    const initial = {
      ...hookProps([], {
        kind: "group",
        groupId: "group-one",
        section: "terminals",
      }),
      visibleTerminalRunIds: new Set(["run-one"]),
      preferences: {
        ...preferences,
        completionNotificationMemberIdsByGroup: { "group-one": ["member-one"] },
      },
    };
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof hookProps>) => useAttentionNotifications(props),
      { initialProps: initial },
    );

    const visibleCompletion = item("completion", "visible-completion");
    rerender({ ...initial, items: [visibleCompletion] });
    expect(result.current.toasts).toEqual([]);

    const unrelatedCompletion = item("completion", "unrelated-completion", {
      runId: "run-two",
      targetPath: "/groups/group-one/terminals/run-two",
    });
    rerender({ ...initial, items: [visibleCompletion, unrelatedCompletion] });
    expect(result.current.toasts).toMatchObject([{ id: "unrelated-completion", tier: "quiet" }]);
  });

  it("delivers hidden standard items to desktop and sounds only for urgent items", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => boolean) =>
          Promise.resolve(callback()),
      },
    });
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { hasBeenActive: true },
    });
    const notifications: string[] = [];
    class TestNotification {
      public static readonly permission = "granted";
      public onclick: (() => void) | null = null;
      public close = vi.fn();

      public constructor(title: string) {
        notifications.push(title);
      }
    }
    vi.stubGlobal("Notification", TestNotification);
    const oscillator = {
      type: "sine",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    class TestAudioContext {
      public state = "running";
      public currentTime = 1;
      public destination = {};
      public createOscillator = vi.fn(() => oscillator);
      public createGain = vi.fn(() => ({
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }));
      public close = vi.fn();
    }
    vi.stubGlobal("AudioContext", TestAudioContext);
    const initial = {
      ...hookProps([]),
      preferences: {
        inApp: true,
        desktop: true,
        sound: true,
        completionNotificationMemberIdsByGroup: { "group-one": ["member-one"] },
      },
    };
    const { rerender } = renderHook(
      (props: ReturnType<typeof hookProps>) => useAttentionNotifications(props),
      { initialProps: initial },
    );
    const delivery = item("delivery");
    rerender({ ...initial, items: [delivery] });
    await waitFor(() => expect(notifications).toEqual(["Builder · delivery"]));
    expect(oscillator.start).not.toHaveBeenCalled();

    const wait = item("wait");
    rerender({ ...initial, items: [delivery, wait] });
    await waitFor(() => expect(oscillator.start).toHaveBeenCalledOnce());
    expect(notifications).toEqual(["Builder · delivery", "Builder · wait"]);

    rerender({
      ...initial,
      items: [delivery, wait, item("completion"), item("action"), item("unread")],
    });
    await waitFor(() => expect(notifications).toHaveLength(3));
    expect(notifications[2]).toBe("Builder · completion");
    expect(oscillator.start).toHaveBeenCalledOnce();
  });
});

describe("desktop Attention delivery", () => {
  it("uses an item-specific stable tag and opens the item target", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => boolean) =>
          Promise.resolve(callback()),
      },
    });
    const notifications: Array<{
      title: string;
      options: NotificationOptions | undefined;
      notification: TestNotification;
    }> = [];
    class TestNotification {
      public static readonly permission = "granted";
      public onclick: (() => void) | null = null;
      public close = vi.fn();

      public constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, options, notification: this });
      }
    }
    vi.stubGlobal("Notification", TestNotification);
    const navigate = vi.fn();
    const delivery = item("delivery", "delivery-specific");

    await expect(deliverAttentionDesktopNotification(delivery, navigate)).resolves.toBe(true);
    expect(notifications[0]).toMatchObject({
      title: "Builder · delivery",
      options: {
        body: "Group One · delivery summary",
        silent: true,
      },
    });
    expect(notifications[0]?.options?.tag).toMatch(/^nanasa-attention-[0-9a-f]{8}$/);
    notifications[0]?.notification.onclick?.();
    expect(navigate).toHaveBeenCalledWith("/groups/group-one/messages");
    expect(notifications[0]?.notification.close).toHaveBeenCalled();
    await expect(deliverAttentionDesktopNotification(delivery, navigate)).resolves.toBe(false);
  });

  it("falls back to the same stable tag when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const tags: Array<string | undefined> = [];
    class TestNotification {
      public static readonly permission = "granted";
      public onclick: (() => void) | null = null;
      public close = vi.fn();

      public constructor(_title: string, options?: NotificationOptions) {
        tags.push(options?.tag);
      }
    }
    vi.stubGlobal("Notification", TestNotification);
    const delivery = item("delivery", "no-lock-delivery");

    await expect(deliverAttentionDesktopNotification(delivery, vi.fn())).resolves.toBe(true);
    await expect(deliverAttentionDesktopNotification(delivery, vi.fn())).resolves.toBe(true);
    expect(tags).toEqual([
      expect.stringMatching(/^nanasa-attention-[0-9a-f]{8}$/),
      expect.stringMatching(/^nanasa-attention-[0-9a-f]{8}$/),
    ]);
    expect(tags[1]).toBe(tags[0]);
  });

  it("falls back to a stable tag when local storage claiming is unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: unknown, callback: () => boolean) =>
          Promise.resolve(callback()),
      },
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const tags: Array<string | undefined> = [];
    class TestNotification {
      public static readonly permission = "granted";
      public onclick: (() => void) | null = null;
      public close = vi.fn();

      public constructor(_title: string, options?: NotificationOptions) {
        tags.push(options?.tag);
      }
    }
    vi.stubGlobal("Notification", TestNotification);

    await expect(
      deliverAttentionDesktopNotification(item("delivery", "storage-failure"), vi.fn()),
    ).resolves.toBe(true);
    expect(tags[0]).toMatch(/^nanasa-attention-[0-9a-f]{8}$/);
  });
});
