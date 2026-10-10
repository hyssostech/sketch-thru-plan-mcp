/**
 * Helpers for what the engine sends: dropping the PrologTerm fields, capping answer size and
 * reading engine timestamps.
 */

/** Answers whose JSON is larger than this are truncated, with a note saying so. */
export const MAX_ANSWER_BYTES = 200 * 1024;

/**
 * A deep copy without any `PrologTerm` key, and how many were dropped.
 *
 * Every engine object carries its content a second time as an engine term (STP-1085). Those terms
 * are 7-42 KB each, unreadable to a model, and would push the real content out of the context.
 */
export function stripPrologTerm(value: unknown): { value: unknown; dropped: number } {
  let dropped = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "PrologTerm") {
        dropped++;
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };
  return { value: walk(value), dropped };
}

export interface Truncation {
  /** What was cut, for the reader. */
  note: string;
  originalBytes: number;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/**
 * The answer, cut to fit `max` bytes of JSON when it is larger. Arrays keep their first items,
 * strings their beginning; any other value is replaced by the start of its JSON text. The cut is
 * never silent: the returned note says what was kept and how to get the rest.
 */
export function capAnswer(answer: unknown, max: number = MAX_ANSWER_BYTES): { answer: unknown; truncated?: Truncation } {
  const size = bytes(answer);
  if (size <= max) return { answer };
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  if (Array.isArray(answer)) {
    const kept: unknown[] = [];
    let used = 2;
    for (const item of answer) {
      const b = bytes(item) + 1;
      if (used + b > max) break;
      kept.push(item);
      used += b;
    }
    return {
      answer: kept,
      truncated: {
        originalBytes: size,
        note:
          `Truncated: the answer was ${kb(size)} of JSON, over the ${kb(max)} cap; the first ${kept.length} of ` +
          `${answer.length} items are shown. Ask for a narrower result (for example one COA or one poid).`,
      },
    };
  }
  const text = typeof answer === "string" ? answer : JSON.stringify(answer);
  // Cut by characters, then shrink until the JSON-escaped text fits (escaping can grow it).
  let cut = text.slice(0, max);
  while (bytes(cut) > max) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return {
    answer: cut,
    truncated: {
      originalBytes: size,
      note:
        `Truncated: the answer was ${kb(size)} of JSON, over the ${kb(max)} cap; only its first ` +
        `${cut.length} characters are shown${typeof answer === "string" ? "" : " (as JSON text)"}. ` +
        `Ask for a narrower result (for example one COA or one poid).`,
    },
  };
}

/** .NET DateTime ticks (100 ns since 0001-01-01) at the Unix epoch. */
const TICKS_AT_EPOCH = 621355968000000000n;

/**
 * An engine timestamp (`dbTimestamp`, .NET ticks as a decimal string) as an ISO date, or undefined
 * when the value is not one.
 */
export function ticksToIso(ticks: unknown): string | undefined {
  if (typeof ticks !== "string" || !/^\d{15,20}$/.test(ticks)) return undefined;
  const ms = (BigInt(ticks) - TICKS_AT_EPOCH) / 10000n;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
