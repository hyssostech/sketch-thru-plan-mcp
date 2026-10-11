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
  loadValidations,
  loadValidationsPin,
  safetyClass,
  type Contract,
  type ContractPin,
  type GeneratedTool,
  type ValidationRules,
  type ValidationsPin,
} from "stp-mcp-contract-tools";
import { ACTIONS_URI, ActionLog, MAX_ACTIONS } from "./actions.js";
import { DEFAULT_V10_TIMEOUT_S, type LiveConfig } from "./config.js";
import { StpConnection, StpError } from "./connection.js";
import { CONTEXT_URI, LiveContext, MAX_ENTITIES, MAX_RECENT_EVENTS, RESOURCE_KINDS, entityUri, type EntityKind } from "./context.js";
import { MAX_ANSWER_BYTES, capAnswer, stripPrologTerm } from "./payload.js";
import type { WriteMode } from "./validate.js";
import { createWriteCaller } from "./write.js";

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
  /** The call-validation rules (default: the pinned sketch-thru-plan-validations.json). */
  validations?: ValidationRules;
  validationsPin?: ValidationsPin;
  /** How long a fire-and-forget write with no expected event waits for a refusal (default 1 s). */
  settleMs?: number;
  /** Entries the action log keeps in memory (default 500). */
  actionLogCap?: number;
}

export interface LiveServer {
  mcp: McpServer;
  connection: StpConnection;
  context: LiveContext;
  actions: ActionLog;
  /** off (read-only), write, or destructive (writes and destructive calls). */
  mode: WriteMode;
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

/** How long a fire-and-forget write with no expected event waits for a refusal StpMessage. */
export const SETTLE_MS = 1000;

const LIVE_STATUS: Tool = {
  name: "live_status",
  title: "STP connection status",
  description:
    "Check the connection to the running Sketch-thru-Plan engine before trusting other answers, or after an " +
    "error: the endpoint (STP_URL), whether it is connected now, the STP session joined and whether that session " +
    "has an active scenario, the last connection error and when it happened, how many engine events arrived, how " +
    "often the server reconnected, the contract version the tools were generated from, and writeMode. When " +
    "disconnected, calling it makes one connection attempt, so it tells whether the engine is reachable right now. " +
    "Unless writeMode says otherwise (STP_WRITE=1), this server is read-only: it never changes the plan, the role " +
    "or the current COA.",
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

/** The read methods of the contract that the engine dispatches: the only ones a read-only server exposes. */
export function readTools(contract: Contract): GeneratedTool[] {
  return exposedTools(contract, "off");
}

/** The tools a mode exposes: the dispatched read methods, plus write ones in write mode, plus destructive ones. */
export function exposedTools(contract: Contract, mode: WriteMode): GeneratedTool[] {
  const allowed = new Set(mode === "off" ? ["read"] : mode === "write" ? ["read", "write"] : ["read", "write", "destructive"]);
  const generated = generateTools(contract).tools;
  return contract.methods
    .filter((m) => exclusionReason(m) === null && allowed.has(safetyClass(m)))
    .map((m) => generated.find((t) => t.name === m.name)!)
    .filter((t) => allowed.has(t._meta["stp/safety"]));
}

/** The server's write mode from its configuration: off unless STP_WRITE=1. */
export function writeModeOf(config: LiveConfig): WriteMode {
  return config.write ? (config.destructive ? "destructive" : "write") : "off";
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
  const rules = options.validations ?? loadValidations();
  const rulesPin = options.validationsPin ?? loadValidationsPin();
  const mode = writeModeOf(config);
  const tools = exposedTools(contract, mode);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ajv = new AjvJsonSchemaValidator();
  // Every dispatched method gets a validator, so a write called by name is checked like a listed one.
  const validators = new Map<string, JsonSchemaValidator<unknown>>(
    generateTools(contract).tools.map((t) => [t.name, ajv.getValidator(t.inputSchema as JsonSchemaType)]),
  );
  const v10TimeoutS = config.v10TimeoutS ?? DEFAULT_V10_TIMEOUT_S;
  const actions = new ActionLog(config.actionLog, options.actionLogCap ?? MAX_ACTIONS);
  const contractRef = { version: contract.info.version, ref: pin.ref };
  const maxBytes = options.maxAnswerBytes ?? MAX_ANSWER_BYTES;

  const context = new LiveContext(options.contextCaps);
  context.writer = mode !== "off";
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

  const instructions =
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
  const mcp = new McpServer(
    { name: "stp-mcp-live", version: VERSION },
    {
      capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } },
      instructions,
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
      validations: { version: rules.version, ref: rulesPin.ref, path: rulesPin.path },
      readOnly: mode === "off",
      writeMode: mode,
      v10TimeoutS,
      actionLog: { entries: actions.list().length, file: actions.file ?? null },
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

  const callWrite = createWriteCaller({
    rules,
    connection,
    context,
    log: actions,
    mode,
    v10TimeoutS,
    settleMs: options.settleMs ?? SETTLE_MS,
    maxAnswerBytes: maxBytes,
    validator: (name) => validators.get(name),
    provenance,
    clientInfo: () => {
      const c = mcp.server.getClientVersion();
      return c ? { name: c.name, version: c.version } : null;
    },
    canElicit: () => Boolean(mcp.server.getClientCapabilities()?.elicitation?.form),
    elicit: (params) => mcp.server.elicitInput(params),
  });

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
    if (tool && tool._meta["stp/safety"] === "read") return callMethod(tool, args);

    // A write or destructive method, listed or not: the write path checks it (refusing it when this
    // server's mode does not expose it) and logs it either way.
    const method = contract.methods.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (method) {
      const excluded = exclusionReason(method);
      if (excluded) return refusal(`${method.name} is not available: ${excluded}.`);
      if (method.name === name && safetyClass(method) !== "read") return callWrite(method, args);
      return refusal(`There is no tool '${name}'; did you mean ${method.name}?`);
    }
    return refusal(
      `There is no tool '${name}'. The tools are the STP ${mode === "off" ? "read " : ""}methods (${tools.map((t) => t.name).join(", ")}), ` +
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

  mcp.registerResource(
    "live-actions",
    ACTIONS_URI,
    {
      title: "STP action log",
      description:
        "Every write or destructive call this server was asked to make, newest first, refused ones included: when, " +
        "which MCP client, the method and arguments, each validation step, the user's confirmation, the engine's " +
        "answer and the V10 report (what the event stream showed). Subscribe for updates.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ writeMode: mode, ...actions.document(), provenance: provenance() }, null, 2),
        },
      ],
    }),
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
  const markDirty = (uris: string[]) => {
    for (const uri of uris) if (subscriptions.has(uri)) dirty.add(uri);
    if (dirty.size > 0 && !flushTimer) flushTimer = setTimeout(flush, debounceMs);
  };
  context.onChange(markDirty);
  actions.onChange(() => markDirty([ACTIONS_URI]));

  const close = async () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    connection.close();
  };
  mcp.server.onclose = () => void close();

  return { mcp, connection, context, actions, mode, close };
}

export { entityUri, CONTEXT_URI, ACTIONS_URI };
