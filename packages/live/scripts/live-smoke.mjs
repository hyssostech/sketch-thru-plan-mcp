#!/usr/bin/env node
// Live acceptance smoke test of the live-STP MCP server against a real engine. Not run in CI.
//
//   docker run -d --name stp-main -p 9599:9599 -p 9555:9555 stp-server:main
//   npm run build
//   node packages/live/scripts/live-smoke.mjs [ws://localhost:9599] [container-name]
//
// 1. A raw WebSocket client - as a user's app would - registers a new session S, creates a scenario,
//    joins it, adds a COA and a friendly infantry company.
// 2. The built MCP server is started over stdio with STP_SESSION=S (the SDK's StdioClientTransport).
// 3. The tool list must hold no write tool.
// 4. HasActiveScenario, GetScenarioContent and live_context: lastAdded.symbol must be the unit just added.
// 5. GetPoidObject on that poid.
// 6. `docker restart <container>`: the explained error while the engine is down, then the recovery.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.argv[2] ?? "ws://localhost:9599";
const container = process.argv[3] ?? "stp-main";
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
const oneLine = (s, n = 220) => s.replace(/\s+/g, " ").slice(0, n);

// ---- 1. the user's app ---------------------------------------------------------------------------

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
    open: new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error(`cannot reach ${url}`))))),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const k = cookie++;
        pending.set(k, { method, resolve, reject });
        ws.send(JSON.stringify({ method: "Request", params: { jsonRequest: JSON.stringify({ method, params }), cookie: k, timeout: 15 } }));
      }),
    inform: (method, params) => ws.send(JSON.stringify({ method, params })),
    waitFor: async (method, pred = () => true, ms = 10000) => {
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

say(`engine ${url}, container ${container}`);
const app = rawClient();
await app.open;
const session = await app.request("Register", {
  serviceName: "LiveSmokeApp",
  language: "javascript",
  solvables: ["CoaAdded", "SymbolAdded", "StpMessage"],
  machineId: null,
  sessionId: `LIVESMOKE${Date.now() % 1000000}`,
});
await app.request("CreateNewScenario", { name: "Live Smoke Scenario" });
await app.request("JoinScenarioSession", {});
app.inform("AddCoa", { coa: { fsTYPE: "coa", name: "Live Test COA", affiliation: "friend", creatorRole: "S3" } });
const coa = (await app.waitFor("CoaAdded", (e) => e.params.coa?.name === "Live Test COA")).params.poid;
app.inform("AddSymbol", {
  symbol: {
    fsTYPE: "unit",
    sidc: { charlie: "SFGPUCI----E---", legacy: "SFGPUCI----E---" },
    affiliation: "friend",
    echelon: "company",
    designator1: "A",
    location: { fsTYPE: "point", shape: "point", coords: [{ lat: 36.35, lon: -115.8 }], centroid: { lat: 36.35, lon: -115.8 } },
  },
});
const added = (await app.waitFor("SymbolAdded")).params.alternates[0];
say(`app: session ${session}, COA ${coa}, added ${added.fullDescription} = ${added.poid}`);
app.close();

// ---- 2. the MCP server over stdio ----------------------------------------------------------------

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, STP_URL: url, STP_SESSION: session, STP_TIMEOUT_S: "10" },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => say(`server stderr: ${oneLine(String(d))}`));
const client = new Client({ name: "live-smoke", version: "0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  return { isError: res.isError === true, text, body: res.isError ? undefined : JSON.parse(text) };
};

// ---- 3. no write tools ---------------------------------------------------------------------------

const { tools } = await client.listTools();
const writes = tools.filter((t) => t._meta?.["stp/safety"] !== "read" || t.annotations?.readOnlyHint !== true);
say(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
check(writes.length === 0 && !tools.some((t) => t.name === "AddSymbol"), "no write or destructive tool is listed");

// ---- 4. reads and the live context ---------------------------------------------------------------

const has = await call("HasActiveScenario");
check(has.body?.answer === true, `HasActiveScenario -> ${has.body?.answer} (answered by ${has.body?.provenance.endpoint} at ${has.body?.provenance.answeredAt})`);
const content = await call("GetScenarioContent");
check(
  !content.isError && content.body.answer.includes(added.poid) && content.body.answer.includes("'Live Test COA'"),
  `GetScenarioContent holds the COA and the unit (${content.body?.answer.length} chars)`,
);
const ctx = (await call("live_context")).body;
say(`live_context: counts ${JSON.stringify(ctx.counts)}, lastAdded.symbol ${JSON.stringify(ctx.lastAdded.symbol)}`);
check(ctx.lastAdded.symbol?.poid === added.poid, `"the unit I just added" = lastAdded.symbol = ${ctx.lastAdded.symbol?.summary}`);

// ---- 5. GetPoidObject ----------------------------------------------------------------------------

const obj = await call("GetPoidObject", { poid: ctx.lastAdded.symbol?.poid });
check(obj.body?.answer?.poid === added.poid, `GetPoidObject -> ${oneLine(JSON.stringify(obj.body?.answer))}`);
say(`  provenance: ${oneLine(JSON.stringify(obj.body?.provenance), 400)}`);

// ---- 6. engine restart ---------------------------------------------------------------------------

say(`docker restart ${container} ...`);
const restart = spawn("docker", ["restart", container], { stdio: "ignore" });
const restarted = new Promise((r) => restart.on("exit", r));
let downError;
for (let i = 0; i < 60 && !downError; i++) {
  const r = await call("HasActiveScenario");
  if (r.isError) downError = r.text;
  else await sleep(500);
}
check(Boolean(downError), "a call while the engine is down is an explained error");
say(`  error: ${oneLine(downError ?? "(none)", 400)}`);
await restarted;
say("docker restart returned; waiting for the engine to accept Register again");
let recovered;
const errorsSeen = new Set();
for (let i = 0; i < 90 && !recovered; i++) {
  const r = await call("HasActiveScenario");
  if (r.isError) {
    errorsSeen.add(r.text.split("\n")[0].replace(/\d+(\.\d+)? s/g, "N s"));
    await sleep(2000);
  } else recovered = r;
}
for (const e of errorsSeen) say(`  while starting: ${oneLine(e, 300)}`);
check(Boolean(recovered), `recovered: HasActiveScenario -> ${recovered?.body.answer}${recovered?.body.notes ? ` (${recovered.body.notes[0]})` : ""}`);
const status = (await call("live_status")).body;
say(`live_status: connected ${status.connected}, connects ${status.connects}, scenario: ${status.scenario.note}`);
say(`  lastError: ${oneLine(status.lastError?.message ?? "none", 300)}`);

await client.close();
const failed = checks.filter((c) => !c.ok);
say(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
