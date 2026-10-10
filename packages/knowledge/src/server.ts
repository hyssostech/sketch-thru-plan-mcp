import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  exclusionReason,
  generateTools,
  loadContract,
  loadPin,
  safetyClass,
  type Contract,
  type ContractPin,
} from "stp-mcp-contract-tools";

export interface KnowledgeServerOptions {
  contract?: Contract;
  pin?: ContractPin;
}

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
  const source = { version: contract.info.version, repo: pin.repo, path: pin.path, ref: pin.ref };

  const server = new McpServer({ name: "stp-mcp-knowledge", version: "0.1.0" });

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
      return json({ contract: source, count: methods.length, methods });
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
      const reason = exclusionReason(method);
      const tool = generated.tools.find((t) => t.name === method.name);
      return json({
        contract: source,
        method,
        safety: safetyClass(method),
        available: reason === null,
        ...(reason === null ? {} : { unavailable_because: reason }),
        ...(tool ? { input_schema: tool.inputSchema } : {}),
      });
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
      return json({ contract: source, count: list.length, events: list });
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
      return json({ contract: source, event });
    },
  );

  return server;
}
