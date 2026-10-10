import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import {
  exclusionReason,
  generateTools,
  loadContract,
  loadPin,
  safetyClass,
  type Contract,
  type ContractPin,
  type GeneratedTool,
} from "stp-mcp-contract-tools";
import type { LiveConfig } from "./config.js";
import { StpConnection, StpError } from "./connection.js";
import { CONTEXT_URI, LiveContext, MAX_ENTITIES, MAX_RECENT_EVENTS, RESOURCE_KINDS, entityUri, type EntityKind } from "./context.js";
import { MAX_ANSWER_BYTES, capAnswer, stripPrologTerm } from "./payload.js";

export interface LiveServerOptions {
  config: LiveConfig;
  contract?: Contract;
  pin?: ContractPin;
  /** Delay that coalesces resource-updated notifications (default 1 s). */
  notifyDebounceMs?: number;
  /** Answer size cap in bytes of JSON (default 200 KB). */
  maxAnswerBytes?: number;
  /** Entity and recent-event caps of the live context. */
  contextCaps?: { entities: number; recentEvents: number };
}

export interface LiveServer {
  mcp: McpServer;
  connection: StpConnection;
  context: LiveContext;
  /** Closes the STP connection and stops pending notifications. */
  close(): Promise<void>;
}

const VERSION = "0.1.0";

/** Methods whose missing `poid` is filled from STP_COA. */
const COA_DEFAULTED = new Set(["GetCoaContent", "GetCoaObjectSet"]);

const PROLOG_TERM_NOTE =
  "PrologTerm fields (the engine's internal term form of each object, STP-1085) were removed; the object-set " +
  "and GetAllObjects answers keep only fsTYPE, poid, timestamps and version. Use the *Content (text) methods " +
  "for the readable content.";

const NO_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const LIVE_STATUS: Tool = {
  name: "live_status",
  title: "STP connection status",
  description:
    "Check the connection to the running Sketch-thru-Plan engine before trusting other answers, or after an " +
    "error: the endpoint (STP_URL), whether it is connected now, the STP session joined and whether that session " +
    "has an active scenario, the last connection error and when it happened, how many engine events arrived, how " +
    "often the server reconnected, and the contract version the tools were generated from. When disconnected, " +
    "calling it makes one connection attempt, so it tells whether the engine is reachable right now. This server " +
    "is read-only: it never changes the plan, the role or the current COA.",
  inputSchema: NO_SCHEMA,
  annotations: READ_ONLY,
  _meta: { "stp/safety": "read" },
};

const LIVE_CONTEXT: Tool = {
  name: "live_context",
  title: "What STP reported recently",
  description:
    "What the running Sketch-thru-Plan engine reported recently, without asking it again: the current COA, role " +
    "and task org (as last announced by CoaSwitched, RoleSwitched and TaskOrgSwitched); lastAdded, the most " +
    "recently added symbol, task, COA, task org and task org unit with poid, time and a one-line summary - use " +
    "lastAdded.symbol for 'the unit I just added'; one-line summaries with poids of up to " +
    `${MAX_ENTITIES} recently seen objects; and the last ${MAX_RECENT_EVENTS} events. It is built from the ` +
    "engine's events since this server joined the session (the join replays existing objects, marked source " +
    "'replay'), so it is a working set, not the whole scenario: use GetScenarioContent or GetCoaContent for the " +
    "complete state and GetPoidObject for one object. Same content as the stp-live://context resource; one " +
    "object's full payload is the resource stp-live://symbol/<poid>, stp-live://task/<poid> or stp-live://coa/<poid>.",
  inputSchema: NO_SCHEMA,
  annotations: READ_ONLY,
  _meta: { "stp/safety": "read" },
};

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Refuse with the reason, never an empty success. */
function refusal(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** The read methods of the contract that the engine dispatches: the only ones this server exposes. */
export function readTools(contract: Contract): GeneratedTool[] {
  const generated = generateTools(contract).tools;
  return contract.methods
    .filter((m) => exclusionReason(m) === null && safetyClass(m) === "read")
    .map((m) => generated.find((t) => t.name === m.name)!)
    .filter((t) => t._meta["stp/safety"] === "read");
}

/** Why an answer is empty, so an empty value never reads as "there is nothing". */
function emptyNote(method: string, value: unknown, nullByDesign: boolean): string | undefined {
  const why = "an unknown poid, or a session with no active scenario (see live_status), answers this way instead of an error";
  if ((value === null || value === undefined) && !nullByDesign) return `The engine answered null: nothing matched - ${why}.`;
  if (Array.isArray(value) && value.length === 0) return `The engine answered an empty list - ${why}.`;
  if (typeof value === "string" && /^object_set\(\[\s*\]\)\s*$/.test(value)) {
    return `The engine answered an empty object_set - ${why}.`;
  }
  if (method === "HasActiveScenario" && value === false) {
    return "false: the joined session holds no scenario, so reads answer empty values. STP_SESSION selects the session.";
  }
  return undefined;
}

export function createLiveServer(options: LiveServerOptions): LiveServer {
  const { config } = options;
  const contract = options.contract ?? loadContract();
  const pin = options.pin ?? loadPin();
  const tools = readTools(contract);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ajv = new AjvJsonSchemaValidator();
  const validators = new Map<string, JsonSchemaValidator<unknown>>(
    tools.map((t) => [t.name, ajv.getValidator(t.inputSchema as JsonSchemaType)]),
  );
  const contractRef = { version: contract.info.version, ref: pin.ref };
  const maxBytes = options.maxAnswerBytes ?? MAX_ANSWER_BYTES;

  const context = new LiveContext(options.contextCaps);
  const connection = new StpConnection({
    url: config.url,
    session: config.session,
    timeoutS: config.timeoutS,
    solvables: (contract["x-stpEvents"] ?? []).map((e) => e.name),
    onEvent: (e) => context.apply(e),
    onReset: () => context.reset(),
  });

  /** Every answer names the engine that answered, the session, the time, and the contract pin. */
  const provenance = () => ({
    endpoint: connection.url,
    session: connection.session,
    answeredAt: new Date().toISOString(),
    contract: contractRef,
  });
  /** An error says which engine it concerns and when, like an answer. */
  const explained = (message: string) => {
    const p = provenance();
    return refusal(`${message}\n\n[STP ${p.endpoint}, session ${p.session ?? "(none yet)"}, at ${p.answeredAt}]`);
  };

  const mcp = new McpServer(
    { name: "stp-mcp-live", version: VERSION },
    {
      capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } },
      instructions:
        "Read-only view of a running Sketch-thru-Plan (STP) engine. The tools ask the engine (each answer names " +
        "the endpoint and time); live_context and the stp-live://context resource hold what the engine reported " +
        "recently, including the last unit added. No tool here changes the plan. Errors explain what failed - " +
        "check live_status when one mentions the connection.",
    },
  );

  const status = () => {
    const s = connection.status();
    return {
      endpoint: s.endpoint,
      connected: s.state === "connected",
      state: s.state,
      session: s.session,
      scenario: s.scenario,
      ...(s.connectedAt ? { connectedAt: s.connectedAt } : {}),
      connects: s.connects,
      lastError: s.lastError ?? null,
      eventCount: s.eventCount,
      timeoutS: connection.timeoutS,
      defaultCoa: config.coa ?? null,
      contract: { ...contractRef, repo: pin.repo, path: pin.path },
      readOnly: true,
    };
  };

  const contextDocument = () => {
    const s = status();
    return {
      endpoint: s.endpoint,
      session: s.session,
      connected: s.connected,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      scenario: s.scenario,
      defaultCoa: s.defaultCoa,
      ...context.snapshot(),
      provenance: provenance(),
    };
  };

  // ---- Tools: the contract's read methods, plus live_status and live_context ---------------------
  // Registered on the protocol layer so the generated JSON Schemas are served unchanged (McpServer's
  // registerTool takes zod shapes). Arguments are validated against those schemas before any call.

  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...(tools as unknown as Tool[]), LIVE_STATUS, LIVE_CONTEXT],
  }));

  const callMethod = async (tool: GeneratedTool, args: Record<string, unknown>): Promise<CallToolResult> => {
    const name = tool.name;
    const check = validators.get(name)!(args);
    if (!check.valid) {
      return explained(`Invalid arguments for ${name}: ${check.errorMessage}. Nothing was sent to STP; see the tool's input schema.`);
    }
    const params: Record<string, unknown> = { ...args };
    const notes: string[] = [];
    const takesPoid = "poid" in tool.inputSchema.properties;
    if (takesPoid && params.poid === undefined) {
      if (COA_DEFAULTED.has(name) && config.coa) {
        params.poid = config.coa;
        notes.push(`No poid was given; used the default COA from STP_COA (${config.coa}).`);
      } else {
        notes.push(
          "No poid was given: the engine then answers for the whole session (every object, or the system_state " +
            "object for GetPoidObject) rather than refusing. Pass a poid to scope the call.",
        );
      }
    }
    const expectEvents = (tool._meta["stp/emits"] ?? []).filter((e) => e.when === "always" && e.to === "caller").map((e) => e.event);

    let result: unknown;
    try {
      result = await connection.request(name, params, expectEvents);
    } catch (e) {
      return explained(e instanceof StpError ? e.message : `STP call ${name} failed: ${(e as Error).message}`);
    }

    const { value, dropped } = stripPrologTerm(result);
    const method = contract.methods.find((m) => m.name === name)!;
    const nullByDesign = (method.result?.schema as { type?: string } | undefined)?.type === "null";
    const empty = emptyNote(name, value, nullByDesign);
    if (empty) notes.push(empty);
    if (name === "JoinScenarioSession") {
      notes.push("The scenario was replayed to this server as events; live_context now reflects it.");
    }
    const { answer, truncated } = capAnswer(value, maxBytes);
    return json({
      answer,
      ...(notes.length > 0 ? { notes } : {}),
      ...(truncated ? { truncated } : {}),
      provenance: {
        ...provenance(),
        ...(params.poid !== args.poid ? { poidFrom: "STP_COA" } : {}),
        ...(dropped > 0 ? { prologTermDropped: dropped, prologTermNote: PROLOG_TERM_NOTE } : {}),
      },
    });
  };

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === LIVE_STATUS.name) {
      let problem: string | undefined;
      try {
        await connection.ensureReady();
      } catch (e) {
        problem = (e as Error).message;
      }
      return json({ ...status(), ...(problem ? { problem } : {}), provenance: provenance() });
    }
    if (name === LIVE_CONTEXT.name) {
      try {
        await connection.ensureReady();
      } catch (e) {
        return explained(
          `${(e as Error).message}\nThe live context cannot be refreshed while STP is unreachable; the ` +
            `stp-live://context resource still shows what was last known (with connected: false).`,
        );
      }
      return json(contextDocument());
    }

    const tool = byName.get(name);
    if (tool) return callMethod(tool, args);

    // Not a tool here: say why, so a write method reads as refused, not as missing.
    const method = contract.methods.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (method) {
      const excluded = exclusionReason(method);
      if (excluded) return refusal(`${method.name} is not available: ${excluded}.`);
      const safety = safetyClass(method);
      if (safety !== "read") {
        return refusal(
          `${method.name} is a ${safety} STP method. This live server is read-only and never exposes it: it ` +
            `cannot change the plan, the role or the current COA. Ask the user to make the change in their STP client.`,
        );
      }
      return refusal(`There is no tool '${name}'; did you mean ${method.name}?`);
    }
    return refusal(
      `There is no tool '${name}'. The tools are the STP read methods (${tools.map((t) => t.name).join(", ")}), ` +
        `live_status and live_context.`,
    );
  });

  // ---- Resources: the live context, and one object of it by poid ----------------------------------

  /** A read connects lazily; when STP is unreachable the document says so (connected: false, lastError). */
  const tryConnect = async () => {
    try {
      await connection.ensureReady();
    } catch {
      // recorded as lastError in the status; the resource reports it
    }
  };

  mcp.registerResource(
    "live-context",
    CONTEXT_URI,
    {
      title: "STP live context",
      description:
        "What the running STP engine reported recently: current COA, role and task org, the last object added " +
        "of each kind, summaries of recently seen objects, and recent events. Subscribe for updates.",
      mimeType: "application/json",
    },
    async (uri) => {
      await tryConnect();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(contextDocument(), null, 2) }] };
    },
  );

  for (const kind of RESOURCE_KINDS) {
    mcp.registerResource(
      `live-${kind}`,
      new ResourceTemplate(`stp-live://${kind}/{poid}`, { list: undefined }),
      {
        title: `STP ${kind} (live)`,
        description:
          `One ${kind} of the live context by poid: the last payload the engine sent for it (PrologTerm removed), ` +
          `its summary, and which event set it when. Only objects in the live context are here; ask the engine ` +
          `with GetPoidObject for any other.`,
        mimeType: "application/json",
      },
      async (uri, variables) => {
        await tryConnect();
        const poid = decodeURIComponent(String(variables.poid));
        const entity = context.get(kind as EntityKind, poid);
        if (!entity) {
          const s = connection.status();
          throw new McpError(
            ErrorCode.InvalidParams,
            `${uri.href}: no ${kind} with poid ${poid} in the live context (${s.state} to ${s.endpoint}` +
              `${s.lastError ? `; last error: ${s.lastError.message}` : ""}). The context holds what the engine ` +
              `reported since this server joined; ask the engine with the GetPoidObject tool.`,
          );
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ ...entity, provenance: provenance() }, null, 2),
            },
          ],
        };
      },
    );
  }

  // ---- Subscriptions: resources/updated, coalesced ------------------------------------------------

  const subscriptions = new Set<string>();
  const dirty = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  const debounceMs = options.notifyDebounceMs ?? 1000;

  mcp.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    const uri = request.params.uri;
    if (!uri.startsWith("stp-live://")) {
      throw new McpError(ErrorCode.InvalidParams, `${uri}: only stp-live:// resources can be subscribed to`);
    }
    subscriptions.add(uri);
    return {};
  });
  mcp.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  const flush = () => {
    flushTimer = undefined;
    for (const uri of dirty) void mcp.server.sendResourceUpdated({ uri }).catch(() => {});
    dirty.clear();
  };
  context.onChange((uris) => {
    for (const uri of uris) if (subscriptions.has(uri)) dirty.add(uri);
    if (dirty.size > 0 && !flushTimer) flushTimer = setTimeout(flush, debounceMs);
  });

  const close = async () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    connection.close();
  };
  mcp.server.onclose = () => void close();

  return { mcp, connection, context, close };
}

export { entityUri, CONTEXT_URI };
