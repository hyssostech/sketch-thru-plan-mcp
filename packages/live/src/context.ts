import { stripPrologTerm, ticksToIso } from "./payload.js";
import type { StpEvent } from "./connection.js";

/**
 * The live context: a bounded working set of what the engine reported since this server joined -
 * symbols, tasks, COAs, task orgs with their units and relationships, the current COA, role and task
 * org, the last object added of each kind, and the recent events.
 *
 * It is fed only by events (the JoinScenarioSession replay, then live traffic), never by polling, so it
 * is a view of recent activity, not a copy of the scenario: the read tools are the source of truth.
 * Payloads are stored without PrologTerm.
 */

/** Entities kept at most; the least recently touched one goes first, never a focused one. */
export const MAX_ENTITIES = 500;
/** Recent events kept at most. */
export const MAX_RECENT_EVENTS = 200;
/** Batches (change sets) remembered: the open ones and the last finished ones. */
export const MAX_BATCHES = 20;
/** Object poids listed per batch; the count keeps going past it. */
export const MAX_BATCH_POIDS = 50;
/** Tasks whose history is kept, and entries kept per task (the oldest go first). */
export const MAX_TASK_HISTORIES = 100;
export const MAX_TASK_HISTORY_ENTRIES = 30;

export type EntityKind = "symbol" | "task" | "coa" | "taskOrg" | "taskOrgUnit" | "taskOrgRelationship";

/** The kinds a resource URI can name, stp-live://<kind>/<poid>. */
export const RESOURCE_KINDS = ["symbol", "task", "coa"] as const;

export interface Entity {
  kind: EntityKind;
  poid: string;
  /** One line for a model reader, e.g. "FRIENDLY INFANTRY COMPANY A at 36.35, -115.8". */
  summary: string;
  /** The last payload seen, without PrologTerm. */
  data: Record<string, unknown>;
  /** The event that last set it, and when it was received. */
  lastEvent: string;
  receivedAt: string;
  /** The engine's own timestamp of the object (dbTimestamp), when it carries one. */
  engineTime?: string;
  /** "replay" when it came from the JoinScenarioSession replay of an object that already existed. */
  source: "live" | "replay";
}

export interface LastAdded {
  poid: string;
  summary: string;
  receivedAt: string;
  engineTime?: string;
  source: "live" | "replay";
  /** Set when a later event deleted it. */
  deleted?: true;
}

export interface RecentEvent {
  name: string;
  at: string;
  poid?: string;
  replay?: true;
  /** StpMessage text, recognized speech: short and worth seeing. */
  detail?: string;
  /** The change set (BatchStarted) the event arrived in; absent outside one. */
  batchId?: string;
}

/** A change set (STP-1265): the object events one bulk operation produced, which share a batchId. */
export interface BatchInfo {
  batchId: string;
  kind?: string;
  /** How many objects the requester expected to write; -1 when it did not say. */
  expected?: number;
  isOwn?: boolean;
  /** "replay" for a join replaying resident objects locally, else "live". */
  origin?: string;
  startedAt: string;
  /** Object events seen carrying this batchId. */
  events: number;
  /** The poids they touched (at most MAX_BATCH_POIDS). */
  poids: string[];
  /** Set by BatchEnded: completed, cancelled, failed, abandoned or expired. */
  status?: string;
  endedAt?: string;
  /** The engine's count of object events it stamped (BatchEnded.informs); 0 when unknown. */
  informs?: number;
}

/** One entry of a task's history or a comment (TaskEventAdded / TaskEventModified), as the engine sent it. */
export interface TaskHistoryItem {
  poid: string;
  entry: Record<string, unknown>;
  /** "added" until a TaskEventModified replaced it. */
  lastEvent: "TaskEventAdded" | "TaskEventModified";
  receivedAt: string;
  batchId?: string;
}

/** A reference to the current COA or task org, or null when the engine reported none. */
export type CurrentRef = { poid: string; name?: string } | null;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Which event updates which kind, and how. */
const EVENT_KINDS: Record<string, { kind: EntityKind; op: "add" | "modify" | "delete"; key?: string }> = {
  SymbolAdded: { kind: "symbol", op: "add" },
  SymbolModified: { kind: "symbol", op: "modify", key: "symbol" },
  SymbolDeleted: { kind: "symbol", op: "delete" },
  TaskAdded: { kind: "task", op: "add" },
  TaskModified: { kind: "task", op: "modify" },
  TaskDeleted: { kind: "task", op: "delete" },
  CoaAdded: { kind: "coa", op: "add", key: "coa" },
  CoaModified: { kind: "coa", op: "modify", key: "coa" },
  CoaDeleted: { kind: "coa", op: "delete" },
  TaskOrgAdded: { kind: "taskOrg", op: "add", key: "taskOrg" },
  TaskOrgModified: { kind: "taskOrg", op: "modify", key: "taskOrg" },
  TaskOrgDeleted: { kind: "taskOrg", op: "delete" },
  TaskOrgUnitAdded: { kind: "taskOrgUnit", op: "add", key: "toUnit" },
  TaskOrgUnitModified: { kind: "taskOrgUnit", op: "modify", key: "toUnit" },
  TaskOrgUnitDeleted: { kind: "taskOrgUnit", op: "delete" },
  TaskOrgRelationshipAdded: { kind: "taskOrgRelationship", op: "add", key: "toRelationship" },
  TaskOrgRelationshipModified: { kind: "taskOrgRelationship", op: "modify", key: "toRelationship" },
  TaskOrgRelationshipDeleted: { kind: "taskOrgRelationship", op: "delete" },
};

/** The plural names the context uses for each kind. */
const PLURAL: Record<EntityKind, string> = {
  symbol: "symbols",
  task: "tasks",
  coa: "coas",
  taskOrg: "taskOrgs",
  taskOrgUnit: "taskOrgUnits",
  taskOrgRelationship: "taskOrgRelationships",
};

/** The kinds `lastAdded` tracks. */
const LAST_ADDED_KINDS: EntityKind[] = ["symbol", "task", "coa", "taskOrg", "taskOrgUnit"];

export class LiveContext {
  /** By poid, in least-recently-touched-first order (a Map keeps insertion order). */
  private readonly entities = new Map<string, Entity>();
  private readonly recent: RecentEvent[] = [];
  private readonly lastAdded: Partial<Record<EntityKind, LastAdded>> = {};
  private current: { coa?: CurrentRef; role?: string; taskOrg?: CurrentRef } = {};
  private evicted = 0;
  /** Batches by id, oldest first: the open ones and the last finished ones. */
  private readonly batches = new Map<string, BatchInfo>();
  /** Task poid -> its history entries seen (oldest first), least recently touched task first. */
  private readonly taskHistory = new Map<string, TaskHistoryItem[]>();
  private since = new Date().toISOString();
  private listeners: ((changedUris: string[]) => void)[] = [];
  /** Poids deleted since this server joined, so a reference to one can say so (bounded like the entities). */
  private readonly deleted = new Map<string, { event: string; at: string }>();
  /** True when this server makes calls itself (write mode): then it does see its own switches. */
  writer = false;

  constructor(
    private readonly caps = { entities: MAX_ENTITIES, recentEvents: MAX_RECENT_EVENTS },
  ) {}

  /** Called with the stp-live:// URIs an event changed (always including the context itself). */
  onChange(listener: (changedUris: string[]) => void): void {
    this.listeners.push(listener);
  }

  /** Forgets the entities and the current state (the recent events stay): on (re)connect the replay rebuilds them. */
  reset(): void {
    this.entities.clear();
    for (const k of Object.keys(this.lastAdded)) delete this.lastAdded[k as EntityKind];
    this.current = {};
    this.batches.clear(); // an open batch cannot be known to be open after a reconnect
    this.taskHistory.clear();
    this.evicted = 0;
    this.since = new Date().toISOString();
    this.emit([CONTEXT_URI]);
  }

  get(kind: EntityKind, poid: string): Entity | undefined {
    const e = this.entities.get(poid);
    return e?.kind === kind ? e : undefined;
  }

  /** The object with this poid, of any kind, if the context holds it. */
  find(poid: string): Entity | undefined {
    return this.entities.get(poid);
  }

  /** The event that deleted this poid, if one arrived since this server joined. */
  deletedBy(poid: string): { event: string; at: string } | undefined {
    return this.deleted.get(poid);
  }

  /** Applies one engine event. Unknown events are still listed among the recent ones. */
  apply(event: StpEvent): void {
    const { value } = stripPrologTerm(event.params);
    const params = isObject(value) ? value : {};
    const at = event.at.toISOString();
    const changed = [CONTEXT_URI];
    let poid: string | undefined;
    let detail: string | undefined;
    // Object events of a change set end with batchId; null or absent outside one.
    const batchId = str(params.batchId);

    const mapping = EVENT_KINDS[event.name];
    if (mapping) {
      poid = this.applyEntityEvent(event, mapping, params, at);
      if (batchId) this.noteBatchMember(batchId, poid, at);
      if (poid && (RESOURCE_KINDS as readonly string[]).includes(mapping.kind)) changed.push(entityUri(mapping.kind, poid));
    } else if (event.name === "CoaSwitched") {
      this.current.coa = refOf(params.coa);
      poid = this.current.coa?.poid;
      if (isObject(params.coa) && poid) this.upsert("coa", poid, params.coa, event, at);
    } else if (event.name === "TaskOrgSwitched") {
      this.current.taskOrg = refOf(params.taskOrg);
      poid = this.current.taskOrg?.poid;
      if (isObject(params.taskOrg) && poid) this.upsert("taskOrg", poid, params.taskOrg, event, at);
    } else if (event.name === "RoleSwitched") {
      this.current.role = str(params.role);
      detail = this.current.role;
    } else if (event.name === "StpMessage") {
      detail = [str(params.level), str(params.message)].filter(Boolean).join(": ").slice(0, 300) || undefined;
    } else if (event.name === "SpeechRecognized" && Array.isArray(params.phrases)) {
      detail = params.phrases.filter((p) => typeof p === "string").join(" | ").slice(0, 300) || undefined;
    } else if (event.name === "BatchStarted") {
      detail = this.batchStarted(params, at);
    } else if (event.name === "BatchEnded") {
      detail = this.batchEnded(params, at);
    } else if (event.name === "TaskEventAdded" || event.name === "TaskEventModified") {
      const noted = this.noteTaskEvent(event.name, params, at, batchId);
      poid = noted?.task;
      detail = noted?.detail;
      if (batchId) this.noteBatchMember(batchId, poid, at);
      if (poid) changed.push(entityUri("task", poid));
    } else if (event.name === "NewScenario") {
      // Another client replaced the scenario: what this context holds no longer exists.
      this.entities.clear();
      this.deleted.clear();
      for (const k of Object.keys(this.lastAdded)) delete this.lastAdded[k as EntityKind];
      this.current = {};
      this.batches.clear();
      this.taskHistory.clear();
    }

    this.recent.push({
      name: event.name,
      at,
      ...(poid ? { poid } : {}),
      ...(event.replay ? { replay: true as const } : {}),
      ...(detail ? { detail } : {}),
      ...(batchId ? { batchId } : {}),
    });
    if (this.recent.length > this.caps.recentEvents) this.recent.splice(0, this.recent.length - this.caps.recentEvents);
    this.emit(changed);
  }

  private batchStarted(params: Json, at: string): string | undefined {
    const batchId = str(params.batchId);
    if (!batchId) return undefined;
    const kind = str(params.kind);
    const info: BatchInfo = {
      batchId,
      ...(kind ? { kind } : {}),
      ...(typeof params.expected === "number" ? { expected: params.expected } : {}),
      ...(typeof params.isOwn === "boolean" ? { isOwn: params.isOwn } : {}),
      ...(str(params.origin) ? { origin: str(params.origin) } : {}),
      startedAt: at,
      events: 0,
      poids: [],
    };
    this.batches.delete(batchId);
    this.batches.set(batchId, info);
    this.trimBatches();
    return `${kind ?? "batch"} ${batchId} started`;
  }

  private batchEnded(params: Json, at: string): string | undefined {
    const batchId = str(params.batchId);
    if (!batchId) return undefined;
    // An engine may end a batch this server never saw start (joined mid-batch): record it as ended.
    let info = this.batches.get(batchId);
    if (!info) {
      info = { batchId, startedAt: at, events: 0, poids: [] };
      this.batches.set(batchId, info);
    }
    if (str(params.kind) && !info.kind) info.kind = str(params.kind);
    if (str(params.origin) && !info.origin) info.origin = str(params.origin);
    if (typeof params.isOwn === "boolean" && info.isOwn === undefined) info.isOwn = params.isOwn;
    info.status = str(params.status) ?? "completed";
    info.endedAt = at;
    if (typeof params.informs === "number") info.informs = params.informs;
    this.trimBatches();
    return `${info.kind ?? "batch"} ${batchId} ${info.status}`;
  }

  /** Counts an object event of a batch; a batch this server saw no start of is listed as open until it ends. */
  private noteBatchMember(batchId: string, poid: string | undefined, at: string): void {
    let info = this.batches.get(batchId);
    if (!info) {
      info = { batchId, startedAt: at, events: 0, poids: [] };
      this.batches.set(batchId, info);
      this.trimBatches();
    }
    info.events++;
    if (poid && info.poids.length < MAX_BATCH_POIDS && !info.poids.includes(poid)) info.poids.push(poid);
  }

  /** Keeps every open batch and at most MAX_BATCHES finished ones (oldest finished go first). */
  private trimBatches(): void {
    const finished = [...this.batches.values()].filter((b) => b.status !== undefined);
    for (const b of finished.slice(0, Math.max(0, finished.length - MAX_BATCHES))) this.batches.delete(b.batchId);
    // A runaway of never-ended batches (lost BatchEnded) is bounded too: the oldest open one goes.
    while (this.batches.size > MAX_BATCHES * 2) this.batches.delete(this.batches.keys().next().value!);
  }

  private noteTaskEvent(
    name: "TaskEventAdded" | "TaskEventModified",
    params: Json,
    at: string,
    batchId: string | undefined,
  ): { task: string; detail: string } | undefined {
    const entry = isObject(params.entry) ? params.entry : undefined;
    const task = str(entry?.task);
    const entryPoid = str(params.poid);
    if (!entry || !task || !entryPoid) return undefined;
    const item: TaskHistoryItem = {
      poid: entryPoid,
      entry,
      lastEvent: name,
      receivedAt: at,
      ...(batchId ? { batchId } : {}),
    };
    const list = this.taskHistory.get(task) ?? [];
    const i = list.findIndex((x) => x.poid === entryPoid);
    if (i >= 0) list[i] = item;
    else list.push(item);
    if (list.length > MAX_TASK_HISTORY_ENTRIES) list.splice(0, list.length - MAX_TASK_HISTORY_ENTRIES);
    this.taskHistory.delete(task); // most recently touched last
    this.taskHistory.set(task, list);
    while (this.taskHistory.size > MAX_TASK_HISTORIES) this.taskHistory.delete(this.taskHistory.keys().next().value!);
    const kind = str(entry.kind) ?? "entry";
    const text = str(entry.text);
    const detail = (name === "TaskEventModified" ? `${kind} (modified)` : kind) + (text ? `: ${text}` : entry.deleted ? ": (deleted)" : "");
    return { task, detail: detail.slice(0, 300) };
  }

  /** The history and comments the engine announced for a task since this server joined, oldest first. */
  historyOf(taskPoid: string): TaskHistoryItem[] {
    return [...(this.taskHistory.get(taskPoid) ?? [])];
  }

  /** The open batches, oldest first. */
  openBatches(): BatchInfo[] {
    return [...this.batches.values()].filter((b) => b.status === undefined);
  }

  private applyEntityEvent(
    event: StpEvent,
    mapping: { kind: EntityKind; op: "add" | "modify" | "delete"; key?: string },
    params: Json,
    at: string,
  ): string | undefined {
    // SymbolAdded carries the n-best alternates, and TaskAdded/TaskModified their alternates too:
    // the first one is the interpretation STP chose.
    const body = mapping.key
      ? params[mapping.key]
      : Array.isArray(params.alternates)
        ? params.alternates[0]
        : undefined;
    const data = isObject(body) ? body : undefined;
    const poid = str(params.poid) ?? str(data?.poid);
    if (!poid) return undefined;

    if (mapping.op === "delete") {
      this.entities.delete(poid);
      this.deleted.delete(poid);
      this.deleted.set(poid, { event: event.name, at });
      if (this.deleted.size > this.caps.entities) this.deleted.delete(this.deleted.keys().next().value!);
      for (const k of LAST_ADDED_KINDS) {
        const last = this.lastAdded[k];
        if (last?.poid === poid) last.deleted = true;
      }
      if (this.current.coa?.poid === poid) this.current.coa = null;
      if (this.current.taskOrg?.poid === poid) this.current.taskOrg = null;
      return poid;
    }
    if (!data) return poid;
    this.deleted.delete(poid); // re-added (an undo, an import)
    const entity = this.upsert(mapping.kind, poid, data, event, at);
    if (mapping.op === "add" && LAST_ADDED_KINDS.includes(mapping.kind)) this.noteAdded(entity);
    if (mapping.kind === "coa" && this.current.coa?.poid === poid) this.current.coa = refOf(data);
    return poid;
  }

  private upsert(kind: EntityKind, poid: string, data: Json, event: StpEvent, at: string): Entity {
    const engineTime = ticksToIso(data.dbCreationTimestamp ?? data.dbTimestamp);
    const entity: Entity = {
      kind,
      poid,
      summary: "",
      data,
      lastEvent: event.name,
      receivedAt: at,
      ...(engineTime ? { engineTime } : {}),
      source: event.replay ? "replay" : "live",
    };
    entity.summary = this.summarize(entity);
    this.entities.delete(poid); // re-insert at the most-recent end
    this.entities.set(poid, entity);
    this.evict();
    return entity;
  }

  /**
   * Remembers the last object added of a kind. A live add always wins; in a replay, whose order is
   * the engine's and not creation order, the object the engine created last wins.
   */
  private noteAdded(entity: Entity): void {
    const prev = this.lastAdded[entity.kind];
    if (entity.source === "replay" && prev) {
      if (prev.source === "live") return;
      if (prev.engineTime && entity.engineTime && entity.engineTime < prev.engineTime) return;
    }
    this.lastAdded[entity.kind] = {
      poid: entity.poid,
      summary: entity.summary,
      receivedAt: entity.receivedAt,
      ...(entity.engineTime ? { engineTime: entity.engineTime } : {}),
      source: entity.source,
    };
  }

  private evict(): void {
    if (this.entities.size <= this.caps.entities) return;
    const focused = new Set<string>();
    for (const last of Object.values(this.lastAdded)) if (last) focused.add(last.poid);
    if (this.current.coa) focused.add(this.current.coa.poid);
    if (this.current.taskOrg) focused.add(this.current.taskOrg.poid);
    for (const poid of this.entities.keys()) {
      if (this.entities.size <= this.caps.entities) break;
      if (focused.has(poid)) continue;
      this.entities.delete(poid);
      this.evicted++;
    }
  }

  private nameOf(poid: unknown): string | undefined {
    if (typeof poid !== "string") return undefined;
    const e = this.entities.get(poid);
    if (!e) return undefined;
    const d = e.data;
    return str(d.name) ?? str(d.fullDescription) ?? str(d.description);
  }

  private summarize(e: Entity): string {
    const d = e.data;
    switch (e.kind) {
      case "symbol": {
        const what = str(d.fullDescription) ?? str(d.description) ?? str((d.sidc as Json | undefined)?.charlie) ?? String(d.fsTYPE ?? "symbol");
        const where = locationText(d.location);
        return where ? `${what} at ${where}` : what;
      }
      case "task": {
        const what = [str(d.what), str(d.how)].filter(Boolean).join(" / ");
        const who = typeof d.who === "string" ? (this.nameOf(d.who) ? `${this.nameOf(d.who)} (${d.who})` : d.who) : undefined;
        return [str(d.name) ?? "task", what && `(${what})`, who && `by ${who}`, str(d.description) && `- ${str(d.description)!.trim()}`]
          .filter(Boolean)
          .join(" ");
      }
      case "coa":
        return `${str(d.name) ?? "COA"} (${[str(d.affiliation), str(d.creatorRole) && `by ${str(d.creatorRole)}`].filter(Boolean).join(", ")})`;
      case "taskOrg":
        return `${str(d.name) ?? "task org"}${str(d.affiliation) ? ` (${str(d.affiliation)})` : ""}`;
      case "taskOrgUnit":
        return [str(d.name), str(d.fullDescription)].filter(Boolean).join(" - ") || "task org unit";
      case "taskOrgRelationship":
        return `${this.nameOf(d.parent) ?? d.parent} -> ${this.nameOf(d.child) ?? d.child} (${str(d.relationship) ?? "relationship"})`;
    }
  }

  /** The context as the stp-live://context resource and the live_context tool return it. */
  snapshot(): ContextSnapshot {
    const counts: Record<string, number> = {};
    const entities: Record<string, { poid: string; summary: string; source: string }[]> = {};
    for (const kind of Object.keys(PLURAL) as EntityKind[]) {
      counts[PLURAL[kind]] = 0;
      entities[PLURAL[kind]] = [];
    }
    // Most recently touched first.
    for (const e of [...this.entities.values()].reverse()) {
      counts[PLURAL[e.kind]]++;
      entities[PLURAL[e.kind]].push({ poid: e.poid, summary: e.summary, source: e.source });
    }
    // STP keeps the role, current COA and task org per client, and announces a change only to the
    // client that made it. This server never makes one, so "not observed" is the usual value.
    const unseen = (what: string) =>
      `not observed: no ${what} reached this server since ${this.since}. STP announces it only to the client ` +
      `that switched, and this ${this.writer ? "server has not switched" : "read-only server never switches"}` +
      `${what === "CoaSwitched" ? " (set STP_COA to name the COA to read)" : ""}.`;
    return {
      observedSince: this.since,
      current: {
        coa: this.current.coa === undefined ? unseen("CoaSwitched") : this.current.coa,
        role: this.current.role ?? unseen("RoleSwitched"),
        taskOrg: this.current.taskOrg === undefined ? unseen("TaskOrgSwitched") : this.current.taskOrg,
      },
      lastAdded: { ...this.lastAdded },
      counts: { ...counts, evicted: this.evicted },
      entities,
      batches: {
        open: this.openBatches().map((b) => ({ ...b, poids: [...b.poids] })),
        recent: [...this.batches.values()].filter((b) => b.status !== undefined).reverse().map((b) => ({ ...b, poids: [...b.poids] })),
      },
      taskHistories: [...this.taskHistory.entries()].reverse().map(([task, items]) => ({ task, entries: items.length, latest: items[items.length - 1].entry.kind ?? null })),
      recentEvents: [...this.recent].reverse(),
      caps: { ...this.caps },
    };
  }

  private emit(uris: string[]): void {
    for (const l of this.listeners) l(uris);
  }
}

export interface ContextSnapshot {
  observedSince: string;
  current: { coa: CurrentRef | string; role: string; taskOrg: CurrentRef | string };
  lastAdded: Partial<Record<EntityKind, LastAdded>>;
  counts: Record<string, number>;
  entities: Record<string, { poid: string; summary: string; source: string }[]>;
  /** Change sets (STP-1265): which object events arrived together, and which are still open. */
  batches: { open: BatchInfo[]; recent: BatchInfo[] };
  /** Tasks with history or comments seen; the entries are in the task resource, stp-live://task/<poid>. */
  taskHistories: { task: string; entries: number; latest: unknown }[];
  recentEvents: RecentEvent[];
  caps: { entities: number; recentEvents: number };
}

export const CONTEXT_URI = "stp-live://context";

export function entityUri(kind: EntityKind, poid: string): string {
  return `stp-live://${kind}/${poid}`;
}

function refOf(v: unknown): CurrentRef {
  if (!isObject(v)) return null;
  const poid = str(v.poid);
  if (!poid) return null;
  const name = str(v.name) ?? str(v.Name);
  return name ? { poid, name } : { poid };
}

/** "36.35, -115.8" for a point; "line through 3 points around 36.3, -115.8" for anything else. */
function locationText(location: unknown): string | undefined {
  if (!isObject(location)) return undefined;
  const fmt = (p: unknown) =>
    isObject(p) && typeof p.lat === "number" && typeof p.lon === "number" ? `${p.lat}, ${p.lon}` : undefined;
  const coords = Array.isArray(location.coords) ? location.coords : [];
  const centre = fmt(location.centroid) ?? fmt(coords[0]);
  if (!centre) return undefined;
  const shape = str(location.shape);
  if (!shape || shape === "point" || coords.length <= 1) return centre;
  return `${shape} through ${coords.length} points around ${centre}`;
}
