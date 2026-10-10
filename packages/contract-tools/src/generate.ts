import type { Contract, ContractMethod, EmittedEvent, JsonSchema } from "./contract.js";

export type SafetyClass = "read" | "write" | "destructive";

/** An MCP tool definition, ready for a tools/list response. */
export interface GeneratedTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties: false;
    $defs?: Record<string, JsonSchema>;
  };
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta: {
    "stp/safety": SafetyClass;
    /** Present when the engine answers with events only, never a result. */
    "stp/inform"?: true;
    /** The events that follow a call (contract x-stpEmits). */
    "stp/emits"?: EmittedEvent[];
    /** Filed defects that make today's engine differ from the contract entry. */
    "stp/knownIssues"?: string[];
    "stp/descriptionStatus"?: string;
  };
}

/** A contract method that is deliberately not a tool, and why. */
export interface ExcludedMethod {
  name: string;
  reason: string;
}

export interface GenerationResult {
  contractVersion: string;
  tools: GeneratedTool[];
  excluded: ExcludedMethod[];
}

const COMPONENT_REF = "#/components/schemas/";
const DEFS_REF = "#/$defs/";

/**
 * Why a method must not become a tool, or null when it may.
 * A tool the engine refuses ("No handler") would promise a call that cannot work.
 */
export function exclusionReason(method: ContractMethod): string | null {
  if (method["x-engineDispatch"] === "none") {
    return "not dispatched by the engine (x-engineDispatch: none); the call answers 'No handler'";
  }
  if (method["x-layer"] === "transport") {
    return "transport-layer message, built and consumed by the SDK connectors only";
  }
  return null;
}

/**
 * The method's safety class. Since contract 0.7.0 every method carries one, so a missing
 * class is a contract defect: refuse it rather than generate a tool a client must guess about.
 */
export function safetyClass(method: ContractMethod): SafetyClass {
  const s = method["x-stpSafety"];
  if (s === "read" || s === "write" || s === "destructive") return s;
  if (s === undefined) {
    throw new Error(`${method.name}: no x-stpSafety (every contract method must be read | write | destructive)`);
  }
  throw new Error(`${method.name}: unknown x-stpSafety '${s}' (expected read | write | destructive)`);
}

/** MCP annotations for a safety class; openWorld when the call reaches a system outside STP. */
function annotationsFor(safety: SafetyClass, openWorld: boolean): GeneratedTool["annotations"] {
  switch (safety) {
    case "read":
      return { readOnlyHint: true, openWorldHint: openWorld };
    case "write":
      return { readOnlyHint: false, destructiveHint: false, openWorldHint: openWorld };
    case "destructive":
      return { readOnlyHint: false, destructiveHint: true, openWorldHint: openWorld };
  }
}

/** Deep-copies a schema, rewriting component refs to $defs refs and recording each one used. */
function rewriteRefs(node: unknown, used: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, used));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      if (!value.startsWith(COMPONENT_REF)) {
        throw new Error(`unsupported $ref '${value}' (only ${COMPONENT_REF}* is resolved)`);
      }
      const name = value.slice(COMPONENT_REF.length);
      used.add(name);
      out[key] = DEFS_REF + name;
    } else {
      out[key] = rewriteRefs(value, used);
    }
  }
  return out;
}

/** The referenced component schemas, closed over their own references. */
function collectDefs(
  roots: Set<string>,
  components: Record<string, JsonSchema>,
  owner: string,
): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = {};
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (name in defs) continue;
    const schema = components[name];
    if (schema === undefined) {
      throw new Error(`${owner}: $ref to missing component schema '${name}'`);
    }
    const nested = new Set<string>();
    defs[name] = rewriteRefs(schema, nested) as JsonSchema;
    for (const n of nested) if (!(n in defs)) pending.push(n);
  }
  return Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)));
}

export function toolFromMethod(method: ContractMethod, contract: Contract): GeneratedTool {
  const components = contract.components?.schemas ?? {};
  const used = new Set<string>();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const param of method.params ?? []) {
    const schema = rewriteRefs(param.schema, used) as JsonSchema;
    properties[param.name] =
      param.description === undefined ? schema : { ...schema, description: param.description };
    if (param.required) required.push(param.name);
  }

  const safety = safetyClass(method);
  const tool: GeneratedTool = {
    name: method.name,
    description: method.description ?? "",
    inputSchema: { type: "object", properties, additionalProperties: false },
    annotations: annotationsFor(safety, method["x-stpOpenWorld"] === true),
    _meta: { "stp/safety": safety },
  };
  if (method["x-stpInform"] === true) tool._meta["stp/inform"] = true;
  if (method["x-stpEmits"]?.length) tool._meta["stp/emits"] = method["x-stpEmits"];
  if (method["x-stpKnownIssues"]?.length) tool._meta["stp/knownIssues"] = method["x-stpKnownIssues"];
  if (required.length > 0) tool.inputSchema.required = required;
  if (used.size > 0) tool.inputSchema.$defs = collectDefs(used, components, method.name);
  if (method["x-descriptionStatus"]) tool._meta["stp/descriptionStatus"] = method["x-descriptionStatus"];
  return tool;
}

/** Every contract method either becomes a tool or is listed as excluded with its reason. */
export function generateTools(contract: Contract): GenerationResult {
  const tools: GeneratedTool[] = [];
  const excluded: ExcludedMethod[] = [];
  for (const method of contract.methods) {
    const reason = exclusionReason(method);
    if (reason === null) tools.push(toolFromMethod(method, contract));
    else excluded.push({ name: method.name, reason });
  }
  return { contractVersion: contract.info.version, tools, excluded };
}
