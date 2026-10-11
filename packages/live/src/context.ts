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

    const mapping = EVENT_KINDS[event.name];
    if (mapping) {
      poid = this.applyEntityEvent(event, mapping, params, at);
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
    } else if (event.name === "NewScenario") {
      // Another client replaced the scenario: what this context holds no longer exists.
      this.entities.clear();
      this.deleted.clear();
      for (const k of Object.keys(this.lastAdded)) delete this.lastAdded[k as EntityKind];
      this.current = {};
    }

    this.recent.push({
      name: event.name,
      at,
      ...(poid ? { poid } : {}),
      ...(event.replay ? { replay: true as const } : {}),
      ...(detail ? { detail } : {}),
    });
    if (this.recent.length > this.caps.recentEvents) this.recent.splice(0, this.recent.length - this.caps.recentEvents);
    this.emit(changed);
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
