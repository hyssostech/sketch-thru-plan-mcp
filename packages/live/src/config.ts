import { z } from "zod";

/** How the live server reaches STP. Read from the environment (see the README). */
export interface LiveConfig {
  /** The engine's WebSockets JSON-RPC bridge, e.g. ws://localhost:9599. */
  url: string;
  /** The STP session to join; without it the engine starts a new, empty session. */
  session?: string;
  /** Default COA poid: fills a missing `poid` of GetCoaContent / GetCoaObjectSet. */
  coa?: string;
  /** Request timeout in seconds, sent to the engine (Request.timeout is in seconds). */
  timeoutS: number;
  /** STP_WRITE=1: list and run the contract's write methods. Off by default (read-only). */
  write?: boolean;
  /** STP_DESTRUCTIVE=1 (needs STP_WRITE=1): also list destructive methods; each call needs the user's confirmation. */
  destructive?: boolean;
  /** How long V10 waits for the events that prove a write was done, in seconds (default 8). */
  v10TimeoutS?: number;
  /** STP_ACTION_LOG: a JSONL file every write or destructive call (refused ones too) is appended to. */
  actionLog?: string;
}

export const DEFAULT_URL = "ws://localhost:9599";
export const DEFAULT_TIMEOUT_S = 15;
export const DEFAULT_V10_TIMEOUT_S = 8;

/** The values a switch variable takes; unset or blank is off. */
const SWITCH = ["1", "0", "true", "false"] as const;
const SWITCH_MESSAGE = "must be 1 or 0 (or true / false)";

/** An unset or blank variable counts as not set. */
const blank = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

const EnvSchema = z.object({
  STP_URL: z.preprocess(
    blank,
    z.string().regex(/^wss?:\/\/[^/\s]+/, "must be a ws:// or wss:// URL, e.g. ws://localhost:9599").optional(),
  ),
  STP_SESSION: z.preprocess(blank, z.string().optional()),
  STP_COA: z.preprocess(blank, z.string().optional()),
  STP_TIMEOUT_S: z.preprocess(
    blank,
    z.coerce.number().positive("must be a positive number of seconds").max(600, "must be at most 600 seconds").optional(),
  ),
  STP_WRITE: z.preprocess(blank, z.enum(SWITCH, { message: SWITCH_MESSAGE }).optional()),
  STP_DESTRUCTIVE: z.preprocess(blank, z.enum(SWITCH, { message: SWITCH_MESSAGE }).optional()),
  STP_V10_TIMEOUT_S: z.preprocess(
    blank,
    z.coerce.number().positive("must be a positive number of seconds").max(120, "must be at most 120 seconds").optional(),
  ),
  STP_ACTION_LOG: z.preprocess(blank, z.string().optional()),
});

const on = (v: string | undefined) => v === "1" || v === "true";

/**
 * The configuration from environment variables. A bad value throws with the variable's name, so
 * the process stops at startup with a reason instead of failing later on every call.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
    throw new Error(`stp-mcp-live: bad configuration: ${problems}`);
  }
  const e = parsed.data;
  if (on(e.STP_DESTRUCTIVE) && !on(e.STP_WRITE)) {
    throw new Error("stp-mcp-live: bad configuration: STP_DESTRUCTIVE=1 needs STP_WRITE=1 (destructive calls are a kind of write)");
  }
  return {
    url: e.STP_URL ?? DEFAULT_URL,
    ...(e.STP_SESSION ? { session: e.STP_SESSION } : {}),
    ...(e.STP_COA ? { coa: e.STP_COA } : {}),
    timeoutS: e.STP_TIMEOUT_S ?? DEFAULT_TIMEOUT_S,
    write: on(e.STP_WRITE),
    destructive: on(e.STP_DESTRUCTIVE),
    v10TimeoutS: e.STP_V10_TIMEOUT_S ?? DEFAULT_V10_TIMEOUT_S,
    ...(e.STP_ACTION_LOG ? { actionLog: e.STP_ACTION_LOG } : {}),
  };
}
