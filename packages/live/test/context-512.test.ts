import { describe, expect, it } from "vitest";
import { LiveContext, MAX_BATCHES, MAX_BATCH_POIDS, MAX_TASK_HISTORIES, MAX_TASK_HISTORY_ENTRIES } from "../src/context.js";
import type { StpEvent } from "../src/connection.js";

// Synthetic payloads in the shapes of the contract's x-stpEvents (5.12).
const ev = (name: string, params?: unknown, replay = false): StpEvent => ({ name, params, at: new Date(), replay });

const sym = (poid: string, batchId: string | null = null) => ({
  alternates: [{ fsTYPE: "unit", poid, fullDescription: `UNIT ${poid}` }],
  isUndo: false,
  batchId,
});
const started = (batchId: string, kind = "import", extra: object = {}) =>
  ev("BatchStarted", { batchId, kind, expected: 3, isOwn: false, origin: "live", ...extra });
const ended = (batchId: string, status = "completed", kind = "import") =>
  ev("BatchEnded", { batchId, kind, status, informs: 3, isOwn: false, origin: "live" });
const entry = (task: string, poid: string, kind = "comment", text: string | null = "hello") => ({
  poid,
  entry: { task, utc: "2026-01-01T00:00:00Z", kind, origin: kind === "comment" ? "user" : "system", author: "Ann", role: "s3", text },
  batchId: null,
});

describe("LiveContext batches (STP-1265)", () => {
  it("says which changes arrived together and whether a batch is open", () => {
    const ctx = new LiveContext();
    ctx.apply(started("b1"));
    expect(ctx.snapshot().batches.open.map((b) => b.batchId)).toEqual(["b1"]);
    ctx.apply(ev("SymbolAdded", sym("s1", "b1")));
    ctx.apply(ev("SymbolAdded", sym("s2", "b1")));
    ctx.apply(ev("SymbolAdded", sym("s3"))); // a lone add
    let s = ctx.snapshot();
    expect(s.batches.open[0]).toMatchObject({ batchId: "b1", kind: "import", expected: 3, events: 2, poids: ["s1", "s2"] });
    expect(s.recentEvents.find((e) => e.poid === "s1")?.batchId).toBe("b1");
    expect(s.recentEvents.find((e) => e.poid === "s3")?.batchId).toBeUndefined();

    ctx.apply(ended("b1"));
    s = ctx.snapshot();
    expect(s.batches.open).toEqual([]);
    expect(s.batches.recent[0]).toMatchObject({ batchId: "b1", status: "completed", informs: 3, events: 2 });
    expect(s.recentEvents[0]).toMatchObject({ name: "BatchEnded", detail: "import b1 completed" });
  });

  it("records an engine-ended batch status and a batch joined mid-way", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("SymbolAdded", sym("s1", "late"))); // BatchStarted never seen
    expect(ctx.snapshot().batches.open.map((b) => b.batchId)).toEqual(["late"]);
    ctx.apply(ended("late", "abandoned", "delete"));
    expect(ctx.snapshot().batches.recent[0]).toMatchObject({ batchId: "late", kind: "delete", status: "abandoned" });
    ctx.apply(ended("never-seen", "expired"));
    expect(ctx.snapshot().batches.open).toEqual([]);
  });

  it("keeps a replay batch marked as such, and forgets batches on reset and NewScenario", () => {
    const ctx = new LiveContext();
    ctx.apply(started("j1", "join", { origin: "replay" }));
    expect(ctx.snapshot().batches.open[0].origin).toBe("replay");
    ctx.reset();
    expect(ctx.snapshot().batches.open).toEqual([]);
    ctx.apply(started("b2"));
    ctx.apply(ev("NewScenario"));
    expect(ctx.snapshot().batches.open).toEqual([]);
  });

  it("bounds finished batches and the poids listed per batch", () => {
    const ctx = new LiveContext();
    for (let i = 0; i < MAX_BATCHES + 5; i++) {
      ctx.apply(started(`b${i}`));
      ctx.apply(ended(`b${i}`));
    }
    const recent = ctx.snapshot().batches.recent;
    expect(recent).toHaveLength(MAX_BATCHES);
    expect(recent[0].batchId).toBe(`b${MAX_BATCHES + 4}`);
    ctx.apply(started("big"));
    for (let i = 0; i < MAX_BATCH_POIDS + 10; i++) ctx.apply(ev("SymbolAdded", sym(`p${i}`, "big")));
    const big = ctx.snapshot().batches.open[0];
    expect(big.poids).toHaveLength(MAX_BATCH_POIDS);
    expect(big.events).toBe(MAX_BATCH_POIDS + 10);
  });

  it("ignores a batch event without an id instead of failing", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("BatchStarted", {}));
    ctx.apply(ev("BatchEnded"));
    expect(ctx.snapshot().batches.open).toEqual([]);
    expect(ctx.snapshot().recentEvents.map((e) => e.name)).toEqual(["BatchEnded", "BatchStarted"]);
  });
});

describe("LiveContext task history (STP-1250)", () => {
  it("attaches entries to their task and summarizes them in recent events", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("TaskEventAdded", entry("t1", "e1", "edited", "start_time 1 -> 2")));
    ctx.apply(ev("TaskEventAdded", entry("t1", "e2")));
    ctx.apply(ev("TaskEventAdded", entry("t2", "e3", "created", null)));
    expect(ctx.historyOf("t1").map((h) => h.poid)).toEqual(["e1", "e2"]);
    expect(ctx.historyOf("t2")).toHaveLength(1);
    expect(ctx.historyOf("none")).toEqual([]);
    const s = ctx.snapshot();
    expect(s.taskHistories.map((t) => [t.task, t.entries])).toEqual([["t2", 1], ["t1", 2]]);
    expect(s.recentEvents.find((e) => e.detail === "edited: start_time 1 -> 2")).toMatchObject({ name: "TaskEventAdded", poid: "t1" });
  });

  it("replaces an entry on TaskEventModified, a deleted comment arriving as its tombstone", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("TaskEventAdded", entry("t1", "e1")));
    const tomb = entry("t1", "e1", "comment", null);
    (tomb.entry as Record<string, unknown>).deleted = true;
    ctx.apply(ev("TaskEventModified", tomb));
    const h = ctx.historyOf("t1");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ lastEvent: "TaskEventModified", entry: { deleted: true } });
    expect(ctx.snapshot().recentEvents[0].detail).toBe("comment (modified): (deleted)");
  });

  it("stamps an entry with its batch and counts it in the batch", () => {
    const ctx = new LiveContext();
    ctx.apply(started("b1", "approve_all"));
    ctx.apply(ev("TaskEventAdded", { ...entry("t1", "e1", "confirmed", null), batchId: "b1" }));
    expect(ctx.historyOf("t1")[0].batchId).toBe("b1");
    expect(ctx.snapshot().batches.open[0]).toMatchObject({ events: 1, poids: ["t1"] });
  });

  it("is bounded per task and in the number of tasks, and cleared on reset", () => {
    const ctx = new LiveContext();
    for (let i = 0; i < MAX_TASK_HISTORY_ENTRIES + 5; i++) ctx.apply(ev("TaskEventAdded", entry("t1", `e${i}`)));
    const h = ctx.historyOf("t1");
    expect(h).toHaveLength(MAX_TASK_HISTORY_ENTRIES);
    expect(h[0].poid).toBe("e5");
    for (let i = 0; i < MAX_TASK_HISTORIES + 3; i++) ctx.apply(ev("TaskEventAdded", entry(`task${i}`, `x${i}`)));
    expect(ctx.snapshot().taskHistories).toHaveLength(MAX_TASK_HISTORIES);
    expect(ctx.historyOf("t1")).toEqual([]);
    ctx.reset();
    expect(ctx.snapshot().taskHistories).toEqual([]);
  });

  it("does not fail on a malformed entry; it is still a recent event", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("TaskEventAdded", { poid: "e1" }));
    expect(ctx.snapshot().taskHistories).toEqual([]);
    expect(ctx.snapshot().recentEvents[0].name).toBe("TaskEventAdded");
  });
});
