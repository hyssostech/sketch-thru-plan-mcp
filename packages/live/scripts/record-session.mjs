#!/usr/bin/env node
// Records the wire session of the live MCP server against a real STP engine, for the replay
// integration test (test/fixtures/session.jsonl). Not run in CI.
//
//   npm run build
//   node packages/live/scripts/record-session.mjs [ws://localhost:9599] [out.jsonl]
//
// 1. A raw WebSocket client - standing in for the user's STP app - registers session LIVETEST01,
//    creates a synthetic scenario and adds a COA, a unit and a task.
// 2. The live MCP server (built dist) connects through a recording proxy with STP_SESSION=LIVETEST01
//    and an in-memory MCP client calls a few read tools. Meanwhile the app adds a second unit and
//    switches the current COA, so the recording holds live events as well as the join replay.
// 3. The proxy's frames (only the MCP server's connection) are written as JSON lines, PrologTerm
//    removed. Use a freshly started engine: the session id is fixed so the fixture is stable.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLiveServer } from "../dist/server.js";

const upstream = process.argv[2] ?? "ws://localhost:9599";
const out = process.argv[3] ?? fileURLToPath(new URL("../test/fixtures/session.jsonl", import.meta.url));
const SESSION = "LIVETEST01";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const strip = (v) =>
  Array.isArray(v)
    ? v.map(strip)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "PrologTerm").map(([k, x]) => [k, strip(x)]))
      : v;

// ---- the recording proxy -------------------------------------------------------------------------

const frames = [];
const t0 = Date.now();
const proxy = new WebSocketServer({ port: 0 });
await new Promise((r) => proxy.once("listening", r));
const proxyUrl = `ws://127.0.0.1:${proxy.address().port}`;
proxy.on("connection", (client) => {
  const engine = new WebSocket(upstream);
  const queued = [];
  engine.onopen = () => queued.splice(0).forEach((m) => engine.send(m));
  engine.onmessage = (ev) => {
    frames.push({ t: Date.now() - t0, dir: "recv", frame: strip(JSON.parse(String(ev.data))) });
    client.send(String(ev.data));
  };
  engine.onclose = () => client.close();
  client.on("message", (data) => {
    const text = String(data);
    frames.push({ t: Date.now() - t0, dir: "send", frame: JSON.parse(text) });
    if (engine.readyState === WebSocket.OPEN) engine.send(text);
    else queued.push(text);
  });
  client.on("close", () => engine.close());
});

// ---- the user's app: a raw client ----------------------------------------------------------------

function rawClient(url) {
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
    inform: (method, params) => ws.send(JSON.stringify({ method, params })),
    waitFor: async (method, pred = () => true, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const e = events.find((x) => x.method === method && pred(x));
        if (e) return e;
        await sleep(25);
      }
      throw new Error(`no ${method} within ${ms} ms`);
    },
    close: () => ws.close(),
  };
}

const unit = (designator, lat, lon) => ({
  fsTYPE: "unit",
  sidc: { charlie: "SFGPUCI----E---", legacy: "SFGPUCI----E---" },
  affiliation: "friend",
  echelon: "company",
  designator1: designator,
  location: { fsTYPE: "point", shape: "point", coords: [{ lat, lon }], centroid: { lat, lon } },
});

const app = rawClient(upstream);
await app.open;
const solvables = ["CoaAdded", "SymbolAdded", "TaskAdded", "CoaSwitched", "StpMessage"];
await app.request("Register", { serviceName: "LiveTestApp", language: "javascript", solvables, machineId: null, sessionId: SESSION });
await app.request("CreateNewScenario", { name: "Live Test Scenario" });
await app.request("JoinScenarioSession", {});
app.inform("AddCoa", { coa: { fsTYPE: "coa", name: "Live Test COA", affiliation: "friend", creatorRole: "S3" } });
const coa = (await app.waitFor("CoaAdded", (e) => e.params.coa?.name === "Live Test COA")).params.poid;
app.inform("AddSymbol", { symbol: unit("A", 36.35, -115.8) });
const alpha = (await app.waitFor("SymbolAdded")).params.alternates[0].poid;
app.inform("AddTask", {
  task: { fsTYPE: "task", name: "BlockEnemy", who: alpha, creatorRole: "S3", what: "BLOCK", how: "area_defense" },
});
await app.waitFor("TaskAdded").catch(() => console.error("note: no TaskAdded (recording continues without a task)"));
await sleep(1000);
console.log(`app: session ${SESSION}, COA ${coa}, unit ${alpha}`);

// ---- the live MCP server, through the proxy ------------------------------------------------------

const live = createLiveServer({ config: { url: proxyUrl, session: SESSION, timeoutS: 10 } });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await live.mcp.connect(serverSide);
const mcp = new Client({ name: "recorder", version: "0" });
await mcp.connect(clientSide);
const call = async (name, args = {}) => {
  const res = await mcp.callTool({ name, arguments: args });
  console.log(`${name}${res.isError ? " ERROR" : ""}: ${res.content[0].text.slice(0, 160).replace(/\s+/g, " ")}`);
  return res;
};

await call("HasActiveScenario");
await call("GetActiveScenarioDescription");
await call("GetCoaContent", { poid: coa });
// A live change while the server is connected: a second unit, then the current COA.
app.inform("AddSymbol", { symbol: unit("B", 36.36, -115.81) });
const bravo = (await app.waitFor("SymbolAdded", (e) => e.params.alternates[0].poid !== alpha)).params.alternates[0].poid;
await app.request("SetCurrentCoa", { poid: coa });
await sleep(1500);
await call("GetPoidObject", { poid: bravo });
await call("GetScenarioContent");
await call("live_context");

await mcp.close();
await live.close();
app.close();
proxy.close();

writeFileSync(out, frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
console.log(`wrote ${frames.length} frames to ${out}`);
process.exit(0);
