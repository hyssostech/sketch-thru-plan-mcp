import type { EventMatch, MethodRules, ReferenceKind, ValidationRules, ValueRef } from "stp-mcp-contract-tools";

/**
 * The call-validation evaluator (STP-1064): the shared rule file (sketch-thru-plan-validations.json,
 * pinned in stp-mcp-contract-tools) applied to one call. Pure: it reads the rules, the params and the
 * facts the server gathered (scenario state, poid lookups, events), and never does I/O itself.
 *
 * Rule: refuse the call, or explain the result; never pass a silent failure through. Every check
 * before the call either passes or refuses with the check's name and the fix; after the call, V10
 * (diff intended vs actual) compares what the call asked for with what the event stream showed.
 */

export type CheckName = "dispatchable" | "params" | "writeMode" | "confirmation" | "context" | "references";

/** One pre-call check, passed or failed, with what it found. */
export interface CheckStep {
  check: CheckName;
  passed: boolean;
  detail: string;
}

const pass = (check: CheckName, detail: string): CheckStep => ({ check, passed: true, detail });
const fail = (check: CheckName, detail: string): CheckStep => ({ check, passed: false, detail });

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;

// ---- paths -----------------------------------------------------------------------------------------

/** The value at a dotted path; numeric segments index arrays, `length` is an array's length. */
export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) cur = seg === "length" ? cur.length : /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    else if (isObject(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** Every concrete path and value a path with `*` segments reaches (absent values left out). */
export function expandPath(value: unknown, path: string): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  const walk = (cur: unknown, segs: string[], done: string[]) => {
    if (segs.length === 0) {
      if (!absent(cur)) out.push({ path: done.join("."), value: cur });
      return;
    }
    const [seg, ...rest] = segs;
    if (seg === "*") {
      if (Array.isArray(cur)) cur.forEach((item, i) => walk(item, rest, [...done, String(i)]));
      return;
    }
    walk(getPath(cur, seg), rest, [...done, seg]);
  };
  walk(value, path.split("."), []);
  return out;
}

/** Equality as the rules define it: strings without regard to case, anything else by value. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

// ---- before the call -------------------------------------------------------------------------------

export type WriteMode = "off" | "write" | "destructive";

/** V5: a write needs the server's write mode; a destructive call, its destructive mode too. */
export function checkWriteMode(method: string, safety: "write" | "destructive", mode: WriteMode): CheckStep {
  if (safety === "write" && mode !== "off") return pass("writeMode", `write mode is on (${mode}); ${method} is a write`);
  if (safety === "destructive" && mode === "destructive") {
    return pass("writeMode", `destructive mode is on; ${method} is destructive and needs the user's confirmation`);
  }
  if (mode === "off") {
    return fail(
      "writeMode",
      `${method} is a ${safety} STP method. This live server is read-only and never exposes it: it cannot change ` +
        `the plan, the role or the current COA. Ask the user to make the change in their STP client (or to start ` +
        `this server with STP_WRITE=1${safety === "destructive" ? " and STP_DESTRUCTIVE=1" : ""}).`,
    );
  }
  return fail(
    "writeMode",
    `${method} is a destructive STP method. This server's write mode allows writes but not destructive calls ` +
      `(STP_DESTRUCTIVE is not set), so it never exposes it. Ask the user to make the change in their STP client.`,
  );
}

/** The params the engine silently ignores a call without (the rule file's `required`). */
export function checkRequired(method: string, rules: MethodRules, params: Json): CheckStep {
  const missing = (rules.required ?? []).filter((p) => absent(getPath(params, p)));
  if (missing.length === 0) return pass("params", "the arguments match the contract schema and carry every required param");
  return fail(
    "params",
    `Refused by the params check: ${method} needs ${missing.join(" and ")}. Without ${missing.length === 1 ? "it" : "them"} ` +
      `STP ignores the call and says nothing, so it would look done when nothing happened. Nothing was sent; pass ` +
      `${missing.join(" and ")} (see the tool's input schema).`,
  );
}

/** What the server knows of the session before a call. */
export interface ContextFacts {
  /** HasActiveScenario, asked just before the call; null when it could not be asked. */
  activeScenario: boolean | null;
  /** Why activeScenario is null. */
  problem?: string;
}

export function checkPreconditions(method: string, rules: MethodRules, facts: ContextFacts): CheckStep {
  if (!rules.preconditions.includes("activeScenario")) {
    return pass("context", `connected; ${method} needs no active scenario`);
  }
  if (facts.activeScenario === true) return pass("context", "connected, and the session has an active scenario");
  if (facts.activeScenario === null) {
    return fail(
      "context",
      `Refused by the context check: could not tell whether the session has an active scenario (${facts.problem ?? "no answer"}). ` +
        `Nothing was sent; check live_status and retry.`,
    );
  }
  return fail(
    "context",
    `Refused by the context check: the session has no active scenario. STP would accept ${method} anyway and create ` +
      `objects that belong to no scenario (HasActiveScenario stays false), so nothing was sent. Fix: have the user ` +
      `create or load a scenario in their STP client (or call CreateNewScenario / LoadNewScenario), then retry.`,
  );
}

/** The kind of an object the engine or the live context knows. */
export type ObjectKind = "symbol" | "task" | "coa" | "taskOrg" | "taskOrgUnit" | "taskOrgRelationship" | "scenario" | "systemState" | "unknown";

const FS_TYPES: Record<string, ObjectKind> = {
  task: "task",
  coa: "coa",
  task_org: "taskOrg",
  task_org_unit: "taskOrgUnit",
  task_org_relationship: "taskOrgRelationship",
  planning_scenario: "scenario",
  system_state: "systemState",
  unit: "symbol",
  tg: "symbol",
  equipment: "symbol",
};

/** The kind an fsTYPE names; `inferred` says when that is a guess (an fsTYPE this code does not know). */
export function kindOfFsType(fsTYPE: unknown): { kind: ObjectKind; inferred?: string } {
  if (typeof fsTYPE !== "string" || fsTYPE === "") return { kind: "unknown", inferred: "the object carries no fsTYPE" };
  const known = FS_TYPES[fsTYPE];
  if (known) return { kind: known };
  return { kind: "symbol", inferred: `kind inferred: fsTYPE '${fsTYPE}' is not a known object type, so it is taken to be a symbol` };
}

/** What a poid names, from the live context or the engine (GetPoidObject). */
export type Lookup =
  | { found: true; source: "context" | "engine"; kind: ObjectKind; fsTYPE?: string; summary?: string; inferred?: string }
  | { found: false; source: "context" | "engine"; deleted?: { event: string; at: string }; error?: string };

export interface ReferenceTarget {
  /** The concrete param path, e.g. task.tgs.1. */
  param: string;
  poid: string;
  kinds: ReferenceKind[];
  required: boolean;
}

/** The poids a call's params name, as the rules list them; required ones that are absent, and non-string values. */
export function referenceTargets(rules: MethodRules, params: Json): { targets: ReferenceTarget[]; missing: string[]; malformed: string[] } {
  const targets: ReferenceTarget[] = [];
  const missing: string[] = [];
  const malformed: string[] = [];
  for (const ref of rules.references ?? []) {
    const kinds = Array.isArray(ref.kind) ? ref.kind : [ref.kind];
    const found = expandPath(params, ref.param);
    if (found.length === 0 && ref.required) missing.push(ref.param);
    for (const { path, value } of found) {
      if (typeof value !== "string" || value.trim() === "") malformed.push(`${path} = ${show(value)}`);
      else targets.push({ param: path, poid: value, kinds, required: ref.required === true });
    }
  }
  return { targets, missing, malformed };
}

const KIND_NAMES: Record<ReferenceKind | ObjectKind, string> = {
  symbol: "symbol",
  unit: "unit",
  task: "task",
  coa: "COA",
  taskOrg: "task org",
  taskOrgUnit: "task org unit",
  taskOrgRelationship: "task org relationship",
  any: "object",
  scenario: "scenario",
  systemState: "system state object",
  unknown: "object of unknown kind",
};
const kindList = (kinds: ReferenceKind[]) => kinds.map((k) => KIND_NAMES[k]).join(" or ");

/** Whether an object of this kind satisfies a reference; null when only an inference says so. */
function kindMatches(found: Extract<Lookup, { found: true }>, wanted: ReferenceKind): boolean {
  if (wanted === "any") return true;
  if (wanted === "unit") return found.kind === "symbol" && (found.fsTYPE === "unit" || found.fsTYPE === undefined);
  return found.kind === wanted;
}

/**
 * Every referenced poid must name an existing object of the right kind. A stale or invented id is
 * otherwise ignored by the engine (or, for UpdateTask, creates a task: STP-1091), with nothing said.
 */
export function checkReferences(
  method: string,
  refs: { targets: ReferenceTarget[]; missing: string[]; malformed: string[] },
  lookups: Map<string, Lookup>,
): CheckStep {
  const problems: string[] = [];
  const found: string[] = [];
  for (const p of refs.missing) {
    problems.push(`${p} is missing: it names the object ${method} acts on, and without it STP ignores the call and says nothing`);
  }
  for (const m of refs.malformed) problems.push(`${m} is not a poid`);
  for (const t of refs.targets) {
    const lookup = lookups.get(t.poid);
    const want = kindList(t.kinds);
    if (!lookup) {
      problems.push(`${t.param} = ${t.poid} could not be looked up`);
    } else if (!lookup.found) {
      if (lookup.error) {
        problems.push(`${t.param} = ${t.poid} could not be checked: it is not in the live context and GetPoidObject failed (${lookup.error})`);
      } else {
        const why = lookup.deleted
          ? `it was deleted (${lookup.deleted.event} at ${lookup.deleted.at})`
          : "it is not in the live context, and GetPoidObject answers null for it";
        problems.push(`${t.param} = ${t.poid} names no existing ${want}: ${why}`);
      }
    } else if (!t.kinds.some((k) => kindMatches(lookup, k))) {
      problems.push(
        `${t.param} = ${t.poid} names a ${lookup.fsTYPE && lookup.kind === "symbol" ? `${lookup.fsTYPE} symbol` : KIND_NAMES[lookup.kind]}` +
          `${lookup.summary ? ` (${lookup.summary})` : ""}, not a ${want}${lookup.inferred ? ` (${lookup.inferred})` : ""}`,
      );
    } else {
      const notes = [lookup.inferred, t.kinds.includes("unit") && lookup.fsTYPE === undefined ? "kind inferred: a symbol whose fsTYPE was not reported, taken to be a unit" : undefined]
        .filter(Boolean)
        .join("; ");
      found.push(
        `${t.param} = ${t.poid}: ${lookup.fsTYPE && lookup.kind === "symbol" ? lookup.fsTYPE : KIND_NAMES[lookup.kind]}` +
          `${lookup.summary ? ` ${lookup.summary}` : ""} (${lookup.source === "context" ? "live context" : "GetPoidObject"})${notes ? ` - ${notes}` : ""}`,
      );
    }
  }
  if (problems.length === 0) {
    return pass("references", found.length > 0 ? found.join("; ") : `${method} names no poid`);
  }
  return fail(
    "references",
    `Refused by the references check: ${problems.join("; ")}. STP does not check these itself: it would ignore the call ` +
      `(or apply it to the wrong object) and say nothing. Nothing was sent. Fix: take the poid from live_context, the ` +
      `stp-live:// resources or a read (GetCoaContent, GetScenarioContent, GetPoidObject), then retry.`,
  );
}

/** The destructive call's description for the user's confirmation: the rule's text with params filled in. */
export function confirmationText(rules: MethodRules, params: Json): string {
  return (rules.confirm ?? "").replace(/\{([^}]+)\}/g, (_, path: string) => {
    const v = getPath(params, path);
    return absent(v) ? `(no ${path})` : typeof v === "string" ? v : JSON.stringify(v);
  });
}

// ---- after the call: V10 ---------------------------------------------------------------------------

export type V10Outcome = "done" | "partial" | "not_done" | "other" | "unknown" | "unverifiable";

export interface V10Event {
  name: string;
  params: unknown;
  at: Date;
}

/** One alternative of an expected item, with its match values resolved. */
interface ResolvedMatch {
  event: string;
  match: Record<string, unknown>;
}

/** One thing the call should produce: one event, one of several, or one per array item. */
export interface ExpectedItem {
  label: string;
  alternatives: ResolvedMatch[];
}

export interface ObservedEvent {
  event: string;
  poid?: string;
  at: string;
  as: "expected" | "follow-on" | "ack" | "other" | "refusal";
  /** The expected item it satisfied. */
  fulfils?: string;
  message?: string;
}

export interface V10Report {
  outcome: V10Outcome;
  /** One line for the reader; a partial outcome leads with what is missing. */
  summary: string;
  expected: string[];
  observed: ObservedEvent[];
  missing: string[];
  unexpected: { event: string; poid?: string }[];
  /** The engine's refusal (an answer with success:false, or a refusal StpMessage). */
  refusal?: string;
  /** The filed issue that makes the outcome unverifiable. */
  knownIssue?: string;
  /** How many events in the window matched nothing the call expected (another client's work, or a side effect). */
  unrelatedEvents: number;
  /** The first of those, by name and poid: after a destructive call, its side effects (a deleted unit's TaskDeleted). */
  alsoSeen: { event: string; poid?: string }[];
  waitedMs: number;
  timeoutS: number;
}

/** How the call itself ended, from the server. */
export interface CallEnd {
  wire: "inform" | "request";
  /** A request the engine answered with success. */
  answered?: boolean;
  /** A request the engine refused (success:false), with its reason. */
  refused?: string;
  /** A request that got no answer: timeout, closed connection. */
  failure?: string;
  waitedMs: number;
  timeoutS: number;
}

function resolveRef(ref: ValueRef, params: Json, item: unknown): unknown {
  if ("param" in ref) return getPath(params, ref.param);
  if ("item" in ref) return getPath(item, ref.item);
  return ref.value;
}

function resolveMatch(m: EventMatch, params: Json, item?: unknown): ResolvedMatch {
  const match: Record<string, unknown> = {};
  for (const [path, ref] of Object.entries(m.match ?? {})) {
    const v = resolveRef(ref, params, item);
    if (!absent(v)) match[path] = v; // an absent param does not constrain the match
  }
  return { event: m.event, match };
}

const matchLabel = (m: ResolvedMatch) => {
  const conds = Object.entries(m.match).map(([p, v]) => `${p} = ${show(v)}`);
  return conds.length > 0 ? `${m.event} where ${conds.join(" and ")}` : m.event;
};

/** The items a call is expected to produce, per the rule's intent and the call's params. */
export function expectedItems(rules: MethodRules, params: Json): ExpectedItem[] {
  const items: ExpectedItem[] = [];
  for (const exp of rules.intent.expect) {
    const alts: EventMatch[] = exp.anyOf ?? [{ event: exp.event!, match: exp.match }];
    if (!exp.forEach) {
      const resolved = alts.map((a) => resolveMatch(a, params));
      items.push({ label: resolved.map(matchLabel).join(" or "), alternatives: resolved });
      continue;
    }
    const list = getPath(params, exp.forEach);
    if (!Array.isArray(list)) continue;
    list.forEach((item, i) => {
      for (const [path, cond] of Object.entries(exp.where ?? {})) {
        const v = getPath(item, path);
        if (cond.in && !cond.in.some((x) => sameValue(x, v))) return;
        if (cond.notIn && cond.notIn.some((x) => sameValue(x, v))) return;
      }
      const resolved = alts.map((a) => resolveMatch(a, params, item));
      const what = [getPath(item, "fsTYPE"), getPath(item, "poid")].filter((x) => typeof x === "string").join(" ");
      items.push({ label: `${exp.forEach}[${i}]${what ? ` (${what})` : ""}: ${resolved.map(matchLabel).join(" or ")}`, alternatives: resolved });
    });
  }
  return items;
}

function matches(m: ResolvedMatch, e: V10Event): boolean {
  if (m.event !== e.name) return false;
  return Object.entries(m.match).every(([path, want]) => sameValue(getPath(e.params, path), want));
}

/** The poid an event is about: its own poid, or its first alternate's. */
export function eventPoid(params: unknown): string | undefined {
  const direct = getPath(params, "poid") ?? getPath(params, "alternates.0.poid");
  if (typeof direct === "string") return direct;
  for (const key of ["coa", "taskOrg", "toUnit", "toRelationship", "symbol"]) {
    const p = getPath(params, `${key}.poid`);
    if (typeof p === "string") return p;
  }
  return undefined;
}

/**
 * V10, diff intended vs actual: fed every event that arrives after the call is sent, it matches them
 * against the call's expected items, then reports done, partial, not_done, other, unknown or
 * unverifiable. It holds no timer: the server stops feeding it when observe() says the call settled,
 * or when the timeout passes, and then asks for the report.
 */
export class V10Watch {
  readonly items: ExpectedItem[];
  private readonly fulfilled = new Map<number, { event: V10Event; poid?: string }>();
  private readonly seen: { event: V10Event; role: "expected" | "candidate-other" | "ack" | "refusal"; item?: number }[] = [];
  private readonly others: ResolvedMatch[];
  private readonly acks: Set<string>;
  private readonly refusalText: string;
  private unrelated = 0;
  private readonly alsoSeen: { event: string; poid?: string }[] = [];
  private refusal: string | undefined;

  constructor(
    private readonly method: string,
    private readonly rules: MethodRules,
    private readonly params: Json,
    private readonly validations: Pick<ValidationRules, "refusalMessage">,
    /** The method's x-stpKnownIssues today: an `unverifiable` rule applies only while its issue is listed. */
    private readonly knownIssues: string[] = [],
  ) {
    this.items = expectedItems(rules, params);
    this.others = (rules.intent.other ?? []).map((o) => resolveMatch(o, params));
    this.acks = new Set(rules.intent.acks ?? []);
    this.refusalText = validations.refusalMessage.contains.replace("{method}", method);
  }

  /** True once every expected item arrived; false while some are missing (or none are expected). */
  get complete(): boolean {
    return this.items.length > 0 && this.fulfilled.size === this.items.length;
  }

  /** Whether waiting longer can change the outcome: false once complete or refused. */
  get settled(): boolean {
    return this.complete || this.refusal !== undefined;
  }

  /** Feeds one event; returns `settled`. */
  observe(event: V10Event): boolean {
    if (event.name === this.validations.refusalMessage.event) {
      const message = getPath(event.params, "message");
      if (typeof message === "string" && message.includes(this.refusalText)) {
        this.refusal ??= message;
        this.seen.push({ event, role: "refusal" });
        return this.settled;
      }
    }
    const idx = this.items.findIndex((item, i) => !this.fulfilled.has(i) && item.alternatives.some((a) => matches(a, event)));
    if (idx !== -1) {
      this.fulfilled.set(idx, { event, poid: eventPoid(event.params) });
      this.seen.push({ event, role: "expected", item: idx });
    } else if (this.others.some((o) => matches(o, event)) || this.items.some((item) => item.alternatives.some((a) => matches(a, event)))) {
      // something else, or a second event for an item already satisfied: decided at report time
      this.seen.push({ event, role: "candidate-other" });
    } else if (this.acks.has(event.name)) {
      this.seen.push({ event, role: "ack" });
    } else {
      this.unrelated++;
      const poid = eventPoid(event.params);
      if (this.alsoSeen.length < MAX_ALSO_SEEN) this.alsoSeen.push({ event: event.name, ...(poid ? { poid } : {}) });
    }
    return this.settled;
  }

  report(end: CallEnd): V10Report {
    const doneLabels = [...this.fulfilled.keys()].sort((a, b) => a - b).map((i) => this.items[i].label);
    const missing = this.items.filter((_, i) => !this.fulfilled.has(i)).map((i) => i.label);
    const donePoids = new Set([...this.fulfilled.values()].map((f) => f.poid).filter(Boolean));
    const observed: ObservedEvent[] = [];
    const unexpected: { event: string; poid?: string }[] = [];
    for (const s of this.seen) {
      const poid = eventPoid(s.event.params);
      const base = { event: s.event.name, ...(poid ? { poid } : {}), at: s.event.at.toISOString() };
      if (s.role === "expected") observed.push({ ...base, as: "expected", fulfils: this.items[s.item!].label });
      else if (s.role === "ack") observed.push({ ...base, as: "ack" });
      else if (s.role === "refusal") observed.push({ ...base, as: "refusal", message: String(getPath(s.event.params, "message")) });
      else if (poid && donePoids.has(poid)) observed.push({ ...base, as: "follow-on" });
      else {
        observed.push({ ...base, as: "other" });
        unexpected.push({ event: s.event.name, ...(poid ? { poid } : {}) });
      }
    }
    const refusal = end.refused ?? this.refusal;
    const issue = this.rules.intent.unverifiable;
    const issueOpen = issue && this.knownIssues.includes(issue.issue) ? issue : undefined;
    const acked = observed.some((o) => o.as === "ack");
    const t = end.timeoutS;
    const done = doneLabels.map((l) => withPoid(l, this.fulfilled, this.items)).join("; ");
    const m = this.method;

    let outcome: V10Outcome;
    let summary: string;
    if (this.items.length === 0) {
      if (refusal) [outcome, summary] = ["not_done", `Not done: STP refused ${m}: ${refusal}`];
      else if (unexpected.length > 0) [outcome, summary] = ["other", `Did something else: ${m} promises no event, but STP sent ${list(unexpected)}.`];
      else if (end.failure) [outcome, summary] = ["unknown", `Unknown outcome: ${end.failure}`];
      else if (end.wire === "request" && end.answered) {
        [outcome, summary] = ["done", `Done: STP answered ${m} with success. The contract promises no event for it, so the answer is the confirmation.`];
      } else {
        [outcome, summary] = [
          "unverifiable",
          `Unverifiable: STP sends no answer to ${m} and the contract promises no event for it, so nothing confirms that ` +
            `the engine applied it${acked ? ` (it did acknowledge it: ${ackList(observed)})` : ""}. No refusal arrived within ` +
            `${Math.round(end.waitedMs) / 1000} s. Check the effect with a read if it matters.`,
        ];
      }
    } else if (missing.length === 0) {
      [outcome, summary] = ["done", `Done: ${done}.`];
    } else if (doneLabels.length > 0) {
      [outcome, summary] = [
        "partial",
        `Partly done - missing ${missing.length} of ${this.items.length}: ${missing.join("; ")}. Done: ${done}.` +
          (refusal ? ` STP refused the rest: ${refusal}` : ` The rest did not arrive within ${t} s.`),
      ];
    } else if (refusal) {
      [outcome, summary] = ["not_done", `Not done: STP refused ${m}: ${refusal}`];
    } else if (unexpected.length > 0) {
      [outcome, summary] = ["other", `Did something else: instead of ${missing.join("; ")}, STP sent ${list(unexpected)}.`];
    } else if (issueOpen) {
      [outcome, summary] = [
        "unverifiable",
        `Unverifiable (${issueOpen.issue}): ${issueOpen.reason}, so the event stream cannot confirm ${m}. Expected ` +
          `${missing.join("; ")}; none arrived within ${t} s. Check the effect with a read (e.g. GetPoidObject, GetTaskOrgObjectSet).`,
      ];
    } else if (end.failure) {
      [outcome, summary] = ["unknown", `Unknown outcome: ${end.failure} No expected event arrived either (${missing.join("; ")}).`];
    } else if (end.answered || acked) {
      [outcome, summary] = [
        "not_done",
        `Not done: STP took ${m} (${end.answered ? "answered success" : `acknowledged it: ${ackList(observed)}`}) but ` +
          `${missing.join("; ")} did not arrive within ${t} s.`,
      ];
    } else {
      [outcome, summary] = [
        "unknown",
        `Unknown outcome: nothing at all came back for ${m} within ${t} s - no ${missing.join("; ")}, no refusal. STP ` +
          `ignores a call it cannot apply without saying so, or it may still be busy: check with a read before relying on it.`,
      ];
    }
    return {
      outcome,
      summary,
      expected: this.items.map((i) => i.label),
      observed,
      missing,
      unexpected,
      ...(refusal ? { refusal } : {}),
      ...(outcome === "unverifiable" && issueOpen ? { knownIssue: issueOpen.issue } : {}),
      unrelatedEvents: this.unrelated,
      alsoSeen: [...this.alsoSeen],
      waitedMs: Math.round(end.waitedMs),
      timeoutS: t,
    };
  }
}

function withPoid(label: string, fulfilled: Map<number, { poid?: string }>, items: ExpectedItem[]): string {
  const idx = items.findIndex((i) => i.label === label);
  const poid = fulfilled.get(idx)?.poid;
  return poid && !label.includes(poid) ? `${label} (poid ${poid})` : label;
}

const list = (events: { event: string; poid?: string }[]) => events.map((e) => (e.poid ? `${e.event} for ${e.poid}` : e.event)).join(", ");
const ackList = (observed: ObservedEvent[]) => [...new Set(observed.filter((o) => o.as === "ack").map((o) => o.event))].join(", ");

/** Unrelated events a report names, at most. */
export const MAX_ALSO_SEEN = 20;

/** V10 outcomes that make the tool result an error: the call did not do what it asked, or nobody knows. */
export const V10_ERRORS: ReadonlySet<V10Outcome> = new Set(["not_done", "other", "unknown"]);
