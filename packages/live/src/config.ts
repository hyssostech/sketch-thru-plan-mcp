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
}

export const DEFAULT_URL = "ws://localhost:9599";
export const DEFAULT_TIMEOUT_S = 15;

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
});

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
  return {
    url: e.STP_URL ?? DEFAULT_URL,
    ...(e.STP_SESSION ? { session: e.STP_SESSION } : {}),
    ...(e.STP_COA ? { coa: e.STP_COA } : {}),
    timeoutS: e.STP_TIMEOUT_S ?? DEFAULT_TIMEOUT_S,
  };
}
