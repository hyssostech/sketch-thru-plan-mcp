import { appendFileSync, closeSync, openSync } from "node:fs";
import type { CheckStep, V10Report } from "./validate.js";

/**
 * The action log (STP-1065): every write or destructive call this server is asked to make - refused
 * ones too - with who asked (the MCP client), what (method, params without PrologTerm), the validation
 * steps, the user's confirmation, the engine's answer and the V10 report. Bounded in memory and served
 * newest first as the stp-live://actions resource; optionally appended to a JSONL file (STP_ACTION_LOG).
 */

export const ACTIONS_URI = "stp-live://actions";
export const MAX_ACTIONS = 500;

export interface Confirmation {
  /** asked: the user was asked through MCP elicitation; unsupported: the client cannot ask, so the call was refused. */
  status: "accepted" | "declined" | "cancelled" | "unsupported" | "failed";
  /** What the user was asked to confirm. */
  message?: string;
  reason?: string;
  at: string;
}

export interface ActionEntry {
  id: number;
  at: string;
  /** The MCP client that asked (clientInfo from initialize). */
  client: { name: string; version: string } | null;
  /** The STP engine and session the call went to (or would have). */
  endpoint: string;
  session: string | null;
  method: string;
  safety: "write" | "destructive";
  /** The arguments as the model sent them, without PrologTerm. */
  params: unknown;
  /** sent: the call went to STP; refused: a check stopped it first (the last step says which). */
  status: "sent" | "refused";
  validation: CheckStep[];
  confirmation?: Confirmation;
  /** The engine's answer to a request method (informs get none). */
  engineAnswer?: { success: boolean; result?: unknown; error?: string };
  v10?: V10Report;
}

export class ActionLog {
  private readonly entries: ActionEntry[] = [];
  private nextId = 1;
  private fileError: string | undefined;
  private listeners: (() => void)[] = [];

  /**
   * @param file STP_ACTION_LOG: opened (created) now, so an unwritable path stops the server at startup
   *   rather than losing entries later.
   */
  constructor(
    readonly file?: string,
    readonly cap: number = MAX_ACTIONS,
  ) {
    if (file) closeSync(openSync(file, "a"));
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  add(entry: Omit<ActionEntry, "id">): ActionEntry {
    const full: ActionEntry = { id: this.nextId++, ...entry };
    this.entries.push(full);
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(full) + "\n");
        this.fileError = undefined;
      } catch (e) {
        // The call already happened: keep it in memory and say in the resource that the file missed it.
        this.fileError = `could not append entry ${full.id} to ${this.file}: ${(e as Error).message}`;
      }
    }
    for (const l of this.listeners) l();
    return full;
  }

  /** Newest first. */
  list(): ActionEntry[] {
    return [...this.entries].reverse();
  }

  document() {
    return {
      count: this.entries.length,
      cap: this.cap,
      file: this.file ?? null,
      ...(this.fileError ? { fileError: this.fileError } : {}),
      note:
        "Every write or destructive call this server was asked to make, refused ones included, newest first. " +
        "status 'refused' means a check stopped the call before it reached STP (see validation); 'sent' means it " +
        "went to STP, and v10 says what the event stream showed.",
      entries: this.list(),
    };
  }
}
