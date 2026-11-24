import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadContract } from "stp-mcp-contract-tools";
import { SymbolSearch, symbolIndexUrlFor } from "../src/symbolsearch.js";
import { call, connectLive, FakeEngine } from "./fake-engine.js";

// The conformance cases and the invented index are the SDK's (sketch-thru-plan-sdk-js json-api/symbol-search):
// every SDK ranks alike. Synthetic only; the real index ships with STP and is never committed.
const dir = new URL("./fixtures/symbol-search/", import.meta.url);
const FIXTURE = readFileSync(new URL("fixture-index.json", dir), "utf8");
const CASES = JSON.parse(readFileSync(new URL("cases.json", dir), "utf8")) as {
  cases: { name: string; text: string; maxResults?: number; expectTop?: string[]; expectAll?: string[]; expectSet?: string[]; expectFirst?: Record<string, unknown> }[];
};
const contract = loadContract();

describe("SearchSymbol ranking (ported from the SDK)", () => {
  const search = SymbolSearch.fromIndex(FIXTURE);
  for (const c of CASES.cases) {
    it(c.name, () => {
      const keys = search.search(c.text, c.maxResults).map((r) => r.key);
      if (c.expectTop) expect(keys.slice(0, c.expectTop.length)).toEqual(c.expectTop);
      if (c.expectAll) expect(keys).toEqual(c.expectAll);
      if (c.expectSet) expect([...keys].sort()).toEqual([...c.expectSet].sort());
      if (c.expectFirst) expect(search.search(c.text, c.maxResults)[0]).toMatchObject(c.expectFirst);
    });
  }

  it("derives the index URL from the bridge URL", () => {
    expect(symbolIndexUrlFor("ws://host:9599/session")).toBe("http://host:9599/symbol-index.json");
    expect(symbolIndexUrlFor("wss://host:1")).toBe("https://host:1/symbol-index.json");
    expect(symbolIndexUrlFor("http://host")).toBeUndefined();
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function setup(options: Record<string, unknown>) {
  const engine = await FakeEngine.start({});
  cleanups.push(() => engine.close());
  const { client, close, live } = await connectLive({ url: engine.url }, options);
  cleanups.push(close);
  return { client, engine, live };
}
const served = (body: string, ok = true, status = 200) => async () => ({ ok, status, text: async () => body });

describe("SearchSymbol tool", () => {
  it("takes its definition from the contract entry", async () => {
    const { client } = await setup({ fetchFn: served(FIXTURE) });
    const t = (await client.listTools()).tools.find((x) => x.name === "SearchSymbol")!;
    const m = contract.methods.find((x) => x.name === "SearchSymbol")!;
    expect(t.description).toBe(m.description);
    expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(t.inputSchema.required).toEqual(["text"]);
    expect(Object.keys(t.inputSchema.properties!)).toEqual(m.params!.map((p) => p.name));
    expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it("answers from the index without asking the engine, and caches it", async () => {
    let fetched = 0;
    const urls: string[] = [];
    const { client, engine } = await setup({
      symbolIndexUrl: "http://index.invalid/symbol-index.json",
      fetchFn: async (u: string) => (fetched++, urls.push(u), { ok: true, status: 200, text: async () => FIXTURE }),
    });
    const a = await call(client, "SearchSymbol", { text: "zephyr", maxResults: 2 });
    expect(a.isError).toBe(false);
    expect(a.body.answer.map((r: { key: string }) => r.key)).toEqual(["F100", "F110"]);
    expect(a.body.answer[0]).toMatchObject({ name: "Zephyr", defaultAffiliation: "friend" });
    await call(client, "SearchSymbol", { text: "marble" });
    expect(fetched).toBe(1);
    expect(urls).toEqual(["http://index.invalid/symbol-index.json"]);
    expect(engine.methods()).not.toContain("SearchSymbol"); // x-layer: client
  });

  it("derives the index URL from STP_URL by default", async () => {
    const urls: string[] = [];
    const { client, engine } = await setup({ fetchFn: async (u: string) => (urls.push(u), { ok: true, status: 200, text: async () => FIXTURE }) });
    await call(client, "SearchSymbol", { text: "zephyr" });
    expect(urls[0]).toBe(`${engine.url.replace(/^ws/, "http").replace(/\/+$/, "")}/symbol-index.json`);
  });

  it("answers [] with a note, as a success, for no match or only stop words", async () => {
    const { client } = await setup({ fetchFn: served(FIXTURE) });
    for (const text of ["xylograph", "the brigade", "   "]) {
      const r = await call(client, "SearchSymbol", { text });
      expect(r.isError, text).toBe(false);
      expect(r.body.answer, text).toEqual([]);
      expect(r.body.notes[0]).toMatch(/No symbol matches/);
    }
  });

  it("refuses with the contract's message when the index is unavailable, and retries next call", async () => {
    let up = false;
    const { client } = await setup({
      symbolIndexUrl: "http://index.invalid/symbol-index.json",
      fetchFn: async () => (up ? { ok: true, status: 200, text: async () => FIXTURE } : { ok: false, status: 404, text: async () => JSON.stringify({ error: "symbol index not installed", expected: "C:\\STP\\idx.json" }) }),
    });
    const r = await call(client, "SearchSymbol", { text: "zephyr" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("symbol index not available: http://index.invalid/symbol-index.json (HTTP 404: symbol index not installed (expected at C:\\STP\\idx.json))");
    up = true;
    expect((await call(client, "SearchSymbol", { text: "zephyr" })).isError).toBe(false);
  });

  it.each([
    ["a network failure", async () => { throw new Error("ECONNREFUSED"); }, /^symbol index not available: .* \(ECONNREFUSED/],
    ["a body that is not JSON", served("<html>"), /\(not JSON: /],
    ["the wrong schema", served('{"schema":"other","entries":[]}'), /\(schema is 'other'/],
  ])("refuses on %s", async (_n, fetchFn, pattern) => {
    const { client } = await setup({ symbolIndexUrl: "http://index.invalid/symbol-index.json", fetchFn });
    const r = await call(client, "SearchSymbol", { text: "zephyr" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(pattern);
  });

  it("refuses invalid arguments without searching", async () => {
    let fetched = 0;
    const { client } = await setup({ fetchFn: async () => (fetched++, { ok: true, status: 200, text: async () => FIXTURE }) });
    for (const args of [{}, { text: "x", maxResults: 0 }, { text: "x", extra: 1 }]) {
      const r = await call(client, "SearchSymbol", args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Invalid arguments/);
    }
    expect(fetched).toBe(0);
  });
});
