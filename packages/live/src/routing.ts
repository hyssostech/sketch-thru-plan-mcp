// STP-1805: the server instructions of stp-live, built per write mode from a small route table.
//
// The core failure these instructions steer against (STP-1476): a model asked to place a symbol picks a tool by
// name and composes a 2525 code from memory. Server instructions are the only guidance reliably in a model's
// context before it chooses a tool, so the routing rule lives here, in MCP-owned text. Tool descriptions come from
// the contract unchanged; wording proposed for them is in docs/proposals/STP-1805-contract-wording.md.
//
// Routing is by kind of input, not by audience (STP-1476 comment 15346): words go to recognition, structured data
// passes through faithfully, a mixed request does both. Nothing here refuses data an integrator sends.
import type { WriteMode } from "./validate.js";

/** One way into the plan, by kind of input. `tools` are contract method names (a test checks they exist). */
export interface SymbolRoute {
  input: "words" | "data" | "lookup";
  tools: readonly string[];
}

/** The routes, all modes. Which tools a mode names is filtered by what that mode lists. */
export const SYMBOL_ROUTES: readonly SymbolRoute[] = [
  { input: "words", tools: ["SendSimulatedSpeechRecognition", "SendPenDown", "SendInk"] },
  {
    input: "data",
    tools: [
      "AddSymbol",
      "ImportPlanDataFromObjectSet",
      "ImportCoaFromObjectSet",
      "ImportPlanData",
      "ImportCoaContent",
      "ImportTaskOrgContent",
    ],
  },
  { input: "lookup", tools: ["SearchSymbol", "GetPoidObject", "GetScenarioContent"] },
];

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

/** The symbol-code rule: the same in every mode, so a read-only answer never invents a code either. */
export const CODE_SOURCE_RULE =
  "Symbol codes (2525/APP-6 SIDCs) come from the user's data or files, or from STP - an existing object, or " +
  "SearchSymbol - never from you: do not compose, complete or 'fix' one from memory. 2525C codes map to 2525D, " +
  "never the reverse: do not write a 2525C code for a symbol STP lists only in 2525D (SearchSymbol gives an empty " +
  "charlieSidc).";

const AUDIENCE_RULE =
  "Answer in the asker's terms: someone planning in STP gets the outcome (what was placed, where, its name and " +
  "poid); someone integrating with STP also gets the methods, params and events involved.";

/**
 * The routing paragraph for the tools a mode lists. In read-only mode nothing creates symbols, so it says only how
 * to answer a code question; in write mode it names both paths, and the imports once they are listed.
 */
export function routingInstructions(mode: WriteMode, listed: ReadonlySet<string>): string {
  const pick = (input: SymbolRoute["input"]) =>
    SYMBOL_ROUTES.find((r) => r.input === input)!.tools.filter((t) => listed.has(t));
  const lookup = pick("lookup");
  const parts = [CODE_SOURCE_RULE];
  if (mode === "off") {
    parts.push(
      `Asked for a symbol's code, look it up (${list(lookup)}) and say where it came from. SearchSymbol lists ` +
        "the symbols STP matches to a typed text, best first, with both codes; its codes are a symbol type's " +
        "codes (with its default affiliation), not a finished symbol.",
    );
  } else {
    const words = pick("words");
    const data = pick("data");
    const imports = data.filter((t) => t !== "AddSymbol");
    parts.push(
      "Route by the input. A symbol described in words (\"a recon platoon at the bridge\", \"objective B around " +
        `the airport\") is for recognition: ${words[0]} with ${words.slice(1).join(" and ")}` +
        " - send the phrase as simulated speech, with SendPenDown and SendInk strokes for where it goes (a point, " +
        "a line or an area outline; RecognizeNow ends the wait) - and STP produces the code and properties. Do " +
        "not use AddSymbol for it.",
      "Structured data that already carries codes (a feed, a file, rows with SIDCs, an STP object set) passes " +
        "through faithfully: AddSymbol with each code exactly as given" +
        (imports.length > 0
          ? `, or an import for STP content (${list(imports)})`
          : " (the imports are listed in destructive mode, STP_DESTRUCTIVE=1)") +
        ". Do not re-recognize or rewrite that data; if the engine does not take it, report the outcome and its " +
        "reason rather than substituting a code of your own.",
      "A request that mixes the two does both: pass the data through, recognize what is described in words, and " +
        "name existing objects by their poid (live_context, GetScenarioContent) - for example, imported units " +
        "given a task described in words.",
      "SearchSymbol shows which symbols STP matches to a text and their codes, to offer candidates or answer " +
        "'what is STP's code for ...'; its codes are a symbol type's " +
        "(with its default affiliation), so to place a described symbol recognize it rather than editing those codes.",
    );
  }
  parts.push(AUDIENCE_RULE);
  return parts.join(" ");
}

/** The whole stp-live instructions for a mode. `listed` is the set of tool names the mode lists. */
export function liveInstructions(mode: WriteMode, listed: ReadonlySet<string>): string {
  const base =
    mode === "off"
      ? "Read-only view of a running Sketch-thru-Plan (STP) engine. The tools ask the engine (each answer names " +
        "the endpoint and time); live_context and the stp-live://context resource hold what the engine reported " +
        "recently, including the last unit added. No tool here changes the plan. Errors explain what failed - " +
        "check live_status when one mentions the connection."
      : "View and change a running Sketch-thru-Plan (STP) engine. The read tools ask the engine; live_context and " +
        "the stp-live://context resource hold what it reported recently, including the last unit added - take poids " +
        "from there. Write tools (readOnlyHint false) change the scenario: each call is checked first (params, an " +
        "active scenario, every poid it names) and refused with the reason when a check fails; once sent, its " +
        "result says whether the engine's events show it done (v10.outcome: done, partial, not_done, other, unknown " +
        "or unverifiable) - read it before telling the user the change was made." +
        (mode === "destructive"
          ? " Destructive tools (destructiveHint true) also need the user's confirmation, which this server asks " +
            "for itself on every call; you cannot confirm for the user."
          : "") +
        " Every write is logged in stp-live://actions.";
  return `${base}\n\n${routingInstructions(mode, listed)}`;
}
