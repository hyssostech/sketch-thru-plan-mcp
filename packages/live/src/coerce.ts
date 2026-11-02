/**
 * Some MCP clients send a nested object argument as its JSON text (`"symbol": "{\"fsTYPE\":...}"`).
 * STP cannot convert that string to its type and drops the call without a reply, so a top-level
 * argument whose schema is an object or array and whose value is JSON text of that kind is parsed
 * back before validation. Anything else is left as it is, for the schema check to judge.
 */

type Schema = Record<string, unknown>;

const DEFS_REF = "#/$defs/";

/** The type a property's schema declares, following one level of $defs reference. */
function declaredType(property: unknown, defs: Record<string, unknown>): unknown {
  if (property === null || typeof property !== "object") return undefined;
  const p = property as Schema;
  if (p.type !== undefined) return p.type;
  if (typeof p.$ref === "string" && p.$ref.startsWith(DEFS_REF)) {
    const target = defs[p.$ref.slice(DEFS_REF.length)];
    if (target && typeof target === "object") return (target as Schema).type;
  }
  return undefined;
}

export interface Coercion {
  args: Record<string, unknown>;
  /** The argument names that arrived as JSON text and were parsed. */
  parsed: string[];
}

export function coerceJsonArgs(inputSchema: Schema | undefined, args: Record<string, unknown>): Coercion {
  const properties = (inputSchema?.properties ?? {}) as Record<string, unknown>;
  const defs = (inputSchema?.$defs ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...args };
  const parsed: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const type = declaredType(properties[name], defs);
    const wantsObject = type === "object";
    const wantsArray = type === "array";
    if (!wantsObject && !wantsArray) continue;
    const text = value.trim();
    if (!(wantsObject ? text.startsWith("{") : text.startsWith("["))) continue;
    try {
      const v: unknown = JSON.parse(text);
      if (wantsArray ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v)) {
        out[name] = v;
        parsed.push(name);
      }
    } catch {
      // not JSON: left for the schema check to refuse
    }
  }
  return { args: out, parsed };
}
