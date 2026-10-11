#!/usr/bin/env node
// Live acceptance smoke test of write mode (STP-1065) and V10 (STP-1064) against a real engine. Not run in CI.
//
//   docker run -d --name stp-main -p 9599:9599 -p 9555:9555 stp-server:main
//   npm run build
//   node packages/live/scripts/live-write-smoke.mjs [ws://localhost:9599] [--record test/fixtures/write-session.jsonl]
//
// 0. A server in write mode on a session with no scenario: AddCoa is refused by the context check.
// 1. A raw WebSocket client - the user's STP app - registers a session S, creates a scenario and joins it.
// 2. MCP server 1 over stdio (STP_WRITE=1, STP_DESTRUCTIVE=1, STP_SESSION=S), with an MCP client that does
//    NOT declare elicitation: AddCoa, AddSymbol (a unit in that COA) and AddTask (who = the unit) must each
//    come back with V10 done; UpdateSymbol on an invented poid is refused by the references check; and
//    DeleteSymbol is refused because the client cannot ask the user.
// 3. MCP server 2, with a client that declares elicitation and auto-accepts: DeleteSymbol runs, V10 done.
// 4. stp-live://actions of both servers, and the shared STP_ACTION_LOG file.
//
// --record <file> also routes both MCP servers through a recording proxy, uses the fixed session id
// WRITETEST01, and writes their wire frames (PrologTerm removed) for the replay test.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const args = process.argv.slice(2);
const recordIdx = args.indexOf("--record");
const record = recordIdx === -1 ? undefined : args[recordIdx + 1];
const url = args.find((a, i) => !a.startsWith("--") && i !== recordIdx + 1) ?? "ws://localhost:9599";
const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;
const say = (...a) => console.log(stamp(), ...a);
const checks = [];
const check = (ok, what) => {
  checks.push({ ok, what });
  say(ok ? "PASS" : "FAIL", what);
};
const oneLine = (s, n = 260) => String(s).replace(/\s+/g, " ").slice(0, n);
const strip = (v) =>
  Array.isArray(v)
    ? v.map(strip)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "PrologTerm").map(([k, x]) => [k, strip(x)]))
      : v;

// ---- the recording proxy (only with --record) -----------------------------------------------------

const frames = [];
let serverUrl = url;
let proxy;
if (record) {
  proxy = new WebSocketServer({ port: 0 });
  await new Promise((r) => proxy.once("listening", r));
  serverUrl = `ws://127.0.0.1:${proxy.address().port}`;
  proxy.on("connection", (client) => {
    const engine = new WebSocket(url);
    const queued = [];
    engine.onopen = () => queued.splice(0).forEach((m) => engine.send(m));
    engine.onmessage = (ev) => {
      frames.push({ t: Date.now() - t0, dir: "recv", frame: strip(JSON.parse(String(ev.data))) });
      client.send(String(ev.data));
    };
    engine.onclose = () => client.close();
    client.on("message", (data) => {
      const text = String(data);
      frames.push({ t: Date.now() - t0, dir: "send", frame: strip(JSON.parse(text)) });
      if (engine.readyState === WebSocket.OPEN) engine.send(text);
      else queued.push(text);
    });
    client.on("close", () => engine.close());
  });
}

// ---- the user's app: a raw client ------------------------------------------------------------------

function rawClient() {
  const ws = new WebSocket(url);
  let cookie = 1;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.method === "RequestResponse") {
      const p = pending.get(msg.params.cookie);
      pending.delete(msg.params.cookie);
      if (msg.params.success) p?.resolve(msg.params.result);
      else p?.reject(new Error(`${p.method} refused: ${JSON.stringify(msg.params.result)}`));
    } else events.push(msg);
  };
  return {
    events,
    open: new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error(`cannot reach ${url}`))))),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const k = cookie++;
        pending.set(k, { method, resolve, reject });
        ws.send(JSON.stringify({ method: "Request", params: { jsonRequest: JSON.stringify({ method, params }), cookie: k, timeout: 15 } }));
      }),
    close: () => ws.close(),
  };
}

// ---- MCP servers over stdio ------------------------------------------------------------------------

const logDir = mkdtempSync(join(tmpdir(), "stp-write-smoke-"));
const actionLog = join(logDir, "actions.jsonl");

async function startServer(name, session, { elicit = false, stpUrl = serverUrl } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      STP_URL: stpUrl,
      STP_SESSION: session,
      STP_TIMEOUT_S: "10",
      STP_WRITE: "1",
      STP_DESTRUCTIVE: "1",
      STP_V10_TIMEOUT_S: "8",
      STP_ACTION_LOG: actionLog,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => say(`${name} stderr: ${oneLine(d)}`));
  const client = new Client({ name, version: "1.0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {});
  const elicited = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      elicited.push(request.params.message);
      say(`${name}: the server asks the user to confirm:\n${request.params.message.replace(/^/gm, "        | ")}`);
      say(`${name}: (test harness) the user accepts`);
      return { action: "accept", content: { confirm: true } };
    });
  }
  await client.connect(transport);
  const call = async (tool, toolArgs = {}) => {
    const res = await client.callTool({ name: tool, arguments: toolArgs });
    const text = res.content[0].text;
    const at = text.indexOf("\n\n{");
    const report = text.startsWith("{") ? JSON.parse(text) : at !== -1 ? JSON.parse(text.slice(at + 2)) : undefined;
    return { isError: res.isError === true, text, report };
  };
  const actions = async () => JSON.parse((await client.readResource({ uri: "stp-live://actions" })).contents[0].text);
  return { client, call, actions, elicited };
}

const showWrite = (label, r) => {
  say(`${label}: ${r.isError ? "ERROR " : ""}${oneLine(r.report?.summary ?? r.text, 400)}`);
  if (r.report?.v10) {
    for (const o of r.report.v10.observed) say(`    observed ${o.event}${o.poid ? ` ${o.poid}` : ""} (${o.as})`);
  }
};

// 0. A session with no scenario: the context check refuses a write.
{
  const empty = await startServer("live-write-smoke-noscenario", `WRITENOSCN${Date.now() % 1000000}`, { stpUrl: url });
  const r = await empty.call("AddCoa", { coa: { fsTYPE: "coa", name: "Orphan COA", affiliation: "friend", creatorRole: "S3" } });
  say(`0. AddCoa in a session with no scenario: ${oneLine(r.text.split("\n")[0], 300)}`);
  check(r.isError && /no active scenario/.test(r.text), "a write in a session with no scenario is refused (context check), nothing sent");
  await empty.client.close();
}

// 1. The user's app creates the scenario.
const session = record ? "WRITETEST01" : `WRITESMOKE${Date.now() % 1000000}`;
const app = rawClient();
await app.open;
await app.request("Register", { serviceName: "WriteSmokeApp", language: "javascript", solvables: ["CoaAdded", "SymbolAdded", "SymbolDeleted", "TaskAdded"], machineId: null, sessionId: session });
await app.request("CreateNewScenario", { name: "Write Test Scenario" });
await app.request("JoinScenarioSession", {});
say(`1. app: session ${session}, scenario "Write Test Scenario" created`);

// 2. Server 1: a client without elicitation.
const one = await startServer("live-write-smoke", session);
const { tools } = await one.client.listTools();
const names = new Set(tools.map((t) => t.name));
check(["AddCoa", "AddSymbol", "AddTask", "DeleteSymbol"].every((n) => names.has(n)), `write mode lists the write and destructive tools (${tools.length} tools)`);

const coaRes = await one.call("AddCoa", { coa: { fsTYPE: "coa", name: "Write Test COA", affiliation: "friend", creatorRole: "S3" } });
showWrite("2a. AddCoa", coaRes);
const coa = coaRes.report?.v10.observed.find((o) => o.as === "expected")?.poid;
check(coaRes.report?.outcome === "done" && Boolean(coa), `AddCoa: V10 done (COA ${coa})`);

const unitRes = await one.call("AddSymbol", {
  symbol: {
    fsTYPE: "unit",
    sidc: { charlie: "SFGPUCI----E---", legacy: "SFGPUCI----E---" },
    affiliation: "friend",
    echelon: "company",
    designator1: "A",
    parentCoa: coa,
    location: { fsTYPE: "point", shape: "point", coords: [{ lat: 36.35, lon: -115.8 }], centroid: { lat: 36.35, lon: -115.8 } },
  },
});
showWrite("2b. AddSymbol", unitRes);
const unit = unitRes.report?.v10.observed.find((o) => o.as === "expected")?.poid;
check(unitRes.report?.outcome === "done" && Boolean(unit), `AddSymbol (a unit in that COA): V10 done (unit ${unit})`);

const taskRes = await one.call("AddTask", {
  task: { fsTYPE: "task", name: "BlockEnemy", who: unit, parentCoa: coa, creatorRole: "S3", what: "BLOCK", how: "AREA_DEFENSE" },
});
showWrite("2c. AddTask", taskRes);
check(taskRes.report?.outcome === "done", `AddTask (who = the unit): V10 done (task ${taskRes.report?.v10.observed.find((o) => o.as === "expected")?.poid})`);
say(`    references: ${taskRes.report?.validation.find((s) => s.check === "references")?.detail}`);

const invented = await one.call("UpdateSymbol", { poid: "idINVENTED0000000000000000", symbol: { designator1: "Z" } });
say(`2d. UpdateSymbol on an invented poid: ${oneLine(invented.text.split("\n")[0], 400)}`);
check(invented.isError && /references check/.test(invented.text), "a write naming an invented poid is refused by the references check");

const noElicit = await one.call("DeleteSymbol", { poid: unit });
say(`2e. DeleteSymbol, client without elicitation: ${oneLine(noElicit.text.split("\n")[0], 400)}`);
check(noElicit.isError && /cannot ask you \(no elicitation support\)/.test(noElicit.text), "a destructive call through a client without elicitation is refused");

const log1 = await one.actions();
say(`2f. stp-live://actions (server 1), newest first:`);
for (const e of log1.entries) {
  say(`    #${e.id} ${e.method} ${e.status}${e.confirmation ? ` confirmation=${e.confirmation.status}` : ""}${e.v10 ? ` v10=${e.v10.outcome}` : ` refused by ${e.validation.at(-1).check}`} client=${e.client?.name}`);
}
await one.client.close();

// 3. Server 2: a client that declares elicitation and accepts.
const two = await startServer("live-write-smoke-confirming", session, { elicit: true });
const del = await two.call("DeleteSymbol", { poid: unit });
showWrite("3. DeleteSymbol, client with elicitation", del);
check(!del.isError && del.report?.outcome === "done" && two.elicited.length === 1, "with the user's confirmation DeleteSymbol runs and V10 reports done");
const log2 = await two.actions();
const entry = log2.entries[0];
say(`4. stp-live://actions (server 2): ${JSON.stringify({ ...entry, v10: { outcome: entry.v10.outcome, summary: entry.v10.summary } }, null, 2).replace(/\n/g, "\n        ")}`);
check(entry.method === "DeleteSymbol" && entry.status === "sent" && entry.confirmation.status === "accepted", "the confirmed destructive call is logged with its confirmation and V10 report");
await two.client.close();

const file = readFileSync(actionLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
say(`   ${actionLog}: ${file.length} entries: ${file.map((e) => `${e.method}/${e.status}`).join(", ")}`);
check(file.length === log1.entries.length + log2.entries.length + 1, "the JSONL action log holds every entry of both servers (and the no-scenario refusal)");

app.close();
if (record) {
  proxy.close();
  writeFileSync(record, frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  say(`wrote ${frames.length} frames to ${record}`);
}
const failed = checks.filter((c) => !c.ok);
say(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
