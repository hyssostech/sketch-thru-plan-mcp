import { describe, expect, it } from "vitest";
import { LiveContext, MAX_ENTITIES, MAX_RECENT_EVENTS } from "../src/context.js";
import type { StpEvent } from "../src/connection.js";
import { capAnswer, stripPrologTerm, ticksToIso } from "../src/payload.js";
import { configFromEnv } from "../src/config.js";

const ev = (name: string, params?: unknown, replay = false): StpEvent => ({ name, params, at: new Date(), replay });

const unit = (poid: string, designator: string, dbTimestamp = "639272658578567111") => ({
  alternates: [
    {
      fsTYPE: "unit",
      poid,
      fullDescription: `FRIENDLY INFANTRY COMPANY ${designator}`,
      location: { fsTYPE: "point", shape: "point", coords: [{ lat: 36.3, lon: -115.8 }], centroid: { lat: 36.3, lon: -115.8 } },
      dbTimestamp,
      PrologTerm: "[fsTYPE: unit]",
    },
  ],
  isUndo: false,
});

describe("LiveContext", () => {
  it("tracks symbols, tasks, COAs and task orgs from their events, without PrologTerm", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("SymbolAdded", unit("idA", "A")));
    ctx.apply(ev("CoaAdded", { poid: "idC", coa: { fsTYPE: "coa", poid: "idC", name: "Live Test COA", affiliation: "friend", creatorRole: "S3", PrologTerm: "x" } }));
    ctx.apply(ev("TaskAdded", { poid: "idT", alternates: [{ fsTYPE: "task", poid: "idT", name: "BlockEnemy", what: "BLOCK", how: "AREA_DEFENSE", who: "idA" }] }));
    ctx.apply(ev("TaskOrgAdded", { poid: "idTO", taskOrg: { fsTYPE: "task_org", poid: "idTO", name: "Live Test TO", affiliation: "friend" } }));
    ctx.apply(ev("TaskOrgUnitAdded", { poid: "idU", toUnit: { fsTYPE: "task_org_unit", poid: "idU", name: "ALPHA COMPANY", fullDescription: "FRIENDLY INFANTRY COMPANY A" } }));
    ctx.apply(ev("TaskOrgUnitAdded", { poid: "idU2", toUnit: { fsTYPE: "task_org_unit", poid: "idU2", name: "BN HQ" } }));
    ctx.apply(ev("TaskOrgRelationshipAdded", { poid: "idR", toRelationship: { fsTYPE: "task_org_relationship", poid: "idR", parent: "idU2", child: "idU", relationship: "organic" } }));

    const s = ctx.snapshot();
    expect(s.counts).toEqual({ symbols: 1, tasks: 1, coas: 1, taskOrgs: 1, taskOrgUnits: 2, taskOrgRelationships: 1, evicted: 0 });
    expect(s.entities.symbols[0].summary).toBe("FRIENDLY INFANTRY COMPANY A at 36.3, -115.8");
    expect(s.entities.tasks[0].summary).toBe("BlockEnemy (BLOCK / AREA_DEFENSE) by FRIENDLY INFANTRY COMPANY A (idA)");
    expect(s.entities.coas[0].summary).toBe("Live Test COA (friend, by S3)");
    expect(s.entities.taskOrgUnits.map((u) => u.summary)).toEqual(["BN HQ", "ALPHA COMPANY - FRIENDLY INFANTRY COMPANY A"]);
    expect(s.entities.taskOrgRelationships[0].summary).toBe("BN HQ -> ALPHA COMPANY (organic)");
    expect(s.lastAdded.taskOrgUnit?.poid).toBe("idU2");
    expect(ctx.get("symbol", "idA")?.engineTime).toBe("2026-10-10T21:50:57.856Z");
    expect(JSON.stringify(s)).not.toContain("PrologTerm");
    expect(JSON.stringify(ctx.get("coa", "idC"))).not.toContain("PrologTerm");
  });

  it("applies modifications and deletions, and marks a deleted lastAdded", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("SymbolAdded", unit("idA", "A")));
    ctx.apply(ev("SymbolModified", { poid: "idA", symbol: { ...unit("idA", "A (renamed)").alternates[0] } }));
    expect(ctx.get("symbol", "idA")?.summary).toMatch(/A \(renamed\)/);
    expect(ctx.get("symbol", "idA")?.lastEvent).toBe("SymbolModified");
    ctx.apply(ev("SymbolDeleted", { poid: "idA", isUndo: false }));
    const s = ctx.snapshot();
    expect(s.counts.symbols).toBe(0);
    expect(s.lastAdded.symbol).toMatchObject({ poid: "idA", deleted: true });
  });

  it("reports the current COA, role and task org it observes, and says when it has not", () => {
    const ctx = new LiveContext();
    let s = ctx.snapshot();
    expect(s.current.role).toMatch(/not observed: no RoleSwitched reached this server/);
    expect(s.current.coa).toMatch(/set STP_COA/);
    ctx.apply(ev("RoleSwitched", { role: "s3" }));
    ctx.apply(ev("CoaSwitched", { coa: { fsTYPE: "coa", poid: "idC", name: "Live Test COA", PrologTerm: "x" } }));
    ctx.apply(ev("TaskOrgSwitched", { taskOrg: null }));
    s = ctx.snapshot();
    expect(s.current).toEqual({ role: "s3", coa: { poid: "idC", name: "Live Test COA" }, taskOrg: null });
    expect(s.entities.coas[0].poid).toBe("idC");
    ctx.apply(ev("CoaDeleted", { poid: "idC", isUndo: false }));
    expect(ctx.snapshot().current.coa).toBeNull();
  });

  it("resolves 'the unit just added': a live add wins; in a replay the newest object does", () => {
    const ctx = new LiveContext();
    // The replay comes in the engine's order, not creation order.
    ctx.apply(ev("SymbolAdded", unit("idNew", "B", "639272658590000000"), true));
    ctx.apply(ev("SymbolAdded", unit("idOld", "A", "639272658578567111"), true));
    expect(ctx.snapshot().lastAdded.symbol).toMatchObject({ poid: "idNew", source: "replay" });
    ctx.apply(ev("SymbolAdded", unit("idLive", "C", "639272658578560000")));
    expect(ctx.snapshot().lastAdded.symbol).toMatchObject({ poid: "idLive", source: "live" });
    ctx.apply(ev("SymbolAdded", unit("idReplayedAgain", "D", "639272658599990000"), true));
    expect(ctx.snapshot().lastAdded.symbol?.poid).toBe("idLive");
  });

  it("stays within its caps, evicting the least recently touched object but never a focused one", () => {
    const ctx = new LiveContext({ entities: 5, recentEvents: 4 });
    ctx.apply(ev("CoaSwitched", { coa: { fsTYPE: "coa", poid: "idCur", name: "Current" } }));
    for (let i = 0; i < 10; i++) ctx.apply(ev("SymbolAdded", unit(`id${i}`, String(i))));
    const s = ctx.snapshot();
    expect(s.counts.symbols + s.counts.coas).toBe(5);
    expect(s.counts.evicted).toBe(6);
    expect(s.entities.coas.map((c) => c.poid)).toEqual(["idCur"]); // current COA is focused
    expect(s.entities.symbols.map((x) => x.poid)).toEqual(["id9", "id8", "id7", "id6"]);
    expect(s.recentEvents.length).toBe(4);
    expect(s.recentEvents[0].poid).toBe("id9");
    expect(s.caps).toEqual({ entities: 5, recentEvents: 4 });
    expect(new LiveContext().snapshot().caps).toEqual({ entities: MAX_ENTITIES, recentEvents: MAX_RECENT_EVENTS });
  });

  it("keeps short details of messages and speech, and clears on NewScenario", () => {
    const ctx = new LiveContext();
    ctx.apply(ev("SymbolAdded", unit("idA", "A")));
    ctx.apply(ev("StpMessage", { message: "'SetCurrentCoa' refused", level: "Warning" }));
    ctx.apply(ev("SpeechRecognized", { phrases: ["INFANTRY PLATOON"] }));
    ctx.apply(ev("InkProcessed"));
    ctx.apply(ev("NewScenario"));
    const s = ctx.snapshot();
    expect(s.recentEvents.map((e) => e.detail ?? e.name)).toEqual(["NewScenario", "InkProcessed", "INFANTRY PLATOON", "Warning: 'SetCurrentCoa' refused", "SymbolAdded"]);
    expect(s.counts.symbols).toBe(0);
    expect(s.lastAdded).toEqual({});
  });

  it("names the URIs each change touches", () => {
    const ctx = new LiveContext();
    const changes: string[][] = [];
    ctx.onChange((uris) => changes.push(uris));
    ctx.apply(ev("SymbolAdded", unit("idA", "A")));
    ctx.apply(ev("TaskOrgAdded", { poid: "idTO", taskOrg: { fsTYPE: "task_org", poid: "idTO", name: "TO" } }));
    expect(changes).toEqual([["stp-live://context", "stp-live://symbol/idA"], ["stp-live://context"]]);
  });
});

describe("payload helpers", () => {
  it("strips PrologTerm at any depth and counts it", () => {
    expect(stripPrologTerm([{ a: 1, PrologTerm: "t", b: { PrologTerm: "u", c: [{ PrologTerm: "v" }] } }])).toEqual({
      value: [{ a: 1, b: { c: [{}] } }],
      dropped: 3,
    });
    expect(stripPrologTerm("object_set([])")).toEqual({ value: "object_set([])", dropped: 0 });
  });

  it("caps strings and objects too", () => {
    const s = capAnswer("x".repeat(5000), 1000);
    expect((s.answer as string).length).toBeLessThanOrEqual(1000);
    expect(s.truncated?.note).toMatch(/only its first \d+ characters are shown/);
    const o = capAnswer({ big: "y".repeat(5000) }, 1000);
    expect(o.truncated?.note).toMatch(/\(as JSON text\)/);
    expect(capAnswer({ small: 1 }, 1000)).toEqual({ answer: { small: 1 } });
  });

  it("reads engine timestamps (.NET ticks)", () => {
    expect(ticksToIso("639272658578567111")).toBe("2026-10-10T21:50:57.856Z");
    expect(ticksToIso("not ticks")).toBeUndefined();
    expect(ticksToIso(undefined)).toBeUndefined();
  });
});

describe("configuration", () => {
  it("defaults to the local engine", () => {
    expect(configFromEnv({})).toEqual({ url: "ws://localhost:9599", timeoutS: 15 });
  });

  it("reads every variable", () => {
    expect(configFromEnv({ STP_URL: "ws://stp:9599", STP_SESSION: "S1", STP_COA: "idC", STP_TIMEOUT_S: "30" })).toEqual({
      url: "ws://stp:9599",
      session: "S1",
      coa: "idC",
      timeoutS: 30,
    });
    expect(configFromEnv({ STP_SESSION: "  " })).toEqual({ url: "ws://localhost:9599", timeoutS: 15 });
  });

  it("refuses bad values with the variable's name", () => {
    expect(() => configFromEnv({ STP_URL: "http://localhost:9599" })).toThrow(/STP_URL must be a ws:\/\/ or wss:\/\/ URL/);
    expect(() => configFromEnv({ STP_TIMEOUT_S: "soon" })).toThrow(/STP_TIMEOUT_S/);
    expect(() => configFromEnv({ STP_TIMEOUT_S: "-1" })).toThrow(/STP_TIMEOUT_S must be a positive number/);
  });
});
