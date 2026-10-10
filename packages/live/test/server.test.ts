import { afterEach, describe, expect, it } from "vitest";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { exclusionReason, loadContract, loadPin, safetyClass, type Contract } from "stp-mcp-contract-tools";
import { call, connectLive, FakeEngine, type Script } from "./fake-engine.js";

const contract = loadContract();
const pin = loadPin();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(script: Script = {}, config: Record<string, unknown> = {}, options = {}) {
  const engine = await FakeEngine.start(script);
  cleanups.push(() => engine.close());
  const { live, client, close } = await connectLive({ url: engine.url, ...config }, options);
  cleanups.push(close);
  return { engine, live, client };
}

const symbolAdded = (poid: string, designator: string, extra: Record<string, unknown> = {}) => ({
  alternates: [
    {
      fsTYPE: "unit",
      poid,
      sidc: { charlie: "SFGPUCI----E---" },
      location: { fsTYPE: "point", shape: "point", coords: [{ lat: 36.35, lon: -115.8 }], centroid: { lat: 36.35, lon: -115.8 } },
      fullDescription: `FRIENDLY INFANTRY COMPANY ${designator}`,
      affiliation: "friend",
      echelon: "company",
      dbTimestamp: "639272658578567111",
      PrologTerm: "[fsTYPE: unit, ...a large engine term...]",
      ...extra,
    },
  ],
  isUndo: false,
});

describe("tools", () => {
  it("lists exactly the contract's read methods, plus live_status and live_context", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const expected = contract.methods
      .filter((m) => exclusionReason(m) === null && safetyClass(m) === "read")
      .map((m) => m.name);
    expect(expected.length).toBeGreaterThanOrEqual(15);
    expect(tools.map((t) => t.name).sort()).toEqual([...expected, "live_context", "live_status"].sort());
  });

  it("lists no write or destructive tool, and nothing the engine refuses", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t._meta?.["stp/safety"], t.name).toBe("read");
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBeUndefined();
    }
    const names = new Set(tools.map((t) => t.name));
    for (const m of contract.methods) {
      if (safetyClass(m) !== "read" || exclusionReason(m) !== null) expect(names.has(m.name), m.name).toBe(false);
    }
    for (const name of ["AddSymbol", "SetRole", "SetCurrentCoa", "DeleteCoa", "Register", "Request"]) expect(names.has(name)).toBe(false);
  });

  it("serves the generated definitions unchanged", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const coa = tools.find((t) => t.name === "GetCoaContent")!;
    const source = contract.methods.find((m) => m.name === "GetCoaContent")!;
    expect(coa.description).toBe(source.description);
    expect(coa.inputSchema).toEqual({
      type: "object",
      properties: { poid: { type: "string", description: "Unique id of the COA to export." } },
      additionalProperties: false,
    });
    expect(coa.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("answers a call with the engine's result and its provenance", async () => {
    const { client, engine } = await setup({ GetScenarioTaskOrgList: { result: [{ fsTYPE: "task_org", name: "Live Test TO", poid: "idTO1" }] } });
    const before = new Date().toISOString();
    const { isError, body } = await call(client, "GetScenarioTaskOrgList");
    expect(isError).toBe(false);
    expect(body.answer).toEqual([{ fsTYPE: "task_org", name: "Live Test TO", poid: "idTO1" }]);
    expect(body.provenance).toMatchObject({
      endpoint: engine.url,
      session: "FAKE-SESSION",
      contract: { version: contract.info.version, ref: pin.ref },
    });
    expect(body.provenance.answeredAt >= before).toBe(true);
    // Register (all x-stpEvents), JoinScenarioSession and HasActiveScenario precede the first call.
    expect(engine.methods()).toEqual(["Register", "JoinScenarioSession", "HasActiveScenario", "GetScenarioTaskOrgList"]);
    const register = engine.received[0];
    expect(register.params).toMatchObject({ serviceName: "stp-mcp-live", language: "javascript", machineId: null, sessionId: null });
    expect(register.params.solvables).toEqual(contract["x-stpEvents"]!.map((e) => e.name));
    expect(engine.received[3].timeout).toBe(5); // seconds, as the engine reads it
  });

  it("joins the configured session and never calls a state-changing method", async () => {
    const { client, engine } = await setup({ GetAllObjects: { result: [] } }, { session: "LIVETEST01" });
    await call(client, "GetAllObjects");
    await call(client, "live_status");
    await call(client, "live_context");
    expect(engine.received[0].params.sessionId).toBe("LIVETEST01");
    const writes = engine.methods().filter((m) => {
      const method = contract.methods.find((x) => x.name === m);
      return m !== "Register" && (!method || safetyClass(method) !== "read");
    });
    expect(writes).toEqual([]);
  });

  it("turns success:false into an error with the engine's reason and the method", async () => {
    const reason = "Error getting C2SIM data: Get requires type to be 'initialization' or 'order'. Got All.";
    const { client, engine } = await setup({ GetC2SIMContent: { success: false, result: reason } });
    const res = await call(client, "GetC2SIMContent", { dataType: "All" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`STP refused GetC2SIMContent: ${reason}`);
    expect(res.text).toContain(engine.url);
  });

  it("turns a request the engine never answers into an explained timeout", async () => {
    const { client } = await setup({ GetAllObjects: { noAnswer: true } }, { timeoutS: 0.2 });
    const started = Date.now();
    const res = await call(client, "GetAllObjects");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/STP did not answer GetAllObjects within 2\.2 s/);
    expect(res.text).toMatch(/STP_TIMEOUT_S=0\.2/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });

  it("refuses arguments that do not match the contract schema, without calling STP", async () => {
    const { client, engine } = await setup();
    const res = await call(client, "GetPoidObject", { poid: { id: 1 } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Invalid arguments for GetPoidObject: .*poid must be string/);
    expect(engine.methods()).not.toContain("GetPoidObject");
  });

  it("refuses a write method by name, saying the server is read-only", async () => {
    const { client } = await setup();
    const res = await call(client, "AddSymbol", { symbol: {} });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/AddSymbol is a write STP method. This live server is read-only/);
    const transport = await call(client, "Register");
    expect(transport.text).toMatch(/transport-layer/);
    const unknown = await call(client, "Frobnicate");
    expect(unknown.text).toMatch(/There is no tool 'Frobnicate'/);
  });

  it("drops PrologTerm from answers and says so in the provenance", async () => {
    const { client } = await setup({
      GetPoidObject: { result: { fsTYPE: "unit", poid: "idU1", PrologTerm: "x".repeat(30000), nested: [{ PrologTerm: "y" }] } },
    });
    const { body, text } = await call(client, "GetPoidObject", { poid: "idU1" });
    expect(body.answer).toEqual({ fsTYPE: "unit", poid: "idU1", nested: [{}] });
    expect(text).not.toContain("PrologTerm\": \"");
    expect(body.provenance.prologTermDropped).toBe(2);
    expect(body.provenance.prologTermNote).toMatch(/STP-1085/);
  });

  it("truncates an answer over the size cap with an explicit note", async () => {
    const objects = Array.from({ length: 50 }, (_, i) => ({ fsTYPE: "unit", poid: `id${i}`, pad: "z".repeat(100) }));
    const { client } = await setup({ GetAllObjects: { result: objects } }, {}, { maxAnswerBytes: 2000 });
    const { body } = await call(client, "GetAllObjects");
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.answer.length).toBeLessThan(50);
    expect(body.truncated.note).toMatch(/Truncated: .* the first \d+ of 50 items are shown/);
  });

  it("explains empty answers and calls without a poid", async () => {
    const { client } = await setup({ GetPoidObject: { result: null }, GetTaskOrgObjects: { result: [] } });
    const missing = await call(client, "GetPoidObject", { poid: "idNOPE" });
    expect(missing.body.answer).toBeNull();
    expect(missing.body.notes.join(" ")).toMatch(/answered null: nothing matched - an unknown poid/);
    const all = await call(client, "GetTaskOrgObjects", {});
    expect(all.body.notes.join(" ")).toMatch(/No poid was given/);
    expect(all.body.notes.join(" ")).toMatch(/empty list/);
  });

  it("fills a missing COA poid from STP_COA and says so", async () => {
    const { client, engine } = await setup({ GetCoaContent: { result: "object_set([\n[fsTYPE: coa,poid: idCOA1]\n])\n" } }, { coa: "idCOA1" });
    const { body } = await call(client, "GetCoaContent");
    expect(engine.received.at(-1)!.params).toEqual({ poid: "idCOA1" });
    expect(body.provenance.poidFrom).toBe("STP_COA");
    expect(body.notes[0]).toMatch(/default COA from STP_COA \(idCOA1\)/);
    await call(client, "GetCoaContent", { poid: "idOTHER" });
    expect(engine.received.at(-1)!.params).toEqual({ poid: "idOTHER" });
  });

  it("fails a call whose always-sent event does not arrive, and passes one whose event does", async () => {
    // No read method of the pinned contract promises an event; give one such a promise to test the rule.
    const patched: Contract = structuredClone(contract);
    const method = patched.methods.find((m) => m.name === "GetDeletedObjects")!;
    method["x-stpEmits"] = [{ event: "StpMessage", when: "always", to: "caller" }];
    const engine = await FakeEngine.start({ GetDeletedObjects: { result: [] } });
    cleanups.push(() => engine.close());
    const { client, close } = await connectLive({ url: engine.url, timeoutS: 0.3 }, { contract: patched });
    cleanups.push(close);
    const missing = await call(client, "GetDeletedObjects");
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/expected event StpMessage did not arrive within 0\.3 s/);
    engine.script.GetDeletedObjects = { result: [], events: [{ name: "StpMessage", params: { message: "ok", level: "Info" } }] };
    expect((await call(client, "GetDeletedObjects")).isError).toBe(false);
  });
});

describe("live_status", () => {
  it("reports the endpoint, session, scenario, event count and contract", async () => {
    const { client, engine } = await setup({
      JoinScenarioSession: { result: null, events: [{ name: "CoaAdded", params: { poid: "idC1", coa: { fsTYPE: "coa", poid: "idC1", name: "Live Test COA" } } }] },
    });
    const { body } = await call(client, "live_status");
    expect(body).toMatchObject({
      endpoint: engine.url,
      connected: true,
      session: "FAKE-SESSION",
      scenario: { active: true },
      connects: 1,
      lastError: null,
      eventCount: 1,
      readOnly: true,
      contract: { version: contract.info.version, ref: pin.ref },
    });
  });

  it("notes a session with no active scenario instead of failing", async () => {
    const { client } = await setup({ HasActiveScenario: { result: false } });
    const { body } = await call(client, "live_status");
    expect(body.connected).toBe(true);
    expect(body.scenario.active).toBe(false);
    expect(body.scenario.note).toMatch(/no active scenario/);
    const has = await call(client, "HasActiveScenario");
    expect(has.body.answer).toBe(false);
    expect(has.body.notes[0]).toMatch(/holds no scenario/);
  });
});

describe("live context", () => {
  it("fills from the join replay and live events, and resolves the unit just added", async () => {
    const { client, engine } = await setup({
      JoinScenarioSession: {
        result: null,
        events: [
          { name: "CoaAdded", params: { poid: "idC1", coa: { fsTYPE: "coa", poid: "idC1", name: "Live Test COA", affiliation: "friend", creatorRole: "S3", PrologTerm: "t" } } },
          { name: "SymbolAdded", params: symbolAdded("idA", "A") },
        ],
      },
    });
    let ctx = (await call(client, "live_context")).body;
    expect(ctx.lastAdded.symbol).toMatchObject({ poid: "idA", summary: "FRIENDLY INFANTRY COMPANY A at 36.35, -115.8", source: "replay" });
    expect(ctx.counts).toMatchObject({ symbols: 1, coas: 1 });
    expect(ctx.entities.coas[0]).toMatchObject({ poid: "idC1", summary: "Live Test COA (friend, by S3)" });
    expect(JSON.stringify(ctx)).not.toContain("PrologTerm");

    engine.emit("SymbolAdded", symbolAdded("idB", "B"));
    engine.emit("TaskAdded", {
      poid: "idT1",
      alternates: [{ fsTYPE: "task", poid: "idT1", name: "BlockEnemy", what: "BLOCK", how: "AREA_DEFENSE", who: "idB" }],
      taskPoids: ["idB"],
    });
    await new Promise((r) => setTimeout(r, 100));
    ctx = (await call(client, "live_context")).body;
    expect(ctx.lastAdded.symbol).toMatchObject({ poid: "idB", source: "live" });
    expect(ctx.lastAdded.task.summary).toBe("BlockEnemy (BLOCK / AREA_DEFENSE) by FRIENDLY INFANTRY COMPANY B (idB)");
    expect(ctx.recentEvents.map((e: { name: string }) => e.name)).toEqual(["TaskAdded", "SymbolAdded", "SymbolAdded", "CoaAdded"]);
    expect(ctx.recentEvents[3].replay).toBe(true);
    expect(ctx.provenance.endpoint).toBe(engine.url);
  });

  it("serves the context and single objects as resources", async () => {
    const { client, engine } = await setup({ JoinScenarioSession: { result: null, events: [{ name: "SymbolAdded", params: symbolAdded("idA", "A") }] } });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["stp-live://actions", "stp-live://context"]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "stp-live://coa/{poid}",
      "stp-live://symbol/{poid}",
      "stp-live://task/{poid}",
    ]);

    // Reading the context connects lazily, so the replay is in it.
    const ctxRes = await client.readResource({ uri: "stp-live://context" });
    expect(ctxRes.contents[0].mimeType).toBe("application/json");
    const ctx = JSON.parse((ctxRes.contents[0] as { text: string }).text);
    expect(ctx).toMatchObject({ endpoint: engine.url, connected: true, lastAdded: { symbol: { poid: "idA" } } });

    const sym = JSON.parse(((await client.readResource({ uri: "stp-live://symbol/idA" })).contents[0] as { text: string }).text);
    expect(sym).toMatchObject({ kind: "symbol", poid: "idA", lastEvent: "SymbolAdded", data: { fullDescription: "FRIENDLY INFANTRY COMPANY A" } });
    expect(sym.data.PrologTerm).toBeUndefined();
    expect(sym.provenance.endpoint).toBe(engine.url);

    await expect(client.readResource({ uri: "stp-live://symbol/idNOPE" })).rejects.toThrow(/no symbol with poid idNOPE in the live context.*GetPoidObject/);
    await expect(client.readResource({ uri: "stp-live://coa/idA" })).rejects.toThrow(/no coa with poid idA/);
  });

  it("sends one debounced resources/updated for the context after a burst of events", async () => {
    const { client, engine } = await setup({}, {}, { notifyDebounceMs: 150 });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await call(client, "live_status"); // connect
    await client.subscribeResource({ uri: "stp-live://context" });
    await client.subscribeResource({ uri: "stp-live://symbol/idB" });
    engine.emit("SymbolAdded", symbolAdded("idA", "A"));
    engine.emit("SymbolAdded", symbolAdded("idB", "B"));
    engine.emit("RoleSwitched", { role: "s3" });
    await new Promise((r) => setTimeout(r, 50));
    expect(updates).toEqual([]); // still coalescing
    await new Promise((r) => setTimeout(r, 300));
    expect(updates.sort()).toEqual(["stp-live://context", "stp-live://symbol/idB"]);

    await client.unsubscribeResource({ uri: "stp-live://context" });
    engine.emit("SymbolDeleted", { poid: "idA", isUndo: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(updates.length).toBe(2);
  });

  it("declares resource subscriptions", async () => {
    const { client } = await setup();
    expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
    await expect(client.subscribeResource({ uri: "stp-docs://guides/roles" })).rejects.toThrow(/only stp-live:\/\//);
  });
});
