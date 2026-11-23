// Tool-choice steering evaluation (STP-1805): eval/tool-choice-eval.json.
//
// Deterministic, no model call. A model picks a tool from what is in front of it before the call: the server
// instructions (always) and the tool descriptions (once loaded). Each case names the tools its request should reach
// and the steering facts that must be in that text; a fact is a set of case-insensitive regexes that must all
// match one text. The live instructions are read from a real server per mode, through MCP, as a client sees them.
//
// Facts owned by this repo (owner "mcp") must all hold. Facts owned by the contract (owner "contract") may fail:
// those are gaps, each with a proposal in docs/proposals/STP-1805-contract-wording.md. PASS_FLOOR is the share of
// cases whose facts all hold; it only goes up - raise it when a re-pin adopts a proposal, never lower it.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clientLayerTools, generateTools, loadContract, type GeneratedTool } from "stp-mcp-contract-tools";
import { createKnowledgeServer } from "stp-mcp-knowledge";
import { CLIENT_LAYER_METHODS } from "../src/server.js";
import { SYMBOL_ROUTES } from "../src/routing.js";
import type { WriteMode } from "../src/validate.js";
import { connectLive, FakeEngine } from "./fake-engine.js";

/**
 * Measured 11/15 = 0.733 at contract 0.9.11 (STP-1805): every MCP-owned fact holds; the 4 cases short are the
 * contract gaps (AddSymbol, SendSimulatedSpeechRecognition and SearchSymbol wording) proposed upstream. The floor
 * is the measured score: a new case may start as a gap only if the floor still holds.
 */
const PASS_FLOOR = 0.73;

type Mode = WriteMode;
interface Fact {
  owner: "mcp" | "contract";
  target: string;
  claim: string;
  patterns: string[];
  proposal?: string;
}
interface Case {
  id: string;
  pair: string;
  input: "words" | "data" | "mixed" | "lookup" | "help";
  mode?: Mode;
  server?: "live" | "knowledge";
  audience?: string;
  request: string;
  use: string[];
  avoid: string[];
  facts: string[];
}

const evalSet = JSON.parse(readFileSync(new URL("../eval/tool-choice-eval.json", import.meta.url), "utf8")) as {
  facts: Record<string, Fact>;
  cases: Case[];
};
const contract = loadContract();
const contractTools = new Map<string, GeneratedTool>(
  [...generateTools(contract).tools, ...clientLayerTools(contract, CLIENT_LAYER_METHODS)].map((t) => [t.name, t]),
);
const MODES: Mode[] = ["off", "write", "destructive"];

const live = new Map<Mode, { instructions: string; tools: Set<string> }>();
let knowledge: { instructions: string; tools: Set<string> };
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => {
  for (const mode of MODES) {
    const engine = await FakeEngine.start({});
    closers.push(() => engine.close());
    const { client, close } = await connectLive({ url: engine.url, write: mode !== "off", destructive: mode === "destructive" });
    closers.push(close);
    const { tools } = await client.listTools();
    live.set(mode, { instructions: client.getInstructions() ?? "", tools: new Set(tools.map((t) => t.name)) });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKnowledgeServer().connect(serverSide);
  const client = new Client({ name: "eval", version: "0" });
  await client.connect(clientSide);
  closers.push(() => client.close());
  const { tools } = await client.listTools();
  knowledge = { instructions: client.getInstructions() ?? "", tools: new Set(tools.map((t) => t.name)) };
});

afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

/** The text a fact is checked against, for a case's mode. */
function targetText(target: string, mode: Mode): string {
  if (target === "live-instructions") return live.get(mode)!.instructions;
  if (target === "knowledge-instructions") return knowledge.instructions;
  const [kind, name] = target.split(":");
  const method = contract.methods.find((m) => m.name === name);
  if (!method) throw new Error(`unknown method in fact target ${target}`);
  if (kind === "tool") return contractTools.get(name)?.description ?? "";
  if (kind === "edgeCases") return JSON.stringify(method["x-stpEdgeCases"] ?? []);
  throw new Error(`unknown fact target ${target}`);
}

const holds = (fact: Fact, mode: Mode) => {
  const text = targetText(fact.target, mode);
  return fact.patterns.every((p) => new RegExp(p, "i").test(text));
};

const modeOf = (c: Case): Mode => c.mode ?? "off";
const surface = (c: Case) => (c.server === "knowledge" ? knowledge : live.get(modeOf(c))!);

describe("tool-choice evaluation", () => {
  it("is a well-formed set of paired cases", () => {
    const { cases, facts } = evalSet;
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const pairs = new Map<string, Case[]>();
    for (const c of cases) pairs.set(c.pair, [...(pairs.get(c.pair) ?? []), c]);
    for (const [pair, members] of pairs) {
      expect(members.length, `${pair}: a pair needs two cases`).toBeGreaterThanOrEqual(2);
      const routes = new Set(members.map((m) => `${m.input}/${m.audience ?? ""}`));
      expect(routes.size, `${pair}: paired cases must differ in their input or audience`).toBeGreaterThanOrEqual(2);
    }
    for (const c of cases) {
      for (const f of c.facts) expect(facts[f], `${c.id}: unknown fact ${f}`).toBeDefined();
      for (const t of c.avoid) expect(c.use, `${c.id}: ${t} both used and avoided`).not.toContain(t);
    }
    for (const [id, f] of Object.entries(facts)) {
      if (f.owner === "contract") expect(f.target, `${id}: a contract fact targets a contract text`).toMatch(/^(tool|edgeCases):/);
      for (const p of f.patterns) expect(() => new RegExp(p, "i"), `${id}: bad pattern ${p}`).not.toThrow();
    }
  });

  it("covers words, data and mixed input, and both help audiences", () => {
    const inputs = new Set(evalSet.cases.map((c) => c.input));
    for (const i of ["words", "data", "mixed", "lookup", "help"]) expect(inputs.has(i as Case["input"]), i).toBe(true);
    const audiences = new Set(evalSet.cases.map((c) => c.audience).filter(Boolean));
    expect([...audiences].sort()).toEqual(["end-user", "integrator"]);
  });

  it("routes only to tools the case's mode lists, and the instructions name every one", () => {
    for (const c of evalSet.cases) {
      const s = surface(c);
      for (const t of c.use) {
        expect(s.tools.has(t), `${c.id}: ${t} is not listed in mode ${modeOf(c)}`).toBe(true);
        expect(s.instructions, `${c.id}: the instructions do not name ${t}`).toContain(t);
      }
    }
  });

  it("names in the instructions no tool the mode does not list", () => {
    const routed = new Set(SYMBOL_ROUTES.flatMap((r) => r.tools));
    for (const t of routed) expect(contract.methods.some((m) => m.name === t), `${t}: not a contract method`).toBe(true);
    for (const mode of MODES) {
      const { instructions, tools } = live.get(mode)!;
      for (const t of routed) {
        if (!tools.has(t)) expect(instructions, `mode ${mode} names unlisted ${t}`).not.toMatch(new RegExp(`\\b${t}\\b`));
      }
    }
  });

  it("holds every fact this repo owns, in every case's mode", () => {
    for (const c of evalSet.cases) {
      for (const id of c.facts) {
        const f = evalSet.facts[id];
        if (f.owner === "mcp") expect(holds(f, modeOf(c)), `${c.id}: ${id} - ${f.claim}`).toBe(true);
      }
    }
  });

  it(`keeps the share of cases whose steering facts all hold at or above ${PASS_FLOOR}`, () => {
    const lines: string[] = [];
    let passed = 0;
    for (const c of evalSet.cases) {
      const missing = c.facts.filter((id) => !holds(evalSet.facts[id], modeOf(c)));
      if (missing.length === 0) passed++;
      else
        lines.push(
          `  GAP   ${c.id} (${c.input}): ${missing
            .map((id) => `${id}${evalSet.facts[id].proposal ? ` [proposal: ${evalSet.facts[id].proposal}]` : ""}`)
            .join(", ")}`,
        );
    }
    const share = passed / evalSet.cases.length;
    console.log(
      [`tool-choice eval: ${passed}/${evalSet.cases.length} = ${share.toFixed(3)} cases fully steered (floor ${PASS_FLOOR})`, ...lines].join("\n"),
    );
    expect(share).toBeGreaterThanOrEqual(PASS_FLOOR);
  });
});
