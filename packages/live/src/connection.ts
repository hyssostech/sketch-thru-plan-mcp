import net from "node:net";

/**
 * One connection to an STP engine's WebSockets JSON-RPC bridge.
 *
 * The wire (STP OpenRPC contract, transport layer):
 * - a call goes as `{method:"Request", params:{jsonRequest: JSON.stringify({method, params}), cookie, timeout}}`,
 *   with `timeout` in SECONDS; the answer is the event `RequestResponse {cookie, success, result}`;
 * - `Register` (sent the same way) names the session and the events this client wants ("solvables");
 * - `JoinScenarioSession` replays the scenario to this client as events, ahead of its own answer;
 * - a fire-and-forget method (x-stpInform) goes as an inform, `{method, params}`, and is never answered;
 * - every other frame is an event, `{method:<EventName>, params}`.
 *
 * The connection is lazy: the first call opens it (Register, then JoinScenarioSession). When the socket
 * closes, pending calls fail with an explained error and the next call makes one reconnect attempt.
 */

export type FailureKind = "unreachable" | "closed" | "timeout" | "refused" | "missing-event" | "shutdown";

/** An STP failure whose message says what happened, where, and what to check. */
export class StpError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
  ) {
    super(message);
    this.name = "StpError";
  }
}

export interface StpEvent {
  name: string;
  params: unknown;
  at: Date;
  /** True while a JoinScenarioSession is in flight: the event replays an existing object. */
  replay: boolean;
}

export interface ConnectionOptions {
  url: string;
  /** The session to join; without it the engine starts a new one (and that id is reused on reconnect). */
  session?: string;
  timeoutS: number;
  /** The event names to register for. */
  solvables: string[];
  serviceName?: string;
  onEvent?: (event: StpEvent) => void;
  /** Called on each (re)connect before Register, so a client can drop state the replay will rebuild. */
  onReset?: () => void;
}

export interface ConnectionStatus {
  endpoint: string;
  state: "disconnected" | "connecting" | "connected";
  session: string | null;
  connectedAt?: string;
  /** Successful connects so far; more than one means the server reconnected. */
  connects: number;
  lastError?: { message: string; at: string };
  eventCount: number;
  scenario: { active: boolean | null; note: string };
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: StpError) => void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  names: Set<string>;
  onEvent: (name: string) => void;
}

/** A Request the engine never answers still ends: the engine's own timeout plus this grace. */
export const CLIENT_GRACE_S = 2;
/** How long the TCP probe that explains a failed handshake may take. */
const PROBE_TIMEOUT_MS = 3000;

export class StpConnection {
  private ws: WebSocket | undefined;
  private state: ConnectionStatus["state"] = "disconnected";
  private connecting: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Set<EventWaiter>();
  private readonly listeners = new Set<(event: StpEvent) => void>();
  private nextCookie = 1;
  private joinsInFlight = 0;
  private sessionId: string | null;
  private connectedAt: Date | undefined;
  private connects = 0;
  private lastError: { message: string; at: string } | undefined;
  private eventCount = 0;
  private scenario: ConnectionStatus["scenario"] = { active: null, note: "not connected yet" };
  private shutDown = false;

  constructor(private readonly options: ConnectionOptions) {
    this.sessionId = options.session ?? null;
  }

  get url(): string {
    return this.options.url;
  }

  get session(): string | null {
    return this.sessionId;
  }

  get timeoutS(): number {
    return this.options.timeoutS;
  }

  status(): ConnectionStatus {
    return {
      endpoint: this.options.url,
      state: this.state,
      session: this.sessionId,
      ...(this.connectedAt ? { connectedAt: this.connectedAt.toISOString() } : {}),
      connects: this.connects,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      eventCount: this.eventCount,
      scenario: this.scenario,
    };
  }

  /** Connects, registers and joins the scenario, unless already connected. One attempt per call. */
  async ensureReady(): Promise<void> {
    if (this.shutDown) throw new StpError("the live server is shutting down", "shutdown");
    if (this.state === "connected") return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /**
   * Calls an STP method through Request and resolves with its result. When `expectEvents` names
   * events the call must produce, it also waits for each of them (within the timeout).
   */
  async request(method: string, params: unknown, expectEvents: string[] = []): Promise<unknown> {
    await this.ensureReady();
    if (expectEvents.length === 0) return this.send(method, params);

    const missing = new Set(expectEvents);
    let arrived: () => void = () => {};
    const allArrived = new Promise<void>((resolve) => (arrived = resolve));
    const waiter: EventWaiter = {
      names: missing,
      onEvent: (name) => {
        missing.delete(name);
        if (missing.size === 0) arrived();
      },
    };
    this.waiters.add(waiter);
    try {
      const result = await this.send(method, params);
      if (missing.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.options.timeoutS * 1000);
        });
        const outcome = await Promise.race([allArrived.then(() => "ok" as const), timedOut]);
        clearTimeout(timer);
        if (outcome === "timeout") {
          throw new StpError(
            `STP answered ${method} (${this.options.url}) but the expected event ${[...missing].join(", ")} did not ` +
              `arrive within ${this.options.timeoutS} s, so the outcome is unknown. Check it with a read ` +
              `(e.g. GetPoidObject) before relying on it.`,
            "missing-event",
          );
        }
      }
      return result;
    } finally {
      this.waiters.delete(waiter);
    }
  }

  /**
   * Sends a fire-and-forget method as an inform, `{method, params}`, the way the SDKs do. The engine
   * never answers an inform: its outcome arrives as events only (V10 watches for them).
   */
  async inform(method: string, params: unknown): Promise<void> {
    await this.ensureReady();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new StpError(
        `the STP connection closed (engine restarted?) before ${method} could be sent to ${this.options.url}; ` +
          `retry - the next call reconnects.`,
        "closed",
      );
    }
    ws.send(JSON.stringify({ method, params }));
  }

  /** Calls `listener` with every event from now on; returns the function that stops it. */
  addEventListener(listener: (event: StpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records what a HasActiveScenario asked by a client of this connection answered. */
  noteScenario(active: boolean): void {
    this.scenario = active
      ? { active: true, note: "the session has an active scenario (HasActiveScenario, asked before a write)" }
      : {
          active: false,
          note:
            "the session has no active scenario (HasActiveScenario, asked before a write). Reads answer empty values " +
            "and writes are refused until a client of this session creates or loads one; STP_SESSION selects the session.",
        };
  }

  /** Closes the socket for good: pending calls fail and no reconnect follows. */
  close(): void {
    this.shutDown = true;
    this.failPending(() => new StpError("the live server is shutting down; the call was abandoned", "shutdown"));
    this.ws?.close();
    this.ws = undefined;
    this.state = "disconnected";
  }

  // ---- connecting ---------------------------------------------------------------------------------

  private async connect(): Promise<void> {
    this.state = "connecting";
    try {
      this.ws = await this.open();
      this.options.onReset?.();
      const session = await this.send("Register", {
        serviceName: this.options.serviceName ?? "stp-mcp-live",
        language: "javascript",
        solvables: this.options.solvables,
        machineId: null,
        sessionId: this.sessionId,
      });
      if (typeof session === "string" && session) this.sessionId = session;
      this.state = "connected";
      this.connectedAt = new Date();
      this.connects++;
    } catch (e) {
      const error = asStpError(e, this.options.url);
      this.record(error);
      this.state = "disconnected";
      this.ws?.close();
      this.ws = undefined;
      throw error;
    }
    await this.join();
    // The socket can close during the join (an engine restarting right now): that is no connection.
    if (this.state !== "connected") {
      throw new StpError(this.lastError?.message ?? `the STP connection to ${this.options.url} closed while joining`, "closed");
    }
  }

  /**
   * Joins the session's scenario (the replay fills the live context) and notes whether there is one.
   * A failure here leaves the connection usable and is reported in the status, not thrown: reads
   * still work, and the status says why the context may be empty.
   */
  private async join(): Promise<void> {
    try {
      await this.send("JoinScenarioSession", {});
      const active = await this.send("HasActiveScenario", {});
      this.scenario =
        active === true
          ? { active: true, note: "joined the session's active scenario; its objects were replayed into the context" }
          : {
              active: false,
              note:
                "the session has no active scenario (nothing to replay). Reads answer empty values until a client " +
                "of this session creates or loads one; STP_SESSION selects the session.",
            };
    } catch (e) {
      const error = asStpError(e, this.options.url);
      this.scenario = { active: null, note: `joining the scenario failed: ${error.message}` };
      this.record(error);
    }
  }

  private open(): Promise<WebSocket> {
    const url = this.options.url;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new StpError(`cannot reach STP at ${url}: ${(e as Error).message} - is STP_URL a ws:// URL?`, "unreachable"));
        return;
      }
      const timer = setTimeout(() => {
        ws.onerror = null;
        ws.close();
        reject(
          new StpError(
            `cannot reach STP at ${url}: no WebSocket handshake within ${this.options.timeoutS} s - is the engine ` +
              `running and is STP_URL right?`,
            "unreachable",
          ),
        );
      }, this.options.timeoutS * 1000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.attach(ws);
        resolve(ws);
      };
      // Node's WebSocket reports no cause ("network error or non-101 status"), so a TCP probe tells
      // a refused or unresolvable endpoint apart from a port that answers but is not the bridge.
      ws.onerror = () => {
        clearTimeout(timer);
        void diagnose(url).then((cause) =>
          reject(new StpError(`cannot reach STP at ${url}: ${cause} - is the engine running and is STP_URL right?`, "unreachable")),
        );
      };
    });
  }

  private attach(ws: WebSocket): void {
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {}; // a close event follows and carries the handling
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = undefined;
      this.state = "disconnected";
      const detail = `code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""}`;
      this.record(
        new StpError(
          `the STP connection closed (engine restarted?) - ${this.options.url}, ${detail}. The next call reconnects.`,
          "closed",
        ),
      );
      this.failPending(
        (p) =>
          new StpError(
            `the STP connection closed (engine restarted?) while waiting for ${p.method} from ${this.options.url} ` +
              `(${detail}); its outcome is unknown. The next call reconnects - retry it.`,
            "closed",
          ),
      );
    };
  }

  // ---- traffic ------------------------------------------------------------------------------------

  private send(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new StpError(
          `the STP connection closed (engine restarted?) before ${method} could be sent to ${this.options.url}; ` +
            `retry - the next call reconnects.`,
          "closed",
        ),
      );
    }
    const timeoutS = this.options.timeoutS;
    const cookie = this.nextCookie++;
    const isJoin = method === "JoinScenarioSession";
    if (isJoin) this.joinsInFlight++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (!this.pending.delete(cookie)) return;
          reject(
            new StpError(
              `STP did not answer ${method} within ${timeoutS + CLIENT_GRACE_S} s (${this.options.url}; request timeout ` +
                `STP_TIMEOUT_S=${timeoutS} plus ${CLIENT_GRACE_S} s). The engine may be busy, or it dropped the request ` +
                `(it never answers some malformed calls). Check live_status, then retry or narrow the call.`,
              "timeout",
            ),
          );
        },
        (timeoutS + CLIENT_GRACE_S) * 1000,
      );
      this.pending.set(cookie, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ method: "Request", params: { jsonRequest: JSON.stringify({ method, params }), cookie, timeout: timeoutS } }));
    }).finally(() => {
      if (isJoin) this.joinsInFlight--;
    });
  }

  private onMessage(data: unknown): void {
    let msg: { method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // not JSON: nothing on this wire is, so there is nothing to route
    }
    if (typeof msg?.method !== "string") return;
    if (msg.method === "RequestResponse") {
      const { cookie, success, result } = (msg.params ?? {}) as { cookie?: number; success?: boolean; result?: unknown };
      const p = typeof cookie === "number" ? this.pending.get(cookie) : undefined;
      if (!p) return; // answered after we gave up, or not ours
      this.pending.delete(cookie!);
      clearTimeout(p.timer);
      if (success === true) p.resolve(result);
      else p.reject(new StpError(refusalText(p.method, result, this.options.timeoutS), "refused"));
      return;
    }
    this.eventCount++;
    const event: StpEvent = { name: msg.method, params: msg.params, at: new Date(), replay: this.joinsInFlight > 0 };
    for (const w of this.waiters) if (w.names.has(event.name)) w.onEvent(event.name);
    this.options.onEvent?.(event);
    for (const l of this.listeners) l(event);
  }

  private failPending(error: (p: Pending) => StpError): void {
    for (const [cookie, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(cookie);
      p.reject(error(p));
    }
  }

  private record(error: StpError): void {
    this.lastError = { message: error.message, at: new Date().toISOString() };
  }
}

function refusalText(method: string, result: unknown, timeoutS: number): string {
  const reason =
    result === null || result === undefined || result === ""
      ? "no reason given"
      : typeof result === "string"
        ? result
        : JSON.stringify(result);
  const hint = /operation was canceled/i.test(reason)
    ? ` (the engine gave up on its own ${timeoutS} s request timeout)`
    : "";
  return `STP refused ${method}: ${reason}${hint}`;
}

function asStpError(e: unknown, url: string): StpError {
  if (e instanceof StpError) return e;
  return new StpError(`STP call to ${url} failed: ${(e as Error)?.message ?? String(e)}`, "closed");
}

/** Why a WebSocket handshake to `url` failed, from a plain TCP connect to the same host and port. */
export function diagnose(url: string): Promise<string> {
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^\[|\]$/g, "");
    port = u.port ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;
  } catch {
    return Promise.resolve("not a valid URL");
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (cause: string) => {
      socket.destroy();
      resolve(cause);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(`ETIMEDOUT (no answer from ${host}:${port})`));
    socket.once("connect", () =>
      done(
        `${host}:${port} accepts connections but did not complete a WebSocket handshake: either it is not the STP ` +
          `WebSockets bridge (wrong port? the engine's default is 9599), or the engine is still starting (a Docker ` +
          `port mapping accepts connections before the engine listens)`,
      ),
    );
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const what =
        err.code === "ECONNREFUSED"
          ? `nothing is listening on ${host}:${port}`
          : err.code === "ENOTFOUND" || err.code === "EAI_AGAIN"
            ? `the host ${host} does not resolve`
            : err.message;
      done(`${err.code ?? "error"} (${what})`);
    });
  });
}
