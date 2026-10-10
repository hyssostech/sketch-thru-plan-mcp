import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { call, connectLive, ReplayEngine } from "./fake-engine.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Integration test against a recorded wire session (fixtures/session.jsonl, recorded from a real
 * engine with scripts/record-session.mjs): a user's app had created "Live Test Scenario" with
 * "Live Test COA", unit A and a task for it in session LIVETEST01; the live server joined that
 * session, and while it was connected the app added unit B. The tool calls below follow the order
 * of the recording, so each request gets the engine's recorded answer.
 */

const fixture = fileURLToPath(new URL("./fixtures/session.jsonl", import.meta.url));
let engine: ReplayEngine;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  engine = await ReplayEngine.start(fixture);
  ({ client, close } = await connectLive({ url: engine.url, session: "LIVETEST01", timeoutS: 5 }));
});

afterAll(async () => {
  await close();
  await engine.close();
});

describe("a recorded session with a real engine", () => {
  it("offers read tools only", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t._meta?.["stp/safety"] === "read")).toBe(true);
  });

  it("lists the scenario, its COA, unit and task, and resolves the unit added before joining", async () => {
    const has = await call(client, "HasActiveScenario");
    expect(has.body.answer).toBe(true);
    expect(has.body.provenance).toMatchObject({ endpoint: engine.url, session: "LIVETEST01" });

    const ctx = (await call(client, "live_context")).body;
    expect(ctx.scenario.active).toBe(true);
    expect(ctx.counts).toMatchObject({ symbols: 1, tasks: 1, coas: 1 });
    expect(ctx.lastAdded.symbol).toMatchObject({ summary: "FRIENDLY INFANTRY COMPANY A at 36.35, -115.8", source: "replay" });
    expect(ctx.entities.coas[0].summary).toBe("Live Test COA (friend, by S3)");
    expect(ctx.lastAdded.task.summary).toMatch(/^BlockEnemy \(BLOCK \/ AREA_DEFENSE\) by FRIENDLY INFANTRY COMPANY A \(id\w+\)/);
    expect(JSON.stringify(ctx)).not.toContain("PrologTerm");

    const scenario = await call(client, "GetActiveScenarioDescription");
    expect(scenario.body.answer.Name).toBe("Live Test Scenario");

    const coa = await call(client, "GetCoaContent", { poid: ctx.entities.coas[0].poid });
    expect(coa.body.answer).toMatch(/^object_set\(\[\n\[fsTYPE: coa,.*name: 'Live Test COA'/);
  });

  it("resolves 'the unit I just added' from a live event, and asks the engine about it", async () => {
    // The recorded SymbolAdded follows GetCoaContent's answer; let it arrive.
    let ctx = (await call(client, "live_context")).body;
    for (let i = 0; i < 40 && ctx.counts.symbols < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ctx = (await call(client, "live_context")).body;
    }
    const unit = ctx.lastAdded.symbol;
    expect(unit).toMatchObject({ summary: "FRIENDLY INFANTRY COMPANY B at 36.36, -115.81", source: "live" });
    expect(ctx.recentEvents[0]).toMatchObject({ name: "SymbolAdded", poid: unit.poid });
    expect(ctx.recentEvents[0].replay).toBeUndefined();

    const obj = await call(client, "GetPoidObject", { poid: unit.poid });
    expect(obj.body.answer).toMatchObject({ fsTYPE: "unit", poid: unit.poid });

    const resource = await client.readResource({ uri: `stp-live://symbol/${unit.poid}` });
    const symbol = JSON.parse((resource.contents[0] as { text: string }).text);
    expect(symbol.data).toMatchObject({ designator1: "B", affiliation: "friend", echelon: "company" });

    const content = await call(client, "GetScenarioContent");
    expect(content.body.answer).toContain("complete_language: 'PRESENT FRIENDLY INFANTRY COMPANY A'");
    expect(content.body.answer).toContain("complete_language: 'PRESENT FRIENDLY INFANTRY COMPANY B'");
  });

  it("replayed every recorded request and nothing else", () => {
    expect(engine.unmatched).toEqual([]);
    expect(engine.unused()).toEqual([]);
  });
});
