import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadContract } from "stp-mcp-contract-tools";
import { loadDocsPin } from "../src/docs.js";
import { createKnowledgeServer } from "../src/server.js";

const client = new Client({ name: "test", version: "0" });

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKnowledgeServer().connect(serverSide);
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string; uri?: string; mimeType?: string }[];
  const text = content[0].text!;
  return { isError: res.isError === true, text, body: res.isError ? undefined : JSON.parse(text), content };
}

describe("knowledge server", () => {
  it("lists only read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_event",
      "get_method",
      "list_events",
      "list_methods",
      "search_docs",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("lists available methods, hiding the transport layer by default", async () => {
    const { body } = await call("list_methods", {});
    const names = body.methods.map((m: { name: string }) => m.name);
    expect(names).toContain("AddSymbol");
    expect(names).toContain("AddCoa");
    expect(names).not.toContain("Register");
    const addSymbol = body.methods.find((m: { name: string }) => m.name === "AddSymbol");
    expect(addSymbol).toMatchObject({ safety: "write", returns: "events only" });
    expect(body.contract.version).toBe("0.9.0");
    expect(body.docs.repo).toBe("hyssostech/stp-docs");
    expect(body.docs.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("explains why an unavailable method is unavailable", async () => {
    const { body } = await call("get_method", { name: "register" });
    expect(body.method.name).toBe("Register");
    expect(body.available).toBe(false);
    expect(body.unavailable_because).toMatch(/transport-layer/);
  });

  it("says which events follow a call and which filed defects affect it", async () => {
    const { body } = await call("get_method", { name: "DeleteCoa" });
    expect(body.emits).toContainEqual({ event: "CoaDeleted", when: "always", to: "session" });
    expect(body.known_issues).toBeUndefined(); // STP-1078 and STP-1079 are fixed
    const relationship = await call("get_method", { name: "AddTaskOrgRelationship" });
    expect(relationship.body.known_issues).toContain("STP-1089");
    const read = await call("get_method", { name: "GetScenarioContent" });
    expect(read.body.emits).toEqual([]);
    expect(read.body.known_issues).toBeUndefined();
  });

  it("shows a captured example and the engine's edge cases (contract 0.9.0)", async () => {
    const { body } = await call("get_method", { name: "SetCurrentCoa" });
    const example = body.method.examples[0];
    expect(example.params.map((p: { name: string }) => p.name)).toEqual(["poid"]);
    expect(example).toHaveProperty("result");
    const outcomes = body.method["x-stpEdgeCases"].map((c: { outcome: string }) => c.outcome);
    expect(outcomes).toContain("refused");
    const inform = await call("get_method", { name: "AddCoa" });
    expect(inform.body.method.examples[0]).not.toHaveProperty("result");
    expect(inform.body.method.examples[0]["x-stpEventsObserved"][0].event).toBe("CoaAdded");
  });

  it("returns a callable input schema for an available method", async () => {
    const { body } = await call("get_method", { name: "SendPenDown" });
    expect(body.available).toBe(true);
    expect(Object.keys(body.input_schema.properties)).toEqual(["location", "timestamp"]);
  });

  it("refuses an unknown name with close matches instead of an empty success", async () => {
    const res = await call("get_method", { name: "Symbol" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no method named 'Symbol'/);
    expect(res.text).toMatch(/AddSymbol/);
  });

  it("describes events", async () => {
    const { body } = await call("get_event", { name: "SymbolAdded" });
    expect(body.event.name).toBe("SymbolAdded");
  });
});

describe("resources", () => {
  it("lists one resource per docs page and per contract method and event", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    const pin = loadDocsPin();
    const contract = loadContract();
    expect(uris.filter((u) => u.startsWith("stp-docs://")).length).toBe(pin.count);
    expect(uris.filter((u) => u.startsWith("stp-api://method/")).length).toBe(contract.methods.length);
    expect(uris.filter((u) => u.startsWith("stp-api://event/")).length).toBe(contract["x-stpEvents"]!.length);
    const roles = resources.find((r) => r.uri === "stp-docs://guides/roles")!;
    expect(roles.title).toBe("Roles");
    expect(roles.mimeType).toBe("text/markdown");
    expect(resources.find((r) => r.uri === "stp-api://method/AddSymbol")?.mimeType).toBe("application/json");
  });

  it("serves a docs page as Markdown with its provenance", async () => {
    const res = await client.readResource({ uri: "stp-docs://guides/scenarios" });
    const page = res.contents[0] as { text: string; mimeType: string };
    expect(page.mimeType).toBe("text/markdown");
    expect(page.text).toMatch(/^# Scenarios/);
    expect(page.text).toContain("loadNewScenario");
    expect(page.text).toContain(`hyssostech/stp-docs \`docs/guides/scenarios.md\` at ${loadDocsPin().ref.slice(0, 12)}`);
  });

  it("serves contract entries as JSON, explaining unavailable methods", async () => {
    const res = await client.readResource({ uri: "stp-api://method/Request" });
    const body = JSON.parse((res.contents[0] as { text: string }).text);
    expect(body.method.name).toBe("Request");
    expect(body.available).toBe(false);
    expect(body.docs.ref).toBe(loadDocsPin().ref);
    const ev = await client.readResource({ uri: "stp-api://event/SymbolAdded" });
    expect(JSON.parse((ev.contents[0] as { text: string }).text).event.name).toBe("SymbolAdded");
  });

  it("refuses an unknown resource", async () => {
    await expect(client.readResource({ uri: "stp-docs://no/such/page" })).rejects.toThrow(/not found/i);
  });
});

describe("search_docs", () => {
  it("returns ranked passages with heading paths, snippets, provenance and resource links", async () => {
    const { body, content, isError } = await call("search_docs", { query: "how do I load a scenario", k: 4 });
    expect(isError).toBe(false);
    expect(body.docs.ref).toBe(loadDocsPin().ref);
    expect(body.contract.version).toBe("0.9.0");
    expect(body.results.length).toBe(4);
    const top = body.results[0];
    expect(top.uri).toBe("stp-docs://guides/scenarios");
    expect(top.heading_path).toEqual(["Scenarios", "Loading Scenarios"]);
    expect(top.snippet).toMatch(/loadNewScenario/);
    expect(top.score).toBeGreaterThan(0);
    for (let i = 1; i < body.results.length; i++) expect(body.results[i].score).toBeLessThanOrEqual(body.results[i - 1].score);
    const links = content.filter((c) => c.type === "resource_link");
    expect(links.map((l) => l.uri)).toEqual([...new Set(body.results.map((r: { uri: string }) => r.uri))]);
    expect(links[0].mimeType).toBe("text/markdown");
    for (const l of links) expect((await client.readResource({ uri: l.uri! })).contents.length).toBe(1);
  });

  it("finds contract methods and events", async () => {
    const { body } = await call("search_docs", { query: "SymbolAdded", k: 3 });
    expect(body.results[0].uri).toBe("stp-api://event/SymbolAdded");
    expect(body.results[0].kind).toBe("event");
  });

  it("keeps at most two passages per page", async () => {
    const { body } = await call("search_docs", { query: "task org unit relationship", k: 20 });
    const perPage = new Map<string, number>();
    for (const r of body.results) perPage.set(r.uri, (perPage.get(r.uri) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
  });

  it("flags words it does not know and suggests close ones", async () => {
    const { body } = await call("search_docs", { query: "load scenaro" });
    expect(body.unmatched_terms).toEqual(["scenaro"]);
    expect(body.did_you_mean).toContain("scenario");
  });

  it("refuses a query with no match, with an explanation and suggestions", async () => {
    const res = await call("search_docs", { query: "xylophone quuxification" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No passage in the STP docs/);
    expect(res.text).toMatch(/list_methods/);
    expect(res.text).toMatch(/Task Org \/ ORBAT/);
    const typo = await call("search_docs", { query: "scenaro" });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/Did you mean: scenario/);
  });

  it("refuses a query made only of stopwords", async () => {
    const res = await call("search_docs", { query: "how do I?" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no searchable words/);
  });
});
