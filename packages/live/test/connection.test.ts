import { afterEach, describe, expect, it } from "vitest";
import { call, connectLive, FakeEngine, freePort, httpServer } from "./fake-engine.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("an unreachable engine", () => {
  it("explains a disconnected engine (nothing listening) and says what to check", async () => {
    const url = `ws://127.0.0.1:${await freePort()}`;
    const { client, close } = await connectLive({ url });
    cleanups.push(close);
    const res = await call(client, "HasActiveScenario");
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`cannot reach STP at ${url}: ECONNREFUSED`);
    expect(res.text).toMatch(/is the engine running and is STP_URL right\?/);
    expect(res.text).toMatch(/\[STP ws:\/\/127\.0\.0\.1:\d+, session \(none yet\), at \d{4}-/);

    const status = await call(client, "live_status");
    expect(status.isError).toBe(false);
    expect(status.body).toMatchObject({ connected: false, endpoint: url });
    expect(status.body.lastError.message).toMatch(/ECONNREFUSED/);
    expect(status.body.problem).toMatch(/cannot reach STP/);

    const ctx = await call(client, "live_context");
    expect(ctx.isError).toBe(true);
    expect(ctx.text).toMatch(/cannot reach STP .* stp-live:\/\/context resource still shows/s);
  });

  it("explains a wrong port: something answers there, but not the STP bridge", async () => {
    const { server, port } = await httpServer();
    cleanups.push(() => void server.close());
    const { client, close } = await connectLive({ url: `ws://127.0.0.1:${port}` });
    cleanups.push(close);
    const res = await call(client, "GetAllObjects");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/cannot reach STP at ws:\/\/127\.0\.0\.1:\d+: 127\.0\.0\.1:\d+ accepts connections but did not complete a WebSocket handshake/);
    expect(res.text).toMatch(/wrong port\? the engine's default is 9599/);
  });

  it("explains an unresolvable host", async () => {
    const { client, close } = await connectLive({ url: "ws://stp-engine.invalid:9599" });
    cleanups.push(close);
    const res = await call(client, "GetAllObjects");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/cannot reach STP at ws:\/\/stp-engine\.invalid:9599: (ENOTFOUND|EAI_AGAIN) \(the host stp-engine\.invalid does not resolve\)/);
  });

  it("connects once the engine comes up, without a restart of the server", async () => {
    const port = await freePort();
    const { client, close } = await connectLive({ url: `ws://127.0.0.1:${port}` });
    cleanups.push(close);
    expect((await call(client, "HasActiveScenario")).isError).toBe(true);
    const engine = await FakeEngine.start({}, port);
    cleanups.push(() => engine.close());
    const res = await call(client, "HasActiveScenario");
    expect(res.isError).toBe(false);
    expect(res.body.answer).toBe(true);
  });
});

describe("an engine restart", () => {
  it("fails the call in flight with an explanation, then reconnects, re-registers and rejoins", async () => {
    let engine = await FakeEngine.start({ GetAllObjects: { noAnswer: true } });
    const port = engine.port;
    cleanups.push(() => engine.close());
    const { client, live, close } = await connectLive({ url: engine.url, session: "LIVETEST01" });
    cleanups.push(close);
    await call(client, "live_status"); // connected

    const inFlight = call(client, "GetAllObjects");
    await sleep(100);
    await engine.close(); // the engine dies with the call unanswered...
    const res = await inFlight;
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/the STP connection closed \(engine restarted\?\) while waiting for GetAllObjects from ws:\/\/127\.0\.0\.1:\d+/);
    expect(res.text).toMatch(/The next call reconnects - retry it/);
    expect(live.connection.status().state).toBe("disconnected");

    // ...and comes back on the same port.
    engine = await FakeEngine.start({ GetAllObjects: { result: [{ fsTYPE: "system_state", poid: "uuid1" }] } }, port);
    const retry = await call(client, "GetAllObjects");
    expect(retry.isError).toBe(false);
    expect(retry.body.answer).toEqual([{ fsTYPE: "system_state", poid: "uuid1" }]);
    expect(engine.methods()).toEqual(["Register", "JoinScenarioSession", "HasActiveScenario", "GetAllObjects"]);
    expect(engine.received[0].params.sessionId).toBe("LIVETEST01");

    const status = await call(client, "live_status");
    expect(status.body.connects).toBe(2);
    expect(status.body.lastError.message).toMatch(/the STP connection closed \(engine restarted\?\)/);
  });

  it("explains a call made while the engine is still down after the restart", async () => {
    const engine = await FakeEngine.start();
    const { client, close } = await connectLive({ url: engine.url });
    cleanups.push(close);
    await call(client, "live_status");
    await engine.close();
    await sleep(50);
    const res = await call(client, "HasActiveScenario");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/cannot reach STP at .*ECONNREFUSED/);
  });

  it("rebuilds the live context from the replay after reconnecting, keeping the session id", async () => {
    const replayA = { name: "SymbolAdded", params: { alternates: [{ fsTYPE: "unit", poid: "idA", fullDescription: "FRIENDLY INFANTRY COMPANY A" }] } };
    let engine = await FakeEngine.start({ JoinScenarioSession: { result: null, events: [replayA] } });
    const port = engine.port;
    cleanups.push(() => engine.close());
    const { client, close } = await connectLive({ url: engine.url });
    cleanups.push(close);
    expect((await call(client, "live_context")).body.counts.symbols).toBe(1);
    engine.emit("SymbolAdded", { alternates: [{ fsTYPE: "unit", poid: "idGONE", fullDescription: "X" }] });
    await sleep(50);
    expect((await call(client, "live_context")).body.counts.symbols).toBe(2);

    await engine.close();
    await sleep(50); // the client sees the close
    engine = await FakeEngine.start({ JoinScenarioSession: { result: null, events: [replayA] } }, port);
    const ctx = (await call(client, "live_context")).body;
    expect(ctx.entities.symbols.map((s: { poid: string }) => s.poid)).toEqual(["idA"]);
    expect(ctx.session).toBe("FAKE-SESSION");
    expect(engine.received[0].params.sessionId).toBe("FAKE-SESSION"); // the id the engine gave first
  });

  it("explains a connection the engine drops during the handshake", async () => {
    const engine = await FakeEngine.start({ Register: { close: true } });
    cleanups.push(() => engine.close());
    const { client, close } = await connectLive({ url: engine.url });
    cleanups.push(close);
    const res = await call(client, "GetAllObjects");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/the STP connection closed \(engine restarted\?\) while waiting for Register/);
  });

  it("explains an engine that refuses Register", async () => {
    const engine = await FakeEngine.start({ Register: { success: false, result: "Invalid session" } });
    cleanups.push(() => engine.close());
    const { client, close } = await connectLive({ url: engine.url });
    cleanups.push(close);
    const res = await call(client, "GetAllObjects");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("STP refused Register: Invalid session");
  });
});
