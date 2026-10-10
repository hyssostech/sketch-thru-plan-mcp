import type { CallToolResult, ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { exclusionReason, type ContractMethod, type ValidationRules } from "stp-mcp-contract-tools";
import type { ActionEntry, ActionLog, Confirmation } from "./actions.js";
import { StpError, type StpConnection } from "./connection.js";
import type { LiveContext } from "./context.js";
import { capAnswer, stripPrologTerm } from "./payload.js";
import {
  V10_ERRORS,
  V10Watch,
  checkPreconditions,
  checkReferences,
  checkRequired,
  checkWriteMode,
  confirmationText,
  kindOfFsType,
  referenceTargets,
  type CheckStep,
  type ContextFacts,
  type Lookup,
  type WriteMode,
} from "./validate.js";

/**
 * A write or destructive call (STP-1065), in the order STP-1064 fixes: dispatchable -> params ->
 * write mode -> the user's confirmation (destructive only) -> context preconditions -> references ->
 * send -> V10. Any failed check refuses the call with the check's name and the fix; every call,
 * refused or sent, goes to the action log; a sent call's result carries the V10 report.
 */

export interface WriteDeps {
  rules: ValidationRules;
  connection: StpConnection;
  context: LiveContext;
  log: ActionLog;
  mode: WriteMode;
  v10TimeoutS: number;
  /** How long a fire-and-forget call with no expected event waits for a refusal (ms). */
  settleMs: number;
  maxAnswerBytes: number;
  validator: (name: string) => JsonSchemaValidator<unknown> | undefined;
  provenance: () => { endpoint: string; session: string | null; answeredAt: string; contract: unknown };
  clientInfo: () => { name: string; version: string } | null;
  /** Whether the MCP client declared the elicitation capability (form mode). */
  canElicit: () => boolean;
  elicit: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

type Json = Record<string, unknown>;

export function createWriteCaller(deps: WriteDeps) {
  const { connection, context, log } = deps;

  const footer = () => {
    const p = deps.provenance();
    return `[STP ${p.endpoint}, session ${p.session ?? "(none yet)"}, at ${p.answeredAt}]`;
  };

  /** What a poid names: the live context first, then the engine (GetPoidObject, a read). */
  const lookup = async (poid: string): Promise<Lookup> => {
    const entity = context.find(poid);
    if (entity) {
      const fsTYPE = typeof entity.data.fsTYPE === "string" ? entity.data.fsTYPE : undefined;
      return { found: true, source: "context", kind: entity.kind, ...(fsTYPE ? { fsTYPE } : {}), summary: entity.summary };
    }
    const deleted = context.deletedBy(poid);
    if (deleted) return { found: false, source: "context", deleted };
    try {
      const { value } = stripPrologTerm(await connection.request("GetPoidObject", { poid }));
      if (value === null || value === undefined || typeof value !== "object") return { found: false, source: "engine" };
      const obj = value as Json;
      const { kind, inferred } = kindOfFsType(obj.fsTYPE);
      const name = [obj.fullDescription, obj.name, obj.Name].find((v) => typeof v === "string" && v !== "") as string | undefined;
      return {
        found: true,
        source: "engine",
        kind,
        ...(typeof obj.fsTYPE === "string" ? { fsTYPE: obj.fsTYPE } : {}),
        ...(name ? { summary: name } : {}),
        ...(inferred ? { inferred } : {}),
      };
    } catch (e) {
      return { found: false, source: "engine", error: (e as Error).message };
    }
  };

  /** Asks the user through MCP elicitation; the model has no way to answer it. */
  const confirm = async (method: string, text: string, params: Json): Promise<Confirmation> => {
    const at = () => new Date().toISOString();
    if (!deps.canElicit()) {
      return {
        status: "unsupported",
        reason: "the MCP client did not declare the elicitation capability, so it cannot ask the user",
        at: at(),
      };
    }
    // Connect first (a failure is reported by the context check), so the live context can name the targets.
    await connection.ensureReady().catch(() => {});
    const p = deps.provenance();
    const targets = referenceTargets(deps.rules.methods[method], params)
      .targets.map((t) => {
        const e = context.find(t.poid);
        return `  ${t.param} = ${t.poid}${e ? `: ${e.summary}` : " (not in the live context)"}`;
      })
      .join("\n");
    const args = JSON.stringify(params);
    const message =
      `Confirm a destructive STP call: ${method}.\n${text}\n` +
      `${targets ? `Objects named:\n${targets}\n` : ""}` +
      `Arguments: ${args.length > 600 ? `${args.slice(0, 600)}... (${args.length} characters)` : args}\n` +
      `STP ${p.endpoint}, session ${p.session ?? "(none)"}. It cannot be undone from here.`;
    let result: ElicitResult;
    try {
      result = await deps.elicit({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: `Run ${method}`, description: "Check to run it; decline or leave unchecked to cancel." },
          },
          required: ["confirm"],
        },
      });
    } catch (e) {
      return { status: "failed", message, reason: `the confirmation request failed: ${(e as Error).message}`, at: at() };
    }
    if (result.action === "accept" && result.content?.confirm === true) return { status: "accepted", message, at: at() };
    if (result.action === "accept") return { status: "declined", message, reason: "the user left 'confirm' unchecked", at: at() };
    if (result.action === "decline") return { status: "declined", message, reason: "the user declined", at: at() };
    return { status: "cancelled", message, reason: "the user cancelled (dismissed the request)", at: at() };
  };

  return async function callWrite(method: ContractMethod, args: Json): Promise<CallToolResult> {
    const name = method.name;
    const safety = method["x-stpSafety"] as "write" | "destructive";
    const steps: CheckStep[] = [];
    const p0 = deps.provenance();
    const base: Omit<ActionEntry, "id" | "status" | "validation"> = {
      at: new Date().toISOString(),
      client: deps.clientInfo(),
      endpoint: p0.endpoint,
      session: p0.session,
      method: name,
      safety,
      params: stripPrologTerm(args).value,
    };
    let confirmation: Confirmation | undefined;
    const refuse = (step: CheckStep): CallToolResult => {
      steps.push(step);
      log.add({ ...base, session: connection.session, status: "refused", validation: steps, ...(confirmation ? { confirmation } : {}) });
      return { isError: true, content: [{ type: "text", text: `${step.detail}\n\n${footer()}` }] };
    };

    // 1. dispatchable
    const excluded = exclusionReason(method);
    if (excluded) return refuse({ check: "dispatchable", passed: false, detail: `${name} is not available: ${excluded}.` });
    const rules = deps.rules.methods[name];
    if (!rules) {
      return refuse({
        check: "dispatchable",
        passed: false,
        detail: `${name} has no entry in the pinned validation rules, so this server cannot check it; it refuses rather than send an unchecked ${safety}.`,
      });
    }
    steps.push({ check: "dispatchable", passed: true, detail: `${name} is dispatched by the engine (${method["x-stpInform"] ? "inform" : "request"})` });

    // A tool this server's mode does not expose is refused before its arguments are read, as an unknown tool is.
    const modeStep = checkWriteMode(name, safety, deps.mode);
    if (!modeStep.passed) return refuse(modeStep);

    // 2. params: the contract schema (enum and C2SIM option values by value), then the params STP silently needs
    const check = deps.validator(name)?.(args);
    if (!check || !check.valid) {
      return refuse({
        check: "params",
        passed: false,
        detail: `Invalid arguments for ${name}: ${check?.errorMessage ?? "no schema"}. Nothing was sent to STP; see the tool's input schema.`,
      });
    }
    const required = checkRequired(name, rules, args);
    if (!required.passed) return refuse(required);
    steps.push(required);

    // 3. write mode (V5)
    steps.push(modeStep);

    // 4. the user's confirmation, per call, for a destructive method
    if (safety === "destructive") {
      confirmation = await confirm(name, confirmationText(rules, args), args);
      if (confirmation.status !== "accepted") {
        const detail =
          confirmation.status === "unsupported"
            ? `STP ${name} is destructive and needs your confirmation, but this MCP client cannot ask you (no elicitation ` +
              `support); run it from your STP client instead. Nothing was sent.`
            : `Refused by the confirmation check: ${confirmation.reason}, so STP ${name} was not sent. A destructive call ` +
              `runs only when the user confirms that call; asking again is up to the user.`;
        return refuse({ check: "confirmation", passed: false, detail });
      }
      steps.push({ check: "confirmation", passed: true, detail: "the user confirmed this call (MCP elicitation)" });
    }

    // 5. context: connected, and the preconditions the rules name
    const facts: ContextFacts = { activeScenario: null };
    try {
      await connection.ensureReady();
      if (rules.preconditions.includes("activeScenario")) {
        const active = await connection.request("HasActiveScenario", {});
        facts.activeScenario = active === true;
        connection.noteScenario(facts.activeScenario);
      }
    } catch (e) {
      if (!(e instanceof StpError) || e.kind !== "refused") {
        return refuse({ check: "context", passed: false, detail: `Refused by the context check: ${(e as Error).message}. Nothing was sent.` });
      }
      facts.problem = e.message;
    }
    const context = checkPreconditions(name, rules, facts);
    if (!context.passed) return refuse(context);
    steps.push(context);

    // 6. references: every poid the rules name must exist, in the live context or the engine
    const refs = referenceTargets(rules, args);
    const lookups = new Map<string, Lookup>();
    for (const t of refs.targets) if (!lookups.has(t.poid)) lookups.set(t.poid, await lookup(t.poid));
    const references = checkReferences(name, refs, lookups);
    if (!references.passed) return refuse(references);
    steps.push(references);

    // 7. send, and watch the event stream (V10)
    const wire = method["x-stpInform"] === true ? "inform" : "request";
    const watch = new V10Watch(name, rules, args, deps.rules, method["x-stpKnownIssues"] ?? []);
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const stop = connection.addEventListener((e) => {
      if (!e.replay && watch.observe({ name: e.name, params: e.params, at: e.at })) settle();
    });
    const started = Date.now();
    let answered = false;
    let answer: unknown;
    let refused: string | undefined;
    let failure: string | undefined;
    try {
      if (wire === "inform") {
        try {
          await connection.inform(name, args);
        } catch (e) {
          stop();
          return refuse({ check: "context", passed: false, detail: `${(e as Error).message} Nothing was sent.` });
        }
      } else {
        try {
          answer = await connection.request(name, args);
          answered = true;
        } catch (e) {
          if (e instanceof StpError && e.kind === "refused") refused = e.message.replace(/^STP refused [^:]+: /, "");
          else failure = (e as Error).message;
        }
      }
      const wait = watch.items.length > 0 ? deps.v10TimeoutS * 1000 : wire === "inform" ? Math.min(deps.settleMs, deps.v10TimeoutS * 1000) : 0;
      if (!watch.settled && wait > 0 && !(refused && watch.items.length === 0)) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
        clearTimeout(timer);
      }
      // A destructive call can take more with it (deleting a unit deletes its tasks): listen a moment
      // longer, so the report names those side effects (alsoSeen).
      if (safety === "destructive" && watch.complete) await new Promise((r) => setTimeout(r, deps.settleMs));
    } finally {
      stop();
    }
    const v10 = watch.report({
      wire,
      answered,
      ...(refused ? { refused } : {}),
      ...(failure ? { failure } : {}),
      waitedMs: Date.now() - started,
      timeoutS: deps.v10TimeoutS,
    });
    if (safety === "destructive" && v10.alsoSeen.length > 0) {
      v10.summary += ` Also seen while it ran: ${v10.alsoSeen.map((e) => (e.poid ? `${e.event} for ${e.poid}` : e.event)).join(", ")}.`;
    }

    const engineAnswer =
      wire === "request"
        ? answered
          ? { success: true, ...capAnswer(stripPrologTerm(answer).value, deps.maxAnswerBytes) }
          : refused
            ? { success: false, error: refused }
            : { success: false, error: failure ?? "no answer" }
        : undefined;
    const entry = log.add({
      ...base,
      session: connection.session,
      status: "sent",
      validation: steps,
      ...(confirmation ? { confirmation } : {}),
      ...(engineAnswer
        ? { engineAnswer: "answer" in engineAnswer ? { success: true, result: engineAnswer.answer } : { success: false, error: engineAnswer.error } }
        : {}),
      v10,
    });
    const body = {
      outcome: v10.outcome,
      summary: v10.summary,
      sent: { method: name, wire, params: base.params },
      ...(engineAnswer ? { engineAnswer } : {}),
      v10,
      validation: steps,
      ...(confirmation ? { confirmation: { status: confirmation.status, at: confirmation.at } } : {}),
      actionLogId: entry.id,
      provenance: deps.provenance(),
    };
    const text = JSON.stringify(body, null, 2);
    if (V10_ERRORS.has(v10.outcome)) return { isError: true, content: [{ type: "text", text: `${v10.summary}\n\n${text}` }] };
    return { content: [{ type: "text", text }] };
  };
}
