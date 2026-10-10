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
  /** read | write | destructive (STP-1059). Absent until the contract classifies the method. */
  "x-stpSafety"?: string;
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
