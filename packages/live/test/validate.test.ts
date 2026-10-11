import { describe, expect, it } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { loadContract, loadValidations, loadValidationsSchema, type MethodRules } from "stp-mcp-contract-tools";
import {
  V10Watch,
  checkPreconditions,
  checkReferences,
  checkRequired,
  checkWriteMode,
  confirmationText,
  eventPoid,
  expandPath,
  expectedItems,
  getPath,
  kindOfFsType,
  referenceTargets,
  sameValue,
  type CallEnd,
  type Lookup,
} from "../src/validate.js";

const rules = loadValidations();
const contract = loadContract();
const R = (method: string): MethodRules => rules.methods[method];
const issues = (method: string) => contract.methods.find((m) => m.name === method)!["x-stpKnownIssues"] ?? [];
const at = new Date("2026-10-10T12:00:00Z");
const ev = (name: string, params?: unknown) => ({ name, params, at });
const watch = (method: string, params: Record<string, unknown>, knownIssues = issues(method)) =>
  new V10Watch(method, R(method), params, rules, knownIssues);
const inform: CallEnd = { wire: "inform", waitedMs: 300, timeoutS: 0.3 };
const answered: CallEnd = { wire: "request", answered: true, waitedMs: 20, timeoutS: 0.3 };

const coaAdded = (poid: string, name: string) => ev("CoaAdded", { poid, coa: { fsTYPE: "coa", poid, name }, isUndo: false });
const symbolAdded = (poid: string, designator1 = "A", fsTYPE = "unit") =>
  ev("SymbolAdded", { alternates: [{ fsTYPE, poid, designator1 }], isUndo: false });
const task = (name: string, poid: string, who: string) => ev(name, { poid, alternates: [{ fsTYPE: "task", poid, name: "BlockEnemy", who }], isUndo: false });

describe("the pinned rule file", () => {
  it("validates against its own schema", () => {
    const validate = new AjvJsonSchemaValidator().getValidator(loadValidationsSchema() as JsonSchemaType);
    const result = validate(rules);
    expect(result.errorMessage).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("rejects what its schema forbids", () => {
    const validate = new AjvJsonSchemaValidator().getValidator(loadValidationsSchema() as JsonSchemaType);
    const broken = structuredClone(rules) as unknown as { methods: Record<string, Record<string, unknown>> };
    broken.methods.AddCoa.intent = { expect: [{ event: "CoaAdded", anyOf: [] }] };
    broken.methods.DeleteSymbol.references = [{ param: "poid", kind: "planet" }];
    expect(validate(broken).valid).toBe(false);
  });
});

describe("paths and values", () => {
  it("reads dotted paths, array indexes and lengths", () => {
    const v = { task: { who: "idU", tgs: ["idG1", "idG2"] }, alternates: [{ poid: "idT" }] };
    expect(getPath(v, "task.who")).toBe("idU");
    expect(getPath(v, "alternates.0.poid")).toBe("idT");
    expect(getPath(v, "task.tgs.length")).toBe(2);
    expect(getPath(v, "task.nope.deeper")).toBeUndefined();
    expect(expandPath(v, "task.tgs.*")).toEqual([
      { path: "task.tgs.0", value: "idG1" },
      { path: "task.tgs.1", value: "idG2" },
    ]);
    expect(expandPath({ alternates: [{ who: "a" }, {}, { who: "c" }] }, "alternates.*.who").map((x) => x.path)).toEqual([
      "alternates.0.who",
      "alternates.2.who",
    ]);
  });

  it("compares strings without regard to case, as the engine changes the case of enum values", () => {
    expect(sameValue("S3", "s3")).toBe(true);
    expect(sameValue("area_defense", "AREA_DEFENSE")).toBe(true);
    expect(sameValue(1, "1")).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
  });

  it("finds the poid an event is about", () => {
    expect(eventPoid({ poid: "idX" })).toBe("idX");
    expect(eventPoid({ alternates: [{ poid: "idS" }] })).toBe("idS");
    expect(eventPoid({ coa: { poid: "idC" } })).toBe("idC");
    expect(eventPoid(null)).toBeUndefined();
  });
});

describe("before the call", () => {
  it("V5: a write needs write mode, a destructive call destructive mode", () => {
    expect(checkWriteMode("AddCoa", "write", "off")).toMatchObject({ passed: false, check: "writeMode" });
    expect(checkWriteMode("AddCoa", "write", "off").detail).toMatch(/AddCoa is a write STP method. This live server is read-only/);
    expect(checkWriteMode("AddCoa", "write", "write").passed).toBe(true);
    expect(checkWriteMode("DeleteSymbol", "destructive", "write").detail).toMatch(/STP_DESTRUCTIVE is not set/);
    expect(checkWriteMode("DeleteSymbol", "destructive", "destructive").passed).toBe(true);
  });

  it("refuses a call without a param the engine silently needs", () => {
    const step = checkRequired("UpdateSymbol", R("UpdateSymbol"), { poid: "idS" });
    expect(step).toMatchObject({ check: "params", passed: false });
    expect(step.detail).toMatch(/UpdateSymbol needs symbol\. Without it STP ignores the call and says nothing/);
    expect(checkRequired("UpdateSymbol", R("UpdateSymbol"), { poid: "idS", symbol: { designator1: "B" } }).passed).toBe(true);
    expect(checkRequired("AdvertiseViewport", R("AdvertiseViewport"), {}).detail).toMatch(/needs topLeft and botRight/);
  });

  it("refuses a write in a session with no active scenario, except the calls that create one", () => {
    const no = checkPreconditions("AddCoa", R("AddCoa"), { activeScenario: false });
    expect(no).toMatchObject({ check: "context", passed: false });
    expect(no.detail).toMatch(/no active scenario.*HasActiveScenario stays false/s);
    expect(checkPreconditions("AddCoa", R("AddCoa"), { activeScenario: true }).passed).toBe(true);
    expect(checkPreconditions("AddCoa", R("AddCoa"), { activeScenario: null, problem: "timeout" }).detail).toMatch(/could not tell.*timeout/);
    expect(checkPreconditions("CreateNewScenario", R("CreateNewScenario"), { activeScenario: false }).passed).toBe(true);
  });

  it("lists the poids a call names, the required ones missing, and the values that are not poids", () => {
    const params = { task: { who: "idU", tgs: ["idG1", "idG2"], parentCoa: "idC", name: "BlockEnemy" } };
    const refs = referenceTargets(R("AddTask"), params);
    expect(refs.targets.map((t) => `${t.param}=${t.poid}:${t.kinds.join("|")}`)).toEqual([
      "task.who=idU:unit|taskOrgUnit",
      "task.tgs.0=idG1:symbol",
      "task.tgs.1=idG2:symbol",
      "task.parentCoa=idC:coa",
    ]);
    expect(referenceTargets(R("DeleteSymbol"), {}).missing).toEqual(["poid"]);
    expect(referenceTargets(R("DeleteSymbol"), { poid: 42 }).malformed).toEqual(["poid = 42"]);
    expect(referenceTargets(R("AddSymbol"), { symbol: { fsTYPE: "unit" } }).targets).toEqual([]);
  });

  const lookups = (entries: Record<string, Lookup>) => new Map(Object.entries(entries));
  const unitA: Lookup = { found: true, source: "context", kind: "symbol", fsTYPE: "unit", summary: "FRIENDLY INFANTRY COMPANY A" };

  it("passes poids that name existing objects of the right kind, saying where it found them", () => {
    const refs = referenceTargets(R("AddTask"), { task: { who: "idU", parentCoa: "idC" } });
    const step = checkReferences("AddTask", refs, lookups({ idU: unitA, idC: { found: true, source: "engine", kind: "coa", fsTYPE: "coa", summary: "Write Test COA" } }));
    expect(step.passed).toBe(true);
    expect(step.detail).toBe(
      "task.who = idU: unit FRIENDLY INFANTRY COMPANY A (live context); task.parentCoa = idC: COA Write Test COA (GetPoidObject)",
    );
  });

  it("refuses an unknown, deleted or missing target poid", () => {
    const unknown = checkReferences("UpdateTask", referenceTargets(R("UpdateTask"), { poid: "idNEW", alternates: [] }), lookups({ idNEW: { found: false, source: "engine" } }));
    expect(unknown).toMatchObject({ check: "references", passed: false });
    expect(unknown.detail).toMatch(/poid = idNEW names no existing task: it is not in the live context, and GetPoidObject answers null/);
    expect(unknown.detail).toMatch(/Nothing was sent/);

    const deleted = checkReferences(
      "DeleteSymbol",
      referenceTargets(R("DeleteSymbol"), { poid: "idA" }),
      lookups({ idA: { found: false, source: "context", deleted: { event: "SymbolDeleted", at: "2026-10-10T12:00:00.000Z" } } }),
    );
    expect(deleted.detail).toMatch(/idA names no existing symbol: it was deleted \(SymbolDeleted at 2026-10-10T12:00:00.000Z\)/);

    const missing = checkReferences("UndoLastOp", referenceTargets(R("UndoLastOp"), {}), lookups({}));
    expect(missing.detail).toMatch(/poid is missing: it names the object UndoLastOp acts on/);
  });

  it("refuses a poid of the wrong kind (a cross-type update rewrites the object's type)", () => {
    const step = checkReferences("UpdateTaskOrg", referenceTargets(R("UpdateTaskOrg"), { poid: "idU", taskOrg: {} }), lookups({ idU: unitA }));
    expect(step.passed).toBe(false);
    expect(step.detail).toMatch(/poid = idU names a unit symbol \(FRIENDLY INFANTRY COMPANY A\), not a task org/);
    const tg: Lookup = { found: true, source: "context", kind: "symbol", fsTYPE: "tg", summary: "OBJECTIVE BRAVO" };
    expect(checkReferences("AddTask", referenceTargets(R("AddTask"), { task: { who: "idG" } }), lookups({ idG: tg })).detail).toMatch(
      /task\.who = idG names a tg symbol \(OBJECTIVE BRAVO\), not a unit or task org unit/,
    );
  });

  it("says when a kind is only inferred", () => {
    const { kind, inferred } = kindOfFsType("weapon_system");
    expect(kind).toBe("symbol");
    expect(inferred).toMatch(/kind inferred: fsTYPE 'weapon_system' is not a known object type/);
    expect(kindOfFsType("task_org_unit")).toEqual({ kind: "taskOrgUnit" });
    const engine: Lookup = { found: true, source: "engine", kind, fsTYPE: "weapon_system", inferred };
    const ok = checkReferences("DeleteSymbol", referenceTargets(R("DeleteSymbol"), { poid: "idW" }), lookups({ idW: engine }));
    expect(ok.passed).toBe(true);
    expect(ok.detail).toMatch(/kind inferred/);
    const noType: Lookup = { found: true, source: "context", kind: "symbol" };
    expect(checkReferences("AddTask", referenceTargets(R("AddTask"), { task: { who: "idX" } }), lookups({ idX: noType })).detail).toMatch(
      /kind inferred: a symbol whose fsTYPE was not reported, taken to be a unit/,
    );
  });

  it("refuses when a poid could not be checked, rather than guess", () => {
    const step = checkReferences("DeleteTask", referenceTargets(R("DeleteTask"), { poid: "idT" }), lookups({ idT: { found: false, source: "engine", error: "STP did not answer" } }));
    expect(step.detail).toMatch(/idT could not be checked: .*GetPoidObject failed \(STP did not answer\)/);
  });

  it("fills a destructive call's confirmation text from its params", () => {
    expect(confirmationText(R("DeleteSymbol"), { poid: "idA" })).toBe("Deletes the symbol idA from the scenario.");
    expect(confirmationText(R("ImportCoaFromObjectSet"), { objects: [{}, {}, {}] })).toMatch(/^Imports the 3 objects given/);
    expect(confirmationText(R("CreateNewScenario"), {})).toMatch(/named \(no name\)/);
  });
});

describe("V10: diff intended vs actual", () => {
  it("done: the expected event arrived, matched without regard to case, with its poid", () => {
    const w = watch("AddCoa", { coa: { fsTYPE: "coa", name: "Write Test COA" } });
    expect(w.items.map((i) => i.label)).toEqual(['CoaAdded where coa.name = "Write Test COA"']);
    expect(w.observe(symbolAdded("idOTHER"))).toBe(false); // another client's work
    expect(w.observe(coaAdded("idC1", "write test coa"))).toBe(true);
    const r = w.report(inform);
    expect(r.outcome).toBe("done");
    expect(r.summary).toBe('Done: CoaAdded where coa.name = "Write Test COA" (poid idC1).');
    expect(r.observed).toEqual([{ event: "CoaAdded", poid: "idC1", at: at.toISOString(), as: "expected", fulfils: r.expected[0] }]);
    expect(r.unrelatedEvents).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it("done: AddTask's TaskModified right after TaskAdded is a follow-on, not something else", () => {
    const w = watch("AddTask", { task: { name: "BlockEnemy", who: "idU" } });
    w.observe(task("TaskAdded", "idT", "idU"));
    w.observe(task("TaskModified", "idT", "idU"));
    const r = w.report(inform);
    expect(r.outcome).toBe("done");
    expect(r.observed.map((o) => o.as)).toEqual(["expected", "follow-on"]);
    expect(r.unexpected).toEqual([]);
  });

  it("partial: a multi-object import that applied 2 of 3 objects, leading with what is missing", () => {
    const objects = [
      { fsTYPE: "coa", poid: "idC" },
      { fsTYPE: "unit", poid: "idU1" },
      { fsTYPE: "unit", poid: "idU2" },
      { fsTYPE: "system_state", poid: "idSYS" },
    ];
    const w = watch("ImportCoaFromObjectSet", { objects });
    expect(w.items.map((i) => i.label)).toEqual([
      'objects[0] (coa idC): CoaAdded where poid = "idC" or CoaDeleted where poid = "idC"',
      'objects[1] (unit idU1): SymbolAdded where alternates.0.poid = "idU1" or SymbolDeleted where poid = "idU1"',
      'objects[2] (unit idU2): SymbolAdded where alternates.0.poid = "idU2" or SymbolDeleted where poid = "idU2"',
    ]);
    w.observe(coaAdded("idC", "Imported COA"));
    w.observe(symbolAdded("idU1"));
    const r = w.report(answered);
    expect(r.outcome).toBe("partial");
    expect(r.summary).toMatch(/^Partly done - missing 1 of 3: objects\[2\] \(unit idU2\)/);
    expect(r.summary).toMatch(/Done: objects\[0\] \(coa idC\): CoaAdded where poid = "idC" or .*; objects\[1\] \(unit idU1\): /);
    expect(r.summary).not.toMatch(/\(poid idC\)/); // the label already names it
    expect(r.missing).toEqual([w.items[2].label]);
  });

  it("partial: an import the engine refused after applying part of it (the STP-1090 partial apply)", () => {
    const w = watch("ImportPlanDataFromObjectSet", { objects: [{ fsTYPE: "coa", poid: "idC" }, { fsTYPE: "task", poid: "idT" }] });
    w.observe(coaAdded("idC", "C"));
    const r = w.report({ wire: "request", refused: "STP did not acknowledge fsdb_update add for 'idT'", waitedMs: 4000, timeoutS: 8 });
    expect(r.outcome).toBe("partial");
    expect(r.summary).toMatch(/missing 1 of 2: objects\[1\] \(task idT\).*STP refused the rest: STP did not acknowledge/);
  });

  it("anyOf: an imported object with the deletion version arrives as *Deleted, and counts", () => {
    const w = watch("ImportCoaFromObjectSet", { objects: [{ fsTYPE: "coa", poid: "idC" }] });
    expect(w.observe(ev("CoaDeleted", { poid: "idC", isUndo: false }))).toBe(true);
    expect(w.report(answered).outcome).toBe("done");
  });

  it("not_done: the engine acknowledged the call (InkProcessed) but the symbol never came", () => {
    const w = watch("AddSymbol", { symbol: { fsTYPE: "unit" } });
    w.observe(ev("InkProcessed"));
    const r = w.report(inform);
    expect(r.outcome).toBe("not_done");
    expect(r.summary).toMatch(/Not done: STP took AddSymbol \(acknowledged it: InkProcessed\) but SymbolAdded where alternates.0.fsTYPE = "unit" did not arrive within 0.3 s/);
  });

  it("not_done: a refusal announced by StpMessage settles the call at once", () => {
    const w = watch("AddCoa", { coa: { name: "X" } });
    expect(w.observe(ev("StpMessage", { message: "a general warning", level: "Warning" }))).toBe(false);
    expect(w.observe(ev("StpMessage", { message: "'AddCoa' refused: AddCoa: missing 'coa'", level: "Warning" }))).toBe(true);
    const r = w.report(inform);
    expect(r.outcome).toBe("not_done");
    expect(r.refusal).toBe("'AddCoa' refused: AddCoa: missing 'coa'");
    expect(r.summary).toBe("Not done: STP refused AddCoa: 'AddCoa' refused: AddCoa: missing 'coa'");
  });

  it("not_done: a request the engine refused (success:false)", () => {
    const r = watch("SetCurrentCoa", { poid: "idC" }).report({ wire: "request", refused: "SetCurrentCoa: the engine did not confirm within 10 s", waitedMs: 10000, timeoutS: 8 });
    expect(r.outcome).toBe("not_done");
    expect(r.summary).toMatch(/Not done: STP refused SetCurrentCoa: SetCurrentCoa: the engine did not confirm/);
  });

  it("other: TaskModified instead of TaskAdded", () => {
    const w = watch("AddTask", { task: { name: "BlockEnemy", who: "idU" } });
    w.observe(task("TaskModified", "idT9", "idU"));
    const r = w.report(inform);
    expect(r.outcome).toBe("other");
    expect(r.unexpected).toEqual([{ event: "TaskModified", poid: "idT9" }]);
    expect(r.summary).toMatch(/Did something else: instead of TaskAdded where .*, STP sent TaskModified for idT9/);
  });

  it("other: an update that answered with a delete", () => {
    const w = watch("UpdateSymbol", { poid: "idA", symbol: {} });
    w.observe(ev("SymbolDeleted", { poid: "idA", isUndo: false }));
    expect(w.report(inform).outcome).toBe("other");
  });

  it("unknown: nothing at all came back for an inform within the timeout", () => {
    const r = watch("DeleteSymbol", { poid: "idA" }).report(inform);
    expect(r.outcome).toBe("unknown");
    expect(r.summary).toMatch(/Unknown outcome: nothing at all came back for DeleteSymbol within 0.3 s/);
  });

  it("unknown: a request that got no answer and no event", () => {
    const r = watch("SetDefaultTaskOrg", { poid: "idTO" }).report({ wire: "request", failure: "STP did not answer SetDefaultTaskOrg within 7 s.", waitedMs: 7000, timeoutS: 8 });
    expect(r.outcome).toBe("unknown");
    expect(r.summary).toBe("Unknown outcome: STP did not answer SetDefaultTaskOrg within 7 s.");
  });

  it("unverifiable: relationship events the engine does not send (STP-1089), never a false not_done", () => {
    const w = watch("AddTaskOrgRelationship", { toRelationship: { parent: "idU1", child: "idU2", relationship: "organic" } });
    expect(issues("AddTaskOrgRelationship")).toContain("STP-1089");
    const r = w.report(inform);
    expect(r.outcome).toBe("unverifiable");
    expect(r.knownIssue).toBe("STP-1089");
    expect(r.summary).toMatch(/^Unverifiable \(STP-1089\): the engine applies a task org relationship add/);
    // Once the issue is fixed (dropped from x-stpKnownIssues), the absence counts again.
    expect(watch("AddTaskOrgRelationship", { toRelationship: { parent: "idU1", child: "idU2" } }, []).report(inform).outcome).toBe("unknown");
    // And when the event does arrive, it is simply done.
    const w2 = watch("AddTaskOrgRelationship", { toRelationship: { parent: "idU1", child: "idU2" } });
    w2.observe(ev("TaskOrgRelationshipAdded", { poid: "idR", toRelationship: { poid: "idR", parent: "idU1", child: "idU2" } }));
    expect(w2.report(inform).outcome).toBe("done");
  });

  it("an inform that promises no event is unverifiable, unless refused", () => {
    const quiet = watch("SetAutoTasking", { isEnabled: true }).report({ wire: "inform", waitedMs: 1000, timeoutS: 8 });
    expect(quiet.outcome).toBe("unverifiable");
    expect(quiet.summary).toMatch(/STP sends no answer to SetAutoTasking and the contract promises no event for it/);
    const w = watch("ChangeTimeOut", { timeout: 3 });
    expect(w.observe(ev("StpMessage", { message: "Could not read 'ChangeTimeOut': Could not convert string to double", level: "Warning" }))).toBe(true);
    expect(w.report(inform).outcome).toBe("not_done");
  });

  it("a request that promises no event is done by its answer", () => {
    const r = watch("SetRole", { role: "S3" }).report(answered);
    expect(r.outcome).toBe("done");
    expect(r.summary).toMatch(/STP answered SetRole with success. The contract promises no event for it/);
    expect(r.expected).toEqual([]);
  });

  it("expects nothing for an object-set item it cannot map, and one event per symbol of any symbol type", () => {
    const items = expectedItems(R("LoadNewScenarioFromObjectSet"), {
      objects: [{ fsTYPE: "planning_scenario", poid: "idP" }, { fsTYPE: "tg", poid: "idG" }, { fsTYPE: "task_org_unit", poid: "idTU" }],
    });
    expect(items.map((i) => i.label.split(":")[0])).toEqual(["objects[2] (task_org_unit idTU)", "objects[1] (tg idG)"]);
  });

  it("does not constrain a match on a param the call left out", () => {
    const w = watch("AddSymbol", { symbol: { fsTYPE: "tg" } });
    expect(w.items[0].label).toBe('SymbolAdded where alternates.0.fsTYPE = "tg"');
    expect(w.observe(symbolAdded("idG", "", "tg"))).toBe(true);
  });
});
