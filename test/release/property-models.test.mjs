import assert from "node:assert/strict";
import { test } from "node:test";

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function integer(next, maximum) {
  return Math.floor(next() * maximum);
}

for (const seed of [11, 29, 113, 20260830]) {
  test(`fixed-seed state models preserve release invariants (${seed})`, () => {
    const next = random(seed);
    const topology = new Map();
    const deliveries = new Map();
    const actions = new Map();
    const leases = new Map();
    const worktrees = new Map();
    let eventSequence = 0;
    let schema = 1;
    for (let step = 0; step < 2_000; step += 1) {
      const id = `id-${integer(next, 64)}`;
      switch (integer(next, 7)) {
        case 0:
          topology.set(id, (topology.get(id) ?? 0) + 1);
          break;
        case 1: {
          const previous = deliveries.get(id) ?? "queued";
          const transitions = {
            queued: ["leased", "expired"],
            leased: ["terminal_injected", "retryable", "dead_letter"],
            retryable: ["leased", "expired"],
            terminal_injected: [],
            expired: [],
            dead_letter: [],
          };
          const allowed = transitions[previous];
          if (allowed.length > 0) deliveries.set(id, allowed[integer(next, allowed.length)]);
          break;
        }
        case 2: {
          const previous = actions.get(id) ?? "created";
          const transitions = {
            created: ["submitted", "cancelled", "rejected"],
            submitted: ["accepted", "stalled", "superseded"],
            accepted: ["started", "failed", "cancelled"],
            started: ["completed", "failed", "blocked"],
            blocked: ["started", "failed", "cancelled"],
            completed: [],
            failed: [],
            cancelled: [],
            rejected: [],
            stalled: [],
            superseded: [],
          };
          const allowed = transitions[previous];
          if (allowed.length > 0) actions.set(id, allowed[integer(next, allowed.length)]);
          break;
        }
        case 3:
          leases.set(id, (leases.get(id) ?? 0) + 1);
          break;
        case 4:
          eventSequence += 1;
          break;
        case 5:
          if (!worktrees.has(id)) worktrees.set(id, `generation-${step}`);
          break;
        case 6:
          if (next() > 0.98) schema += 1;
          break;
      }
      assert.ok([...topology.values()].every((revision) => revision > 0));
      assert.ok([...leases.values()].every((generation) => generation > 0));
      assert.ok(eventSequence <= step + 1);
      assert.ok(schema >= 1);
      assert.equal(new Set(worktrees.keys()).size, worktrees.size);
      assert.ok(![...deliveries.values()].includes("consumed"));
    }
  });
}
