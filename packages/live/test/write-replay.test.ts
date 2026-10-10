import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { callWrite, connectLive, readActions, ReplayEngine } from "./fake-engine.js";

/**
 * The STP-1065 acceptance, against a recorded wire session (fixtures/write-session.jsonl, recorded
 * from a real engine with scripts/live-write-smoke.mjs --record): the user's app had created "Write
 * Test Scenario" in session WRITETEST01. Server 1 (write and destructive mode, an MCP client without
 * elicitation) adds a COA, a unit in it and a task for the unit - V10 reports each done - then is
 * refused an UpdateSymbol on an invented poid and a DeleteSymbol it cannot get confirmed. Server 2,
 * whose client confirms, deletes the unit; STP deletes its task with it. The calls follow the order of
 * the recording, so each request gets the engine's recorded answer.
 */

const fixture = fileURLToPath(new URL("./fixtures/write-session.jsonl", import.meta.url));
const config = { session: "WRITETEST01", timeoutS: 5, write: true, destructive: true, v10TimeoutS: 2 };
let engine: ReplayEngine;

beforeAll(async () => {
  engine = await ReplayEngine.start(fixture);
});
afterAll(async () => {
  await engine.close();
});

const expectedPoid = (report: { v10: { observed: { as: string; poid?: string }[] } }) =>
  report.v10.observed.find((o) => o.as === "expected")?.poid;

let unit: string | undefined;

describe("a recorded write session with a real engine", () => {
  it("adds a COA, a unit in it and a task for the unit, and V10 reports each done", async () => {
    const { client, close } = await connectLive({ url: engine.url, ...config }, { settleMs: 100 }, { name: "replay-no-elicitation" });
    try {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "AddTask")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tools.find((t) => t.name === "DeleteSymbol")?.annotations).toMatchObject({ destructiveHint: true });

      const coa = await callWrite(client, "AddCoa", { coa: { fsTYPE: "coa", name: "Write Test COA", affiliation: "friend", creatorRole: "S3" } });
      expect(coa.isError).toBe(false);
      expect(coa.report.outcome).toBe("done");
      const coaPoid = expectedPoid(coa.report);
      expect(coaPoid).toMatch(/^id\w+$/);

      const symbol = await callWrite(client, "AddSymbol", {
        symbol: {
          fsTYPE: "unit",
          sidc: { charlie: "SFGPUCI----E---", legacy: "SFGPUCI----E---" },
          affiliation: "friend",
          echelon: "company",
          designator1: "A",
          parentCoa: coaPoid,
          location: { fsTYPE: "point", shape: "point", coords: [{ lat: 36.35, lon: -115.8 }], centroid: { lat: 36.35, lon: -115.8 } },
        },
      });
      expect(symbol.report.outcome).toBe("done");
      expect(symbol.report.v10.observed.map((o: { event: string; as: string }) => `${o.event}:${o.as}`)).toEqual(["InkProcessed:ack", "SymbolAdded:expected"]);
      unit = expectedPoid(symbol.report);

      const task = await callWrite(client, "AddTask", {
        task: { fsTYPE: "task", name: "BlockEnemy", who: unit, parentCoa: coaPoid, creatorRole: "S3", what: "BLOCK", how: "AREA_DEFENSE" },
      });
      expect(task.isError).toBe(false);
      expect(task.report.outcome).toBe("done");
      expect(task.report.summary).toMatch(new RegExp(`^Done: TaskAdded where alternates.0.who = "${unit}" and alternates.0.name = "BlockEnemy" \\(poid id\\w+\\)\\.$`));
      expect(task.report.validation.find((s: { check: string }) => s.check === "references").detail).toMatch(
        /task\.who = id\w+: unit FRIENDLY INFANTRY COMPANY A at 36.35, -115.8 \(live context\); task\.parentCoa = id\w+: COA Write Test COA \(friend, by S3\) \(live context\)/,
      );
      // AddTask's TaskModified came right after TaskAdded, about the same task: a follow-on.
      expect(task.report.v10.observed.map((o: { event: string; as: string }) => `${o.event}:${o.as}`)).toEqual(["TaskAdded:expected", "TaskModified:follow-on"]);

      const invented = await callWrite(client, "UpdateSymbol", { poid: "idINVENTED0000000000000000", symbol: { designator1: "Z" } });
      expect(invented.isError).toBe(true);
      expect(invented.text).toMatch(/^Refused by the references check: poid = idINVENTED0000000000000000 names no existing symbol/);

      const del = await callWrite(client, "DeleteSymbol", { poid: unit });
      expect(del.text).toMatch(/^STP DeleteSymbol is destructive and needs your confirmation, but this MCP client cannot ask you/);

      const log = await readActions(client);
      expect(log.entries.map((e: { method: string; status: string; v10?: { outcome: string } }) => `${e.method}:${e.status}:${e.v10?.outcome ?? "-"}`)).toEqual([
        "DeleteSymbol:refused:-",
        "UpdateSymbol:refused:-",
        "AddTask:sent:done",
        "AddSymbol:sent:done",
        "AddCoa:sent:done",
      ]);
      expect(log.entries[0].confirmation.status).toBe("unsupported");
      expect(log.entries[4].client).toEqual({ name: "replay-no-elicitation", version: "0" });
    } finally {
      await close();
    }
  });

  it("runs a destructive call the user confirmed, logs it, and names its side effect", async () => {
    const elicited: ElicitRequest[] = [];
    const { client, close } = await connectLive({ url: engine.url, ...config }, { settleMs: 100 }, { name: "replay-confirming", elicit: "accept", elicited });
    try {
      const del = await callWrite(client, "DeleteSymbol", { poid: unit });
      expect(elicited).toHaveLength(1);
      expect(elicited[0].params.message).toMatch(/Deletes the symbol id\w+ from the scenario\.\nObjects named:\n {2}poid = id\w+: FRIENDLY INFANTRY COMPANY A at 36.35, -115.8/);
      expect(del.isError).toBe(false);
      expect(del.report.outcome).toBe("done");
      expect(del.report.confirmation.status).toBe("accepted");
      // Deleting the unit deleted its task too, which DeleteSymbol's x-stpEmits does not declare.
      expect(del.report.summary).toMatch(/Also seen while it ran: TaskDeleted for id\w+\.$/);
      const entry = (await readActions(client)).entries[0];
      expect(entry).toMatchObject({ method: "DeleteSymbol", status: "sent", safety: "destructive", confirmation: { status: "accepted" }, v10: { outcome: "done" } });
    } finally {
      await close();
    }
  });

  it("replayed every recorded request and nothing else", () => {
    expect(engine.unmatched).toEqual([]);
    expect(engine.unused()).toEqual([]);
  });
});
