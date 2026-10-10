import { describe, expect, it } from "vitest";
import {
  generateTools,
  loadContract,
  loadPin,
  toolFromMethod,
  type Contract,
} from "../src/index.js";

const contract = loadContract();
const result = generateTools(contract);

// Floors, as in STP's tools/check-openrpc-surface.sh: a generator that quietly
// stops producing tools must read as broken, never as a smaller API.
// 2026-10-10, contract 0.9.1: 72 methods -> 70 tools + 2 excluded (transport), 32 events.
const TOOL_FLOOR = 66;
const EVENT_FLOOR = 28;

describe("pinned contract", () => {
  it("matches its pin", () => {
    expect(contract.info.version).toBe(loadPin().version);
  });

  it("is above the extraction floors", () => {
    expect(result.tools.length).toBeGreaterThanOrEqual(TOOL_FLOOR);
    expect(contract["x-stpEvents"]?.length ?? 0).toBeGreaterThanOrEqual(EVENT_FLOOR);
  });
});

describe("generateTools", () => {
  it("accounts for every contract method exactly once", () => {
    const names = [...result.tools.map((t) => t.name), ...result.excluded.map((e) => e.name)];
    expect(names.sort()).toEqual(contract.methods.map((m) => m.name).sort());
  });

  it("never exposes a method the engine does not dispatch", () => {
    const undispatched = contract.methods.filter((m) => m["x-engineDispatch"] === "none").map((m) => m.name);
    const toolNames = new Set(result.tools.map((t) => t.name));
    for (const name of undispatched) expect(toolNames.has(name)).toBe(false);
  });

  it("classifies the pinned contract as the STP-1059 slice did", () => {
    const by = (name: string) => result.tools.find((t) => t.name === name)!;
    expect(by("GetScenarioContent").annotations.readOnlyHint).toBe(true);
    expect(by("DeleteSymbol").annotations.destructiveHint).toBe(true);
    expect(by("ImportCoaContent").annotations.destructiveHint).toBe(true);
    expect(by("AddSymbol")._meta["stp/inform"]).toBe(true);
    expect(by("PushC2SIMContent").annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(by("PullC2SIMInitialization").annotations.openWorldHint).toBe(true);
    expect(by("AddSymbol")._meta["stp/emits"]).toContainEqual({ event: "SymbolAdded", when: "always", to: "session" });
    expect(by("AddTaskOrgUnit")._meta["stp/knownIssues"]).toContain("STP-1091");
    expect(by("DeleteCoa")._meta["stp/knownIssues"]).toBeUndefined(); // STP-1078/1079 fixed
    expect(by("GetScenarioContent")._meta["stp/emits"]).toBeUndefined();
  });

  it("never exposes a transport-layer message", () => {
    const toolNames = new Set(result.tools.map((t) => t.name));
    expect(toolNames.has("Register")).toBe(false);
    expect(toolNames.has("Request")).toBe(false);
  });

  it("emits self-contained input schemas with valid MCP tool names", () => {
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(tool.inputSchema.type).toBe("object");
      const text = JSON.stringify(tool.inputSchema);
      expect(text).not.toContain("#/components/");
      for (const ref of text.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
        expect(tool.inputSchema.$defs, `${tool.name} -> ${ref[1]}`).toHaveProperty(ref[1]);
      }
    }
  });

  it("matches the committed snapshot (regenerate with `vitest -u` when the contract moves)", async () => {
    await expect(JSON.stringify(result, null, 2) + "\n").toMatchFileSnapshot("./__snapshots__/generated-tools.json");
  });
});

describe("toolFromMethod", () => {
  const tiny: Contract = {
    openrpc: "1.2.6",
    info: { title: "t", version: "0" },
    methods: [],
    components: {
      schemas: {
        Outer: { type: "object", properties: { inner: { $ref: "#/components/schemas/Inner" } } },
        Inner: { type: "string" },
      },
    },
  };

  it("closes $defs over nested references and keeps required params", () => {
    const tool = toolFromMethod(
      {
        name: "M",
        description: "d",
        params: [{ name: "o", required: true, description: "the outer", schema: { $ref: "#/components/schemas/Outer" } }],
        "x-stpSafety": "destructive",
      },
      tiny,
    );
    expect(tool.inputSchema.required).toEqual(["o"]);
    expect(tool.inputSchema.properties.o).toEqual({ $ref: "#/$defs/Outer", description: "the outer" });
    expect(Object.keys(tool.inputSchema.$defs ?? {})).toEqual(["Inner", "Outer"]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool._meta["stp/safety"]).toBe("destructive");
  });

  it("refuses a reference to a missing component", () => {
    expect(() =>
      toolFromMethod(
        { name: "M", params: [{ name: "x", schema: { $ref: "#/components/schemas/Nope" } }], "x-stpSafety": "read" },
        tiny,
      ),
    ).toThrow(/missing component schema 'Nope'/);
  });

  it("refuses an unknown safety class", () => {
    expect(() => toolFromMethod({ name: "M", params: [], "x-stpSafety": "maybe" }, tiny)).toThrow(/unknown x-stpSafety/);
  });

  it("refuses an unclassified method", () => {
    expect(() => toolFromMethod({ name: "M", params: [] }, tiny)).toThrow(/no x-stpSafety/);
  });

  it("marks a call that reaches outside STP as open-world, and an inform as events-only", () => {
    const tool = toolFromMethod(
      { name: "M", params: [], "x-stpSafety": "write", "x-stpOpenWorld": true, "x-stpInform": true },
      tiny,
    );
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tool._meta["stp/inform"]).toBe(true);
  });
});
