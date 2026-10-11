import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceUpdatedNotificationSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { exclusionReason, generateTools, loadContract, safetyClass } from "stp-mcp-contract-tools";
import { call, callWrite, connectLive, FakeEngine, readActions, type ElicitAnswer, type Script } from "./fake-engine.js";

/**
 * STP-1064 / STP-1065: write mode, the pre-call checks, the user's confirmation, V10 and the action
 * log, against a scripted engine. Informs get only scripted events (the engine never answers one).
 */

const contract = loadContract();
const generated = new Map(generateTools(contract).tools.map((t) => [t.name, t]));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const WRITE = { write: true, v10TimeoutS: 0.3 };
const DESTRUCTIVE = { write: true, destructive: true, v10TimeoutS: 0.3 };

async function setup(
  script: Script = {},
  config: Record<string, unknown> = WRITE,
  client: { elicit?: ElicitAnswer; elicited?: ElicitRequest[]; name?: string } = {},
  options: Record<string, unknown> = { settleMs: 100 },
) {
  const engine = await FakeEngine.start({ GetPoidObject: { result: null }, ...script });
  cleanups.push(() => engine.close());
  const { live, client: mcp, close } = await connectLive({ url: engine.url, ...config }, options, client);
  cleanups.push(close);
  return { engine, live, client: mcp };
}

const unit = (poid: string, designator: string) => ({
  alternates: [{ fsTYPE: "unit", poid, designator1: designator, fullDescription: `FRIENDLY INFANTRY COMPANY ${designator}`, PrologTerm: "[big]" }],
  isUndo: false,
});
const coaAdded = (poid: string, name: string) => ({ poid, coa: { fsTYPE: "coa", poid, name, affiliation: "friend", creatorRole: "S3" }, isUndo: false });
/** A join that replays COA idC1 and unit idA, so references to them resolve from the live context. */
const JOINED: Script = {
  JoinScenarioSession: {
    result: null,
    events: [
      { name: "CoaAdded", params: coaAdded("idC1", "Write Test COA") },
      { name: "SymbolAdded", params: unit("idA", "A") },
    ],
  },
};
const sent = (engine: FakeEngine, method: string) => engine.received.filter((r) => r.method === method);

describe("write mode", () => {
  it("is off by default: no write tool is listed, and a write called by name is refused and logged", async () => {
    const { client, engine } = await setup({}, {});
    const { tools } = await client.listTools();
    expect(tools.every((t) => t._meta?.["stp/safety"] === "read")).toBe(true);
    const res = await callWrite(client, "AddCoa", { coa: { name: "X" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/AddCoa is a write STP method. This live server is read-only and never exposes it/);
    expect(res.text).toMatch(/STP_WRITE=1/);
    expect(sent(engine, "AddCoa")).toEqual([]);
    const log = await readActions(client);
    expect(log.writeMode).toBe("off");
    expect(log.entries[0]).toMatchObject({ method: "AddCoa", status: "refused", client: { name: "test", version: "0" } });
    expect(log.entries[0].validation.at(-1)).toMatchObject({ check: "writeMode", passed: false });
    expect((await call(client, "live_status")).body).toMatchObject({ readOnly: true, writeMode: "off" });
  });

  it("STP_WRITE=1 lists the write tools with the generator's annotations, but no destructive one", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const expected = contract.methods.filter((m) => exclusionReason(m) === null && safetyClass(m) !== "destructive").map((m) => m.name);
    expect(tools.map((t) => t.name).sort()).toEqual([...expected, "live_context", "live_status"].sort());
    const addCoa = tools.find((t) => t.name === "AddCoa")!;
    expect(addCoa.annotations).toEqual(generated.get("AddCoa")!.annotations);
    expect(addCoa.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(addCoa.inputSchema).toEqual(generated.get("AddCoa")!.inputSchema);
    expect(tools.some((t) => t.annotations?.destructiveHint === true)).toBe(false);

    const del = await callWrite(client, "DeleteSymbol", { poid: "idA" });
    expect(del.text).toMatch(/DeleteSymbol is a destructive STP method. This server's write mode allows writes but not destructive calls \(STP_DESTRUCTIVE is not set\)/);
    expect((await call(client, "live_status")).body).toMatchObject({ readOnly: false, writeMode: "write", v10TimeoutS: 0.3 });
  });

  it("STP_DESTRUCTIVE=1 also lists the destructive tools", async () => {
    const { client } = await setup({}, DESTRUCTIVE);
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
    expect(destructive).toContain("DeleteSymbol");
    expect(destructive).toContain("CreateNewScenario");
    expect(destructive.length).toBe(contract.methods.filter((m) => exclusionReason(m) === null && safetyClass(m) === "destructive").length);
  });
});

describe("a write call", () => {
  it("is checked, sent as an inform, and reported done by V10, with every step listed", async () => {
    const { client, engine } = await setup({
      AddCoa: (p) => ({ events: [{ name: "CoaAdded", params: coaAdded("idC9", String((p.coa as { name: string }).name)) }] }),
    });
    const res = await callWrite(client, "AddCoa", { coa: { fsTYPE: "coa", name: "Write Test COA", affiliation: "friend", creatorRole: "S3" } });
    expect(res.isError).toBe(false);
    const r = res.report;
    expect(r.outcome).toBe("done");
    expect(r.summary).toBe('Done: CoaAdded where coa.name = "Write Test COA" (poid idC9).');
    expect(r.sent).toMatchObject({ method: "AddCoa", wire: "inform" });
    expect(r.engineAnswer).toBeUndefined(); // an inform gets no answer: V10 is the only confirmation
    expect(r.validation.map((s: { check: string; passed: boolean }) => `${s.check}:${s.passed}`)).toEqual([
      "dispatchable:true",
      "params:true",
      "writeMode:true",
      "context:true",
      "references:true",
    ]);
    expect(r.provenance.endpoint).toBe(engine.url);
    // HasActiveScenario is asked right before the write; the write goes as an inform, not a Request.
    const methods = engine.methods();
    expect(methods.slice(-2)).toEqual(["HasActiveScenario", "AddCoa"]);
    expect(sent(engine, "AddCoa")[0]).toMatchObject({ wire: "inform", cookie: -1 });
  });

  it("is refused when the session has no active scenario, and nothing is sent", async () => {
    const { client, engine } = await setup({ HasActiveScenario: { result: false } });
    const res = await callWrite(client, "AddCoa", { coa: { name: "X" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Refused by the context check: the session has no active scenario/);
    expect(sent(engine, "AddCoa")).toEqual([]);
    expect((await call(client, "live_status")).body.scenario.active).toBe(false);
  });

  it("is refused on params the contract schema rejects (enum values checked by value) or the engine silently needs", async () => {
    const { client, engine } = await setup();
    const role = await callWrite(client, "SetRole", { role: "XO" });
    expect(role.text).toMatch(/Invalid arguments for SetRole: .*role must be equal to one of the allowed values/);
    const update = await callWrite(client, "UpdateSymbol", { poid: "idA" });
    expect(update.text).toMatch(/Refused by the params check: UpdateSymbol needs symbol/);
    // C2SIM options by key and value: the engine silently kept its default for 'ROEHold' (STP-694).
    const roe = await callWrite(client, "PullC2SIMInitialization", { options: { rulesOfEngagement: "ROEHold" } });
    expect(roe.text).toMatch(/Invalid arguments for PullC2SIMInitialization: .*rulesOfEngagement must be equal to one of the allowed values/);
    const key = await callWrite(client, "PullC2SIMInitialization", { options: { server: "10.0.0.1:8080" } });
    expect(key.text).toMatch(/Invalid arguments for PullC2SIMInitialization: .*must NOT have additional properties/);
    expect(engine.methods().filter((m) => ["SetRole", "UpdateSymbol", "PullC2SIMInitialization"].includes(m))).toEqual([]);
  });

  it("resolves references from the live context first, then the engine, and refuses unknown ones", async () => {
    const { client, engine } = await setup({
      ...JOINED,
      GetPoidObject: (p) => ({ result: p.poid === "idENG" ? { fsTYPE: "unit", poid: "idENG", fullDescription: "FRIENDLY ARMOR COMPANY E", PrologTerm: "x" } : null }),
      AddTask: (p) => {
        const t = p.task as { who: string; name: string };
        return { events: [{ name: "TaskAdded", params: { poid: "idT1", alternates: [{ fsTYPE: "task", poid: "idT1", name: t.name, who: t.who }] } }] };
      },
    });
    const fromContext = await callWrite(client, "AddTask", { task: { fsTYPE: "task", name: "BlockEnemy", who: "idA", parentCoa: "idC1" } });
    expect(fromContext.report.outcome).toBe("done");
    expect(fromContext.report.validation.find((s: { check: string }) => s.check === "references").detail).toBe(
      "task.who = idA: unit FRIENDLY INFANTRY COMPANY A (live context); task.parentCoa = idC1: COA Write Test COA (friend, by S3) (live context)",
    );
    expect(sent(engine, "GetPoidObject")).toEqual([]);

    const fromEngine = await callWrite(client, "AddTask", { task: { name: "BlockEnemy", who: "idENG" } });
    expect(fromEngine.report.validation.find((s: { check: string }) => s.check === "references").detail).toMatch(
      /task\.who = idENG: unit FRIENDLY ARMOR COMPANY E \(GetPoidObject\)/,
    );

    const unknown = await callWrite(client, "AddTask", { task: { name: "BlockEnemy", who: "idNOPE" } });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Refused by the references check: task\.who = idNOPE names no existing unit or task org unit/);
    expect(sent(engine, "AddTask").length).toBe(2);
  });

  it("refuses an update aimed at an object of another kind", async () => {
    const { client, engine } = await setup(JOINED);
    const res = await callWrite(client, "UpdateTaskOrg", { poid: "idA", taskOrg: { fsTYPE: "task_org", name: "X" } });
    expect(res.text).toMatch(/poid = idA names a unit symbol \(FRIENDLY INFANTRY COMPANY A\), not a task org/);
    expect(sent(engine, "UpdateTaskOrg")).toEqual([]);
  });

  it("refuses UpdateTask on an unknown poid, which the engine would turn into a new task (STP-1091)", async () => {
    const { client, engine } = await setup();
    const res = await callWrite(client, "UpdateTask", { poid: "idNEVER", alternates: [{ fsTYPE: "task", name: "BlockEnemy" }] });
    expect(res.text).toMatch(/poid = idNEVER names no existing task/);
    expect(sent(engine, "UpdateTask")).toEqual([]);
  });
});

describe("V10 through the server", () => {
  it("other: TaskModified instead of TaskAdded is an error that says what happened", async () => {
    const { client } = await setup({
      ...JOINED,
      AddTask: { events: [{ name: "TaskModified", params: { poid: "idT7", alternates: [{ fsTYPE: "task", poid: "idT7", name: "BlockEnemy", who: "idA" }] } }] },
    });
    const res = await callWrite(client, "AddTask", { task: { name: "BlockEnemy", who: "idA" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Did something else: instead of TaskAdded .* STP sent TaskModified for idT7\./);
    expect(res.report.v10.unexpected).toEqual([{ event: "TaskModified", poid: "idT7" }]);
  });

  it("unknown: an inform the engine ignores is never reported as success", async () => {
    const { client } = await setup({ ...JOINED, SetRole: { result: null } });
    const started = Date.now();
    const res = await callWrite(client, "UpdateSymbol", { poid: "idA", symbol: { designator1: "B" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Unknown outcome: nothing at all came back for UpdateSymbol within 0.3 s/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it("not_done: an acknowledged symbol that never came, and a refusal announced by StpMessage", async () => {
    const { client } = await setup({
      AddSymbol: { events: [{ name: "InkProcessed" }] },
      AddCoa: { events: [{ name: "StpMessage", params: { message: "'AddCoa' refused: AddCoa: missing 'coa' - send the COA definition to add", level: "Warning" } }] },
    });
    const sym = await callWrite(client, "AddSymbol", { symbol: { fsTYPE: "unit" } });
    expect(sym.isError).toBe(true);
    expect(sym.text).toMatch(/^Not done: STP took AddSymbol \(acknowledged it: InkProcessed\)/);
    const started = Date.now();
    const coa = await callWrite(client, "AddCoa", { coa: { name: "X" } });
    expect(coa.text).toMatch(/^Not done: STP refused AddCoa: 'AddCoa' refused/);
    expect(Date.now() - started).toBeLessThan(250); // the refusal settles the call without waiting out the timeout
  });

  it("not_done: a request refused with success:false is an explained error, not a raw payload", async () => {
    const { client } = await setup({ ...JOINED, SetCurrentCoa: { success: false, result: "SetCurrentCoa: the engine did not confirm within 10 s" } });
    const res = await callWrite(client, "SetCurrentCoa", { poid: "idC1" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Not done: STP refused SetCurrentCoa: SetCurrentCoa: the engine did not confirm within 10 s/);
    expect(res.report.engineAnswer).toEqual({ success: false, error: "SetCurrentCoa: the engine did not confirm within 10 s" });
  });

  it("unknown: a request with no answer and no event", async () => {
    const { client } = await setup({ ...JOINED, SetCurrentCoa: { noAnswer: true } }, { ...WRITE, timeoutS: 0.2 });
    const res = await callWrite(client, "SetCurrentCoa", { poid: "idC1" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Unknown outcome: STP did not answer SetCurrentCoa within 2\.2 s/);
  });

  it("done: a request with no promised event is confirmed by its answer, which the result carries", async () => {
    const { client } = await setup({ ...JOINED, SetCurrentCoa: { result: null, events: [{ name: "CoaSwitched", params: { coa: { poid: "idC1", name: "Write Test COA", PrologTerm: "x" } } }] } });
    const res = await callWrite(client, "SetCurrentCoa", { poid: "idC1" });
    expect(res.isError).toBe(false);
    expect(res.report).toMatchObject({ outcome: "done", engineAnswer: { success: true, answer: null }, sent: { wire: "request" } });
    // This server switched, so it sees its own CoaSwitched: the context now knows the current COA.
    const ctx = (await call(client, "live_context")).body;
    expect(ctx.current.coa).toEqual({ poid: "idC1", name: "Write Test COA" });
  });

  it("done: a task org relationship confirmed by its event (STP-1089 is fixed)", async () => {
    const { client } = await setup({
      JoinScenarioSession: {
        result: null,
        events: [
          { name: "TaskOrgAdded", params: { poid: "idTO", taskOrg: { fsTYPE: "task_org", poid: "idTO", name: "TO" } } },
          { name: "TaskOrgUnitAdded", params: { poid: "idU1", toUnit: { fsTYPE: "task_org_unit", poid: "idU1", name: "BN HQ" } } },
          { name: "TaskOrgUnitAdded", params: { poid: "idU2", toUnit: { fsTYPE: "task_org_unit", poid: "idU2", name: "ALPHA" } } },
        ],
      },
      AddTaskOrgRelationship: {
        events: [
          {
            name: "TaskOrgRelationshipAdded",
            params: { poid: "idR", toRelationship: { fsTYPE: "task_org_relationship", poid: "idR", parent: "idU1", child: "idU2", relationship: "organic", parentTO: "idTO" } },
          },
        ],
      },
    });
    const res = await callWrite(client, "AddTaskOrgRelationship", {
      toRelationship: { fsTYPE: "task_org_relationship", parent: "idU1", child: "idU2", relationship: "organic", parentTO: "idTO" },
    });
    expect(res.isError).toBe(false);
    expect(res.report).toMatchObject({ outcome: "done" });
    expect(res.report.summary).toMatch(/^Done: /);
  });

  it("partial: a multi-object import that applied 2 of 3, not an error but leading with what is missing", async () => {
    const { client } = await setup(
      {
        ImportCoaFromObjectSet: {
          result: "idC5",
          events: [
            { name: "CoaAdded", params: coaAdded("idC5", "Imported COA") },
            { name: "SymbolAdded", params: unit("idU5", "E") },
          ],
        },
      },
      DESTRUCTIVE,
      { elicit: "accept" },
    );
    const res = await callWrite(client, "ImportCoaFromObjectSet", {
      objects: [
        { fsTYPE: "coa", poid: "idC5", name: "Imported COA" },
        { fsTYPE: "unit", poid: "idU5" },
        { fsTYPE: "unit", poid: "idU6" },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.report.outcome).toBe("partial");
    expect(res.report.summary).toMatch(/^Partly done - missing 1 of 3: objects\[2\] \(unit idU6\)/);
    expect(res.report.v10.missing).toHaveLength(1);
    expect(res.report.engineAnswer).toEqual({ success: true, answer: "idC5" });
  });
});

describe("destructive calls need the user's confirmation", () => {
  const DELETED = { DeleteSymbol: (p: Record<string, unknown>) => ({ events: [{ name: "SymbolDeleted", params: { poid: p.poid, isUndo: false } }] }) };

  it("refuses when the MCP client cannot ask the user (no elicitation)", async () => {
    const { client, engine } = await setup({ ...JOINED, ...DELETED }, DESTRUCTIVE);
    const res = await callWrite(client, "DeleteSymbol", { poid: "idA" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(
      /^STP DeleteSymbol is destructive and needs your confirmation, but this MCP client cannot ask you \(no elicitation support\); run it from your STP client instead\./,
    );
    expect(sent(engine, "DeleteSymbol")).toEqual([]);
    const entry = (await readActions(client)).entries[0];
    expect(entry).toMatchObject({ method: "DeleteSymbol", status: "refused", confirmation: { status: "unsupported" } });
  });

  it("asks through elicitation, naming the method, the target and what is destroyed; accepted, it runs and is logged", async () => {
    const elicited: ElicitRequest[] = [];
    const { client, engine } = await setup({ ...JOINED, ...DELETED }, DESTRUCTIVE, { elicit: "accept", elicited });
    const res = await callWrite(client, "DeleteSymbol", { poid: "idA" });
    expect(res.isError).toBe(false);
    expect(res.report).toMatchObject({ outcome: "done", confirmation: { status: "accepted" } });
    expect(elicited).toHaveLength(1);
    const message = elicited[0].params.message;
    expect(message).toMatch(/^Confirm a destructive STP call: DeleteSymbol\.\nDeletes the symbol idA from the scenario\./);
    expect(message).toMatch(/poid = idA: FRIENDLY INFANTRY COMPANY A/);
    expect(message).toContain(engine.url);
    expect(sent(engine, "DeleteSymbol")).toHaveLength(1);
    const entry = (await readActions(client)).entries[0];
    expect(entry).toMatchObject({ method: "DeleteSymbol", status: "sent", confirmation: { status: "accepted" }, v10: { outcome: "done" } });
    expect(entry.validation.map((s: { check: string }) => s.check)).toEqual(["dispatchable", "params", "writeMode", "confirmation", "context", "references"]);
  });

  it.each([
    ["decline", /the user declined/],
    ["cancel", /the user cancelled/],
    ["accept-unchecked", /the user left 'confirm' unchecked/],
  ] as const)("refuses when the user answers %s", async (answer, why) => {
    const { client, engine } = await setup({ ...JOINED, ...DELETED }, DESTRUCTIVE, { elicit: answer });
    const res = await callWrite(client, "DeleteSymbol", { poid: "idA" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Refused by the confirmation check: /);
    expect(res.text).toMatch(why);
    expect(sent(engine, "DeleteSymbol")).toEqual([]);
    expect((await readActions(client)).entries[0].confirmation.status).toBe(answer === "cancel" ? "cancelled" : "declined");
  });

  it("gives the model no way to confirm: an extra 'confirm' argument is refused by the schema", async () => {
    const { client, engine } = await setup({ ...JOINED, ...DELETED }, DESTRUCTIVE);
    const res = await callWrite(client, "DeleteSymbol", { poid: "idA", confirm: true });
    expect(res.text).toMatch(/Invalid arguments for DeleteSymbol: .*must NOT have additional properties/);
    expect(sent(engine, "DeleteSymbol")).toEqual([]);
  });

  it("asks before checking references (the STP-1064 order), and then refuses a deleted target", async () => {
    const elicited: ElicitRequest[] = [];
    const { client, engine } = await setup({ ...JOINED, ...DELETED }, DESTRUCTIVE, { elicit: "accept", elicited });
    await call(client, "live_status"); // connect: the join replays unit idA
    engine.emit("SymbolDeleted", { poid: "idA", isUndo: false });
    await new Promise((r) => setTimeout(r, 50));
    const res = await callWrite(client, "DeleteSymbol", { poid: "idA" });
    expect(elicited).toHaveLength(1);
    expect(res.text).toMatch(/poid = idA names no existing symbol: it was deleted \(SymbolDeleted at /);
    expect(sent(engine, "DeleteSymbol")).toEqual([]);
  });
});

describe("the action log", () => {
  it("records every write, refused ones included, newest first, without PrologTerm, and in the JSONL file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "stp-actions-")), "actions.jsonl");
    const { client } = await setup(
      { ...JOINED, AddSymbol: { events: [{ name: "InkProcessed" }, { name: "SymbolAdded", params: unit("idB", "B") }] } },
      { ...WRITE, actionLog: file },
      { name: "claude-test" },
    );
    await callWrite(client, "AddSymbol", { symbol: { fsTYPE: "unit", designator1: "B", PrologTerm: "[x]" } });
    await callWrite(client, "DeleteSymbol", { poid: "idA" });
    await callWrite(client, "UpdateSymbol", { poid: "idA" });

    const log = await readActions(client);
    expect(log).toMatchObject({ writeMode: "write", count: 3, cap: 500, file });
    expect(log.entries.map((e: { method: string; status: string }) => `${e.method}:${e.status}`)).toEqual([
      "UpdateSymbol:refused",
      "DeleteSymbol:refused",
      "AddSymbol:sent",
    ]);
    const added = log.entries[2];
    expect(added).toMatchObject({ client: { name: "claude-test", version: "0" }, session: "FAKE-SESSION", safety: "write", v10: { outcome: "done" } });
    expect(added.params).toEqual({ symbol: { fsTYPE: "unit", designator1: "B" } });
    expect(added.v10.observed.map((o: { event: string; as: string }) => `${o.event}:${o.as}`)).toEqual(["InkProcessed:ack", "SymbolAdded:expected"]);
    expect(log.entries[0].validation.at(-1)).toMatchObject({ check: "params", passed: false });

    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.method)).toEqual(["AddSymbol", "DeleteSymbol", "UpdateSymbol"]);
    expect(readFileSync(file, "utf8")).not.toContain("PrologTerm");
    expect((await call(client, "live_status")).body.actionLog).toEqual({ entries: 3, file });
  });

  it("keeps at most its cap in memory", async () => {
    const { client } = await setup({}, {}, {}, { actionLogCap: 2 });
    for (const name of ["AddCoa", "AddTask", "AddSymbol"]) await callWrite(client, name, {});
    const log = await readActions(client);
    expect(log.entries.map((e: { method: string }) => e.method)).toEqual(["AddSymbol", "AddTask"]);
    expect(log.entries[0].id).toBe(3);
  });

  it("notifies subscribers of stp-live://actions", async () => {
    const { client } = await setup({}, {}, {}, { notifyDebounceMs: 20 });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri: "stp-live://actions" });
    await callWrite(client, "AddCoa", {});
    await new Promise((r) => setTimeout(r, 100));
    expect(updates).toEqual(["stp-live://actions"]);
  });
});
