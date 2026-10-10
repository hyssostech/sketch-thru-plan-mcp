import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  exclusionReason,
  generateTools,
  loadContract,
  loadPin,
  safetyClass,
  type Contract,
  type ContractEvent,
  type ContractMethod,
  type ContractPin,
  type GenerationResult,
} from "stp-mcp-contract-tools";
import { loadDocs, type DocsCorpus } from "./docs.js";
import { chunkPage, contractChunks, eventUri, methodUri, SearchIndex } from "./search.js";

export interface KnowledgeServerOptions {
  contract?: Contract;
  pin?: ContractPin;
  docs?: DocsCorpus;
}

export const MAX_RESULTS = 20;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Refuse with the reason, never an empty success. */
function refusal(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

function matches(query: string | undefined, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(q));
}

function findByName<T extends { name: string }>(items: T[], name: string): T | undefined {
  return items.find((i) => i.name === name) ?? items.find((i) => i.name.toLowerCase() === name.toLowerCase());
}

function suggestions(items: { name: string }[], name: string): string[] {
  const n = name.toLowerCase();
  return items
    .map((i) => i.name)
    .filter((candidate) => {
      const c = candidate.toLowerCase();
      return c.includes(n) || n.includes(c);
    })
    .slice(0, 5);
}

function methodEntry(method: ContractMethod, generated: GenerationResult) {
  const reason = exclusionReason(method);
  const tool = generated.tools.find((t) => t.name === method.name);
  return {
    method,
    safety: safetyClass(method),
    available: reason === null,
    ...(reason === null ? {} : { unavailable_because: reason }),
    ...(tool ? { input_schema: tool.inputSchema } : {}),
  };
}

function unknown(kind: string, name: string, items: { name: string }[], listTool: string): CallToolResult {
  const close = suggestions(items, name);
  const hint = close.length > 0 ? ` Close matches: ${close.join(", ")}.` : "";
  return refusal(`The STP contract has no ${kind} named '${name}'.${hint} Use ${listTool} to see them all.`);
}

export function createKnowledgeServer(options: KnowledgeServerOptions = {}): McpServer {
  const contract = options.contract ?? loadContract();
  const pin = options.pin ?? loadPin();
  const generated = generateTools(contract);
  const events = contract["x-stpEvents"] ?? [];
  const docs = options.docs ?? loadDocs();
  const source = { version: contract.info.version, repo: pin.repo, path: pin.path, ref: pin.ref };
  const docsSource = { repo: docs.pin.repo, path: docs.pin.path, ref: docs.pin.ref, pages: docs.pages.length };
  /** Every answer names the pinned contract and docs it came from. */
  const provenance = { contract: source, docs: docsSource };
  const index = new SearchIndex([...docs.pages.flatMap(chunkPage), ...contractChunks(contract)]);

  const server = new McpServer({ name: "stp-mcp-knowledge", version: "0.1.0" });

  // ---- Resources: one per docs page, contract method and contract event --------------------------

  const shortRef = docs.pin.ref.slice(0, 12);
  for (const page of docs.pages) {
    const uri = page.uri;
    const footer =
      `\n---\n\nSource: ${docs.pin.repo} \`${page.source}\` at ${shortRef} (${docs.pin.license}), ` +
      `pinned by stp-mcp. Contract version ${contract.info.version}.\n`;
    server.registerResource(
      `docs/${page.path}`,
      uri,
      {
        title: page.title,
        description: `STP documentation page: ${page.title} (${page.source}).`,
        mimeType: "text/markdown",
        _meta: { "stp/source": { ...docsSource, file: page.source } },
      },
      async () => ({ contents: [{ uri, mimeType: "text/markdown", text: page.markdown + footer }] }),
    );
  }
  const contractResource = (kind: "method" | "event", entry: ContractMethod | ContractEvent, body: () => unknown) => {
    const uri = kind === "method" ? methodUri(entry.name) : eventUri(entry.name);
    server.registerResource(
      `${kind}/${entry.name}`,
      uri,
      {
        title: `${entry.name} (STP API ${kind})`,
        description: firstSentence(entry.description) || `STP JSON-RPC ${kind} ${entry.name}.`,
        mimeType: "application/json",
        _meta: { "stp/source": source },
      },
      async () => ({
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ ...provenance, ...(body() as object) }, null, 2) }],
      }),
    );
  };
  for (const m of contract.methods) contractResource("method", m, () => methodEntry(m, generated));
  for (const e of events) contractResource("event", e, () => ({ event: e }));

  // ---- Tools --------------------------------------------------------------------------------------

  server.registerTool(
    "list_methods",
    {
      title: "List STP API methods",
      description:
        "List the methods of the Sketch-thru-Plan JSON-RPC API (client -> STP), with a one-line summary, " +
        "safety class (read / write / destructive / unclassified) and whether a running STP engine handles " +
        "the method. Use it to find the right call before reading its details with get_method.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text to match against method names and descriptions."),
        include_unavailable: z
          .boolean()
          .optional()
          .describe("Also list methods the engine does not handle or that only SDK connectors send. Default false."),
      },
      annotations: READ_ONLY,
    },
    async ({ query, include_unavailable }) => {
      const methods = contract.methods
        .filter((m) => include_unavailable || exclusionReason(m) === null)
        .filter((m) => matches(query, m.name, m.description))
        .map((m) => {
          const reason = exclusionReason(m);
          return {
            name: m.name,
            summary: firstSentence(m.description),
            safety: safetyClass(m),
            available: reason === null,
            ...(reason === null ? {} : { unavailable_because: reason }),
          };
        });
      return json({ ...provenance, count: methods.length, methods });
    },
  );

  server.registerTool(
    "get_method",
    {
      title: "Describe an STP API method",
      description:
        "Full contract entry for one Sketch-thru-Plan JSON-RPC method: description, params with their JSON " +
        "schemas, result, safety class, and - if the engine does not handle it - why. Names are case-insensitive.",
      inputSchema: { name: z.string().describe("Method name, e.g. AddSymbol or GetCoaContent.") },
      annotations: READ_ONLY,
    },
    async ({ name }) => {
      const method = findByName(contract.methods, name);
      if (!method) return unknown("method", name, contract.methods, "list_methods");
      return json({ ...provenance, ...methodEntry(method, generated) });
    },
  );

  server.registerTool(
    "list_events",
    {
      title: "List STP events",
      description:
        "List the events a Sketch-thru-Plan engine sends to its clients (STP -> client), such as SymbolAdded, " +
        "with a one-line summary. Use get_event for an event's params.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text to match against event names and descriptions."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      const list = events
        .filter((e) => matches(query, e.name, e.description))
        .map((e) => ({ name: e.name, summary: firstSentence(e.description) }));
      return json({ ...provenance, count: list.length, events: list });
    },
  );

  server.registerTool(
    "get_event",
    {
      title: "Describe an STP event",
      description:
        "Full contract entry for one event the Sketch-thru-Plan engine emits: description and params with " +
        "their JSON schemas. Names are case-insensitive.",
      inputSchema: { name: z.string().describe("Event name, e.g. SymbolAdded.") },
      annotations: READ_ONLY,
    },
    async ({ name }) => {
      const event = findByName(events, name);
      if (!event) return unknown("event", name, events, "list_events");
      return json({ ...provenance, event });
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the STP docs and API contract",
      description:
        "Search the published Sketch-thru-Plan developer documentation (getting started, guides on scenarios, " +
        "sessions, roles, task orgs, tasks, C2SIM, custom commands, troubleshooting and silent failures, plugin " +
        "and reference pages) together with the descriptions of every STP JSON-RPC method and event. Ranking is " +
        "lexical (BM25), so use the words the docs would use: API names such as LoadNewScenario or SymbolAdded, " +
        "or concepts such as 'task org', 'role', 'C2SIM export', 'empty payload'. Returns ranked passages with " +
        "the page title, heading path, a snippet, a score and the resource URI (stp-docs://... for a docs page, " +
        "stp-api://method/<Name> or stp-api://event/<Name> for a contract entry); read that resource for the " +
        "full text before relying on a snippet. A search with no match is an error that says so - the docs do " +
        "not cover everything, so treat no match as 'not documented', not as 'not possible'.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for, in words or API names."),
        k: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .optional()
          .describe(`Number of passages to return (default 5, max ${MAX_RESULTS}); at most two come from one page.`),
      },
      annotations: READ_ONLY,
    },
    async ({ query, k }) => {
      const terms = index.queryTerms(query);
      const pageTitles = docs.pages.map((p) => p.title).join("; ");
      if (terms.length === 0) {
        return refusal(
          `The query '${query}' has no searchable words (only stopwords or punctuation). Ask with content words ` +
            `or API names, e.g. 'load scenario', 'SymbolAdded', 'task org'.`,
        );
      }
      const hits = index.search(query, k ?? 5);
      if (hits.length === 0) {
        const close = index.suggest(query);
        return refusal(
          `No passage in the STP docs (${docs.pin.repo}@${shortRef}, ${docs.pages.length} pages) or the STP ` +
            `contract (version ${contract.info.version}, ${contract.methods.length} methods, ${events.length} events) ` +
            `contains any of: ${terms.join(", ")}. ` +
            (close.length > 0 ? `Did you mean: ${close.join(", ")}? ` : "") +
            `Try other wording or an API name; use list_methods / list_events to browse the contract; the docs ` +
            `pages are: ${pageTitles}. If none of these covers it, the topic is likely not documented.`,
        );
      }
      const results = hits.map((h, i) => ({
        rank: i + 1,
        uri: h.chunk.uri,
        kind: h.chunk.kind,
        title: h.chunk.title,
        heading_path: h.chunk.headingPath,
        snippet: h.snippet,
        score: h.score,
      }));
      const links: ResourceLink[] = [];
      for (const h of hits) {
        if (links.some((l) => l.uri === h.chunk.uri)) continue;
        links.push({
          type: "resource_link",
          uri: h.chunk.uri,
          name: h.chunk.uri.replace(/^[a-z-]+:\/\//, ""),
          title: h.chunk.title,
          mimeType: h.chunk.kind === "doc" ? "text/markdown" : "application/json",
        });
      }
      const unmatched = index.unknownTerms(query);
      const close = unmatched.length > 0 ? index.suggest(query) : [];
      const answer = {
        ...provenance,
        query,
        count: results.length,
        ...(unmatched.length > 0 ? { unmatched_terms: unmatched } : {}),
        ...(close.length > 0 ? { did_you_mean: close } : {}),
        results,
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(answer, null, 2) },
          ...links,
        ],
      };
    },
  );

  return server;
}
