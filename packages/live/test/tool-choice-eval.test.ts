// Tool-choice and story-coverage evaluation (STP-1805, STP-1808): eval/tool-choice-eval.json.
//
// Deterministic, no model call. A model picks a tool from what is in front of it: the tool list and the tool
// descriptions, and for help, the knowledge server's instructions. Each case is a request from one STP-1476 user
// story or use case; it names the methods that request should use, and the steering facts that must be in that
// text. A fact is a set of case-insensitive regexes that must all match one text. The live tool list and this repo's
// own tool descriptions are read from a real server per mode, through MCP, as a client sees them.
//
// Routing is carried by the contract's descriptions (STP-1808 rulings): no MCP-side routing rules, routing resource
// or description overlay. Facts owned by this repo (owner "mcp") must all hold. Facts owned by the contract (owner
// "contract") may fail: those are gaps, to fix with wording upstream in the contract. PASS_FLOOR is the share of
// cases whose facts all hold; it only goes up - raise it when a re-pin closes a gap, never lower it.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clientLayerTools, generateTools, loadContract, type GeneratedTool } from "stp-mcp-contract-tools";
import { createKnowledgeServer } from "stp-mcp-knowledge";
import { CLIENT_LAYER_METHODS } from "../src/server.js";
import type { WriteMode } from "../src/validate.js";
import { connectLive, FakeEngine } from "./fake-engine.js";

/**
 * Measured 36/36 = 1.0 at contract 0.9.11 with the STP-1808 wording (sketch-thru-plan-sdk-js
 * claude/STP-1808-contract-wording). It was 11/15 = 0.733 before (STP-1805). The floor is the measured score.
 */
const PASS_FLOOR = 1.0;

/** The STP-1476 user stories and use cases. Each needs at least one case; a story is never dropped from here. */
const STORIES = ["1a", "1b", "1c", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "3", "4", "5", "6", "7", "8"];

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
  story: string;
  pair?: string;
  input: "words" | "data" | "mixed" | "lookup" | "command" | "help";
  mode?: Mode;
  server?: "live" | "knowledge";
  audience?: string;
  request: string;
  use: string[];
  avoid: string[];
  facts: string[];
}

const evalSet = JSON.parse(readFileSync(new URL("../eval/tool-choice-eval.json", import.meta.url), "utf8")) as {
  stories: Record<string, string>;
  facts: Record<string, Fact>;
  cases: Case[];
};
const contract = loadContract();
const contractTools = new Map<string, GeneratedTool>(
  [...generateTools(contract).tools, ...clientLayerTools(contract, CLIENT_LAYER_METHODS)].map((t) => [t.name, t]),
);
const MODES: Mode[] = ["off", "write", "destructive"];

interface Surface {
  instructions: string;
  tools: Map<string, string>;
}
const live = new Map<Mode, Surface>();
let knowledge: Surface;
const closers: (() => Promise<void>)[] = [];

const surfaceOf = async (client: Client): Promise<Surface> => {
  const { tools } = await client.listTools();
  return { instructions: client.getInstructions() ?? "", tools: new Map(tools.map((t) => [t.name, t.description ?? ""])) };
};

beforeAll(async () => {
  for (const mode of MODES) {
    const engine = await FakeEngine.start({});
    closers.push(() => engine.close());
    const { client, close } = await connectLive({ url: engine.url, write: mode !== "off", destructive: mode === "destructive" });
    closers.push(close);
    live.set(mode, await surfaceOf(client));
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKnowledgeServer().connect(serverSide);
  const client = new Client({ name: "eval", version: "0" });
  await client.connect(clientSide);
  closers.push(() => client.close());
  knowledge = await surfaceOf(client);
});

afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

/** The text a fact is checked against. A live tool is read in the destructive mode, which lists every tool. */
function targetText(target: string): string {
  if (target === "knowledge-instructions") return knowledge.instructions;
  const [kind, name] = target.split(":");
  if (kind === "live-tool") return live.get("destructive")!.tools.get(name) ?? "";
  if (kind === "knowledge-tool") return knowledge.tools.get(name) ?? "";
  const method = contract.methods.find((m) => m.name === name);
  if (!method) throw new Error(`unknown method in fact target ${target}`);
  if (kind === "tool") return contractTools.get(name)?.description ?? "";
  if (kind === "edgeCases") return JSON.stringify(method["x-stpEdgeCases"] ?? []);
  throw new Error(`unknown fact target ${target}`);
}

const holds = (fact: Fact) => {
  const text = targetText(fact.target);
  return fact.patterns.every((p) => new RegExp(p, "i").test(text));
};
/** The tool a fact's target describes, if any. */
const targetTool = (fact: Fact) => (fact.target.includes(":") ? fact.target.split(":")[1] : undefined);

const modeOf = (c: Case): Mode => c.mode ?? "off";
const surface = (c: Case) => (c.server === "knowledge" ? knowledge : live.get(modeOf(c))!);

describe("tool-choice evaluation", () => {
  it("is a well-formed set of cases; cases that share a pair differ in input or audience", () => {
    const { cases, facts } = evalSet;
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const pairs = new Map<string, Case[]>();
    for (const c of cases) if (c.pair) pairs.set(c.pair, [...(pairs.get(c.pair) ?? []), c]);
    for (const [pair, members] of pairs) {
      expect(members.length, `${pair}: a pair needs two cases`).toBeGreaterThanOrEqual(2);
      const routes = new Set(members.map((m) => `${m.input}/${m.audience ?? ""}`));
      expect(routes.size, `${pair}: paired cases must differ in their input or audience`).toBeGreaterThanOrEqual(2);
    }
    for (const c of cases) {
      expect(evalSet.stories[c.story], `${c.id}: unknown story ${c.story}`).toBeDefined();
      expect(c.use.length, `${c.id}: names no method`).toBeGreaterThan(0);
      expect(c.facts.length, `${c.id}: has no steering fact`).toBeGreaterThan(0);
      for (const f of c.facts) expect(facts[f], `${c.id}: unknown fact ${f}`).toBeDefined();
      for (const t of c.avoid) expect(c.use, `${c.id}: ${t} both used and avoided`).not.toContain(t);
    }
    for (const [id, f] of Object.entries(facts)) {
      if (f.owner === "contract") expect(f.target, `${id}: a contract fact targets a contract text`).toMatch(/^(tool|edgeCases):/);
      else expect(f.target, `${id}: an mcp fact targets this repo's text`).toMatch(/^(live-tool|knowledge-tool):|^knowledge-instructions$/);
      for (const p of f.patterns) expect(() => new RegExp(p, "i"), `${id}: bad pattern ${p}`).not.toThrow();
    }
  });

  it("covers every STP-1476 user story and use case with at least one case", () => {
    expect(Object.keys(evalSet.stories).sort()).toEqual([...STORIES].sort());
    const covered = new Set(evalSet.cases.map((c) => c.story));
    for (const s of STORIES) expect(covered.has(s), `story ${s} (${evalSet.stories[s]}) has no case`).toBe(true);
  });

  it("covers words, data, mixed and command input, lookups, and both help audiences", () => {
    const inputs = new Set(evalSet.cases.map((c) => c.input));
    for (const i of ["words", "data", "mixed", "lookup", "command", "help"]) expect(inputs.has(i as Case["input"]), i).toBe(true);
    const audiences = new Set(evalSet.cases.filter((c) => c.server === "knowledge").map((c) => c.audience));
    expect([...audiences].sort()).toEqual(["end-user", "integrator"]);
  });

  it("uses and avoids only tools that exist, and uses only tools the case's server and mode list", () => {
    const known = (t: string) => contractTools.has(t) || live.get("destructive")!.tools.has(t) || knowledge.tools.has(t);
    for (const c of evalSet.cases) {
      for (const t of [...c.use, ...c.avoid]) expect(known(t), `${c.id}: ${t} is no tool`).toBe(true);
      for (const t of c.use) expect(surface(c).tools.has(t), `${c.id}: ${t} is not listed in ${c.server ?? `mode ${modeOf(c)}`}`).toBe(true);
    }
  });

  it("steers to every method a case uses: a fact on its description, or a steering text that names it", () => {
    for (const c of evalSet.cases) {
      const facts = c.facts.map((id) => evalSet.facts[id]);
      for (const t of c.use) {
        const steered = facts.some(
          (f) => targetTool(f) === t || (f.target !== "knowledge-instructions" && new RegExp(`\\b${t}\\b`).test(targetText(f.target))),
        );
        expect(steered, `${c.id}: no fact of the case steers to ${t}`).toBe(true);
      }
    }
  });

  it("holds every fact this repo owns", () => {
    for (const c of evalSet.cases) {
      for (const id of c.facts) {
        const f = evalSet.facts[id];
        if (f.owner === "mcp") expect(holds(f), `${c.id}: ${id} - ${f.claim}`).toBe(true);
      }
    }
  });

  it(`keeps the share of cases whose steering facts all hold at or above ${PASS_FLOOR}`, () => {
    const lines: string[] = [];
    let passed = 0;
    for (const c of evalSet.cases) {
      const missing = c.facts.filter((id) => !holds(evalSet.facts[id]));
      if (missing.length === 0) passed++;
      else
        lines.push(
          `  GAP   ${c.id} (story ${c.story}, ${c.input}): ${missing
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
