import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { isError: res.isError === true, text, body: res.isError ? undefined : JSON.parse(text) };
}

describe("knowledge server", () => {
  it("lists only read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_event", "get_method", "list_events", "list_methods"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("lists available methods, hiding the undispatched COA family by default", async () => {
    const { body } = await call("list_methods", {});
    const names = body.methods.map((m: { name: string }) => m.name);
    expect(names).toContain("AddSymbol");
    expect(names).not.toContain("AddCoa");
    expect(body.contract.version).toBe("0.4.0");
  });

  it("explains why an unavailable method is unavailable", async () => {
    const { body } = await call("get_method", { name: "addcoa" });
    expect(body.method.name).toBe("AddCoa");
    expect(body.available).toBe(false);
    expect(body.unavailable_because).toMatch(/No handler/);
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
