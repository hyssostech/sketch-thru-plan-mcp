import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLiveServer, type LiveServer, type LiveServerOptions } from "../src/server.js";
import type { LiveConfig } from "../src/config.js";

/**
 * A small STP engine stand-in that speaks the WebSockets bridge wire: Request{jsonRequest, cookie,
 * timeout} in, RequestResponse{cookie, success, result} and events out. Each method answers from a
 * scripted table; an answer can refuse, be delayed, never come, or close the connection.
 */

export interface ScriptedAnswer {
  success?: boolean;
  result?: unknown;
  /** Events sent before the answer (as JoinScenarioSession's replay is). */
  events?: { name: string; params?: unknown }[];
  delayMs?: number;
  /** Never answer. */
  noAnswer?: boolean;
  /** Close the connection instead of answering. */
  close?: boolean;
}

export type Script = Record<string, ScriptedAnswer | ((params: Record<string, unknown>) => ScriptedAnswer)>;

export interface Received {
  method: string;
  params: Record<string, unknown>;
  cookie: number;
  timeout: unknown;
}

const DEFAULT_SCRIPT: Script = {
  Register: (p) => ({ result: (p.sessionId as string | null) ?? "FAKE-SESSION" }),
  JoinScenarioSession: { result: null },
  HasActiveScenario: { result: true },
};

export class FakeEngine {
  readonly received: Received[] = [];
  readonly sockets = new Set<WebSocket>();
  script: Script;

  private constructor(
    private readonly wss: WebSocketServer,
    script: Script,
  ) {
    this.script = { ...DEFAULT_SCRIPT, ...script };
    wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (data) => void this.handle(ws, String(data)));
    });
  }

  static async start(script: Script = {}, port = 0): Promise<FakeEngine> {
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    return new FakeEngine(wss, script);
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** The methods called so far, in order. */
  methods(): string[] {
    return this.received.map((r) => r.method);
  }

  emit(name: string, params?: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(params === undefined ? { method: name } : { method: name, params }));
  }

  /** Drops every client connection, as an engine that dies does. */
  dropConnections(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private async handle(ws: WebSocket, text: string): Promise<void> {
    const frame = JSON.parse(text) as { method: string; params: { jsonRequest: string; cookie: number; timeout: unknown } };
    if (frame.method !== "Request") return; // informs: this server never sends one
    const inner = JSON.parse(frame.params.jsonRequest) as { method: string; params?: Record<string, unknown> };
    const params = inner.params ?? {};
    this.received.push({ method: inner.method, params, cookie: frame.params.cookie, timeout: frame.params.timeout });
    const entry = this.script[inner.method];
    const answer: ScriptedAnswer =
      entry === undefined
        ? { success: false, result: `No handler for ${inner.method}` }
        : typeof entry === "function"
          ? entry(params)
          : entry;
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    if (answer.close) {
      ws.terminate();
      return;
    }
    for (const e of answer.events ?? []) ws.send(JSON.stringify({ method: e.name, params: e.params }));
    if (answer.noAnswer) return;
    ws.send(
      JSON.stringify({
        method: "RequestResponse",
        params: { cookie: frame.params.cookie, success: answer.success ?? true, result: answer.result ?? null },
      }),
    );
  }
}

/**
 * Serves a recorded wire session (test/fixtures/session.jsonl): each request the client sends is
 * matched to the next recorded request of the same method, and the frames recorded after it - its
 * RequestResponse (re-addressed to the new cookie) and any events - are sent back in recorded order.
 */
export class ReplayEngine {
  readonly unmatched: string[] = [];
  private readonly steps: { method: string; params: unknown; frames: { method: string; params?: Record<string, unknown> }[]; used: boolean }[] = [];

  private constructor(
    private readonly wss: WebSocketServer,
    path: string,
  ) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const f = JSON.parse(line) as { dir: "send" | "recv"; frame: { method: string; params?: Record<string, unknown> } };
      if (f.dir === "send") {
        const inner = JSON.parse(String(f.frame.params!.jsonRequest)) as { method: string; params?: unknown };
        this.steps.push({ method: inner.method, params: inner.params, frames: [], used: false });
      } else {
        this.steps.at(-1)?.frames.push(f.frame);
      }
    }
    wss.on("connection", (ws) =>
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data));
        const inner = JSON.parse(frame.params.jsonRequest) as { method: string; params?: unknown };
        const same = (s: (typeof this.steps)[number]) => !s.used && s.method === inner.method;
        const step =
          this.steps.find((s) => same(s) && JSON.stringify(s.params) === JSON.stringify(inner.params)) ?? this.steps.find(same);
        if (!step) {
          this.unmatched.push(inner.method);
          ws.send(JSON.stringify({ method: "RequestResponse", params: { cookie: frame.params.cookie, success: false, result: `replay: no recorded ${inner.method}` } }));
          return;
        }
        step.used = true;
        for (const f of step.frames) {
          const out = f.method === "RequestResponse" ? { ...f, params: { ...f.params, cookie: frame.params.cookie } } : f;
          ws.send(JSON.stringify(out));
        }
      }),
    );
  }

  static async start(path: string): Promise<ReplayEngine> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return new ReplayEngine(wss, path);
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  /** Recorded requests not replayed yet. */
  unused(): string[] {
    return this.steps.filter((s) => !s.used).map((s) => s.method);
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** A port with nothing listening on it. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A plain HTTP server: something listening that is not the STP bridge (a wrong port). */
export async function httpServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.writeHead(404).end("not here"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A live server over `config`, and an MCP client connected to it in memory. */
export async function connectLive(
  config: Partial<LiveConfig> & { url: string },
  options: Omit<LiveServerOptions, "config"> = {},
): Promise<{ live: LiveServer; client: Client; close: () => Promise<void> }> {
  const live = createLiveServer({ config: { timeoutS: 5, ...config }, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await live.mcp.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return {
    live,
    client,
    close: async () => {
      await client.close();
      await live.close();
    },
  };
}

/** Calls a tool and returns its text, parsed body (on success) and error flag. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0].text;
  return { isError: res.isError === true, text, body: res.isError ? undefined : JSON.parse(text) };
}
