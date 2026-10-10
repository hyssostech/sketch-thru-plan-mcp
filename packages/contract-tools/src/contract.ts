import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A JSON Schema fragment as the contract writes it. */
export type JsonSchema = Record<string, unknown>;

/** An OpenRPC content descriptor (a method param or result). */
export interface ContentDescriptor {
  name: string;
  description?: string;
  required?: boolean;
  schema: JsonSchema;
}

/** An OpenRPC method object, with the STP vendor extensions the generator reads. */
export interface ContractMethod {
  name: string;
  description?: string;
  params: ContentDescriptor[];
  result?: ContentDescriptor;
  /** "none" when the engine's WebSocketsBridge has no dispatch arm for the method. */
  "x-engineDispatch"?: string;
  /** "transport" for connector-level messages an application never sends. */
  "x-layer"?: string;
  "x-descriptionStatus"?: string;
  /** read | write | destructive (STP-1059, contract 0.7.0). Every method carries one. */
  "x-stpSafety"?: string;
  /** true when the engine sends no result: the outcome arrives as events (STP-1059). */
  "x-stpInform"?: boolean;
  /** true when the call reaches a system outside STP, e.g. the C2SIM server (STP-1059). */
  "x-stpOpenWorld"?: boolean;
  /** The events that follow a call, and who receives them (STP-1059, contract 0.8.0). */
  "x-stpEmits"?: EmittedEvent[];
  /** Ticket keys of filed defects that make today's engine differ from this entry. */
  "x-stpKnownIssues"?: string[];
  /** What a live engine did with bad or unusual input (STP-1059, contract 0.9.0). */
  "x-stpEdgeCases"?: EdgeCase[];
  /** OpenRPC example pairings, captured from a live engine (STP-1059, contract 0.9.0). */
  examples?: ExamplePairing[];
}

/** One edge case: the input, and whether the engine refused, announced, ignored or accepted it. */
export interface EdgeCase {
  when: string;
  outcome: "refused" | "announced" | "ignored" | "accepted";
  /** The refusal or StpMessage text. */
  message?: string;
  /** What an accepted call returned or sent, or a caveat. */
  note?: string;
  /** "request" when an inform was sent through Request. */
  wire?: string;
}

/** An OpenRPC example pairing; informs have no result. */
export interface ExamplePairing {
  name: string;
  description?: string;
  params: { name: string; value: unknown }[];
  result?: { name: string; value: unknown };
  /** The events the captured call produced. */
  "x-stpEventsObserved"?: { event: string; params: unknown }[];
}

/** One event a method produces: always, if a condition holds, or may (content-dependent). */
export interface EmittedEvent {
  event: string;
  when: "always" | "if" | "may";
  condition?: string;
  to: "caller" | "session";
}

/** An engine -> client event (the contract's `x-stpEvents`). */
export interface ContractEvent {
  name: string;
  description?: string;
  params: ContentDescriptor[];
  "x-descriptionStatus"?: string;
}

export interface Contract {
  openrpc: string;
  info: { title: string; version: string };
  methods: ContractMethod[];
  components?: { schemas?: Record<string, JsonSchema> };
  "x-stpEvents"?: ContractEvent[];
  "x-surfaceSource"?: Record<string, unknown>;
}

/** Where the pinned contract came from (written by scripts/update-contract.mjs). */
export interface ContractPin {
  repo: string;
  path: string;
  ref: string;
  version: string;
}

export const defaultContractPath = fileURLToPath(
  new URL("../contract/sketch-thru-plan-api.json", import.meta.url),
);
export const defaultPinPath = fileURLToPath(new URL("../contract/pin.json", import.meta.url));

export function loadContract(path: string = defaultContractPath): Contract {
  return JSON.parse(readFileSync(path, "utf8")) as Contract;
}

export function loadPin(path: string = defaultPinPath): ContractPin {
  return JSON.parse(readFileSync(path, "utf8")) as ContractPin;
}
