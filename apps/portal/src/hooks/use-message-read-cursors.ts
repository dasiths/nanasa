import type { Group, GroupMessageState } from "@nanasa/contracts";
import { useEffect, useState } from "react";

export const MESSAGE_READ_CURSORS_KEY = "nanasa.message-read-cursors.v1";

const cursorsEvent = "nanasa:message-read-cursors";

interface StoredCursor {
  repository: string;
  groupId: string;
  groupCreatedAt: string;
  sequence: number;
}

function cursorKey(repository: string, groupId: string, groupCreatedAt: string): string {
  return JSON.stringify([repository, groupId, groupCreatedAt]);
}

function parseCursors(value: string | null): Map<string, number> {
  const cursors = new Map<string, number>();
  if (value === null) return cursors;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return cursors;
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record.repository !== "string" ||
        typeof record.groupId !== "string" ||
        typeof record.groupCreatedAt !== "string" ||
        typeof record.sequence !== "number" ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence < 0
      ) {
        continue;
      }
      cursors.set(
        cursorKey(record.repository, record.groupId, record.groupCreatedAt),
        record.sequence,
      );
    }
  } catch {
    return new Map();
  }
  return cursors;
}

function readCursors(): Map<string, number> {
  try {
    return parseCursors(window.localStorage.getItem(MESSAGE_READ_CURSORS_KEY));
  } catch {
    return new Map();
  }
}

function persistCursors(cursors: ReadonlyMap<string, number>): void {
  const stored: StoredCursor[] = [...cursors].flatMap(([key, sequence]) => {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every(String)) return [];
    return [
      {
        repository: parsed[0] as string,
        groupId: parsed[1] as string,
        groupCreatedAt: parsed[2] as string,
        sequence,
      },
    ];
  });
  try {
    window.localStorage.setItem(MESSAGE_READ_CURSORS_KEY, JSON.stringify(stored));
  } catch {
    // Read state remains usable for this tab when browser storage is blocked.
  }
}

function mergeCursors(
  current: ReadonlyMap<string, number>,
  incoming: ReadonlyMap<string, number>,
): Map<string, number> {
  const merged = new Map(current);
  for (const [key, sequence] of incoming) {
    merged.set(key, Math.max(merged.get(key) ?? 0, sequence));
  }
  return merged;
}

function cursorsEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

export function messageUnreadCount(state: GroupMessageState, cursor = 0): number {
  if (state.retainedMessageCount === 0) return 0;
  const oldest = state.oldestRetainedGroupSeq ?? state.latestGroupSeq;
  const validCursor = cursor <= state.latestGroupSeq ? cursor : 0;
  const unread = state.latestGroupSeq - Math.max(validCursor, oldest - 1);
  return Math.min(state.retainedMessageCount, Math.max(0, unread));
}

export function useMessageReadCursors(
  repository: string | undefined,
  groups: readonly Group[],
  states: readonly GroupMessageState[],
) {
  const [cursors, setCursors] = useState<Map<string, number>>(readCursors);
  const namespace = repository ?? window.location.origin;
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key !== MESSAGE_READ_CURSORS_KEY) return;
      const incoming = parseCursors(event.newValue);
      setCursors((current) => {
        const merged = mergeCursors(current, incoming);
        if ([...merged].some(([key, sequence]) => sequence > (incoming.get(key) ?? 0))) {
          persistCursors(merged);
        }
        return cursorsEqual(current, merged) ? current : merged;
      });
    };
    const synchronizeCurrentTab = (event: Event) => {
      setCursors((current) =>
        (() => {
          const merged = mergeCursors(
            current,
            (event as CustomEvent<ReadonlyMap<string, number>>).detail,
          );
          return cursorsEqual(current, merged) ? current : merged;
        })(),
      );
    };
    window.addEventListener("storage", synchronize);
    window.addEventListener(cursorsEvent, synchronizeCurrentTab);
    return () => {
      window.removeEventListener("storage", synchronize);
      window.removeEventListener(cursorsEvent, synchronizeCurrentTab);
    };
  }, []);

  const unreadCounts = new Map<string, number>();
  for (const state of states) {
    const group = groupsById.get(state.groupId);
    if (group === undefined) continue;
    const key = cursorKey(namespace, group.id, group.createdAt);
    unreadCounts.set(group.id, messageUnreadCount(state, cursors.get(key)));
  }

  const markReadThrough = (groupId: string, sequence: number) => {
    const group = groupsById.get(groupId);
    if (group === undefined || !Number.isSafeInteger(sequence) || sequence < 0) return;
    const key = cursorKey(namespace, group.id, group.createdAt);
    setCursors((current) => {
      const next = mergeCursors(current, readCursors());
      if ((next.get(key) ?? 0) >= sequence) {
        return cursorsEqual(current, next) ? current : next;
      }
      next.set(key, sequence);
      persistCursors(next);
      window.dispatchEvent(new CustomEvent(cursorsEvent, { detail: next }));
      return next;
    });
  };

  return { unreadCounts, markReadThrough };
}
