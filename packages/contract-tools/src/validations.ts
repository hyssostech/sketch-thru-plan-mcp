import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The shared call-validation rules (STP-1064), pinned next to the contract from
 * hyssostech/sketch-thru-plan-sdk-js json-api/sketch-thru-plan-validations.json. The vocabulary is
 * documented in that repo's json-api/README.md, "Call validations"; these types mirror its schema.
 */

/** A dotted path into a call's params; a `*` segment stands for every item of an array. */
export type ParamPath = string;
/** A dotted path into an event's params; numeric segments index arrays (alternates.0.who). */
export type EventPath = string;

export type ReferenceKind = "symbol" | "unit" | "task" | "coa" | "taskOrg" | "taskOrgUnit" | "taskOrgRelationship" | "any";

export type Precondition = "activeScenario";

/** A param whose value is a poid that must name an existing object of `kind`. */
export interface ReferenceRule {
  param: ParamPath;
  kind: ReferenceKind | ReferenceKind[];
  /** The poid names the call's target: the call is meaningless without it. */
  required?: boolean;
}

/** What one matched path must equal: a param, a field of the forEach item, or a literal. */
export type ValueRef = { param: ParamPath } | { item: EventPath } | { value: unknown };

/** An event, and the values its paths must hold. */
export interface EventMatch {
  event: string;
  match?: Record<EventPath, ValueRef>;
}

/** One expected event (event + match) or one of several (anyOf); with forEach, one per item. */
export interface Expectation {
  event?: string;
  match?: Record<EventPath, ValueRef>;
  anyOf?: EventMatch[];
  forEach?: ParamPath;
  where?: Record<EventPath, { in?: unknown[]; notIn?: unknown[] }>;
}

/** How to tell from the event stream that a call did what it asked (V10). */
export interface Intent {
  expect: Expectation[];
  other?: EventMatch[];
  acks?: string[];
  unverifiable?: { issue: string; reason: string };
}

export interface MethodRules {
  preconditions: Precondition[];
  required?: ParamPath[];
  references?: ReferenceRule[];
  intent: Intent;
  /** Destructive methods: what the call destroys, with {param.path} placeholders. */
  confirm?: string;
}

export interface ValidationRules {
  $schema?: string;
  title?: string;
  description?: string;
  version: string;
  contractVersion: string;
  /** How the engine announces a refused fire-and-forget call: an event whose message contains this. */
  refusalMessage: { event: string; contains: string };
  methods: Record<string, MethodRules>;
}

/** Where the pinned rules came from (written by scripts/update-contract.mjs). */
export interface ValidationsPin {
  repo: string;
  path: string;
  schemaPath: string;
  ref: string;
  version: string;
  contractVersion: string;
}

export const defaultValidationsPath = fileURLToPath(new URL("../contract/sketch-thru-plan-validations.json", import.meta.url));
export const defaultValidationsSchemaPath = fileURLToPath(
  new URL("../contract/sketch-thru-plan-validations.schema.json", import.meta.url),
);
export const defaultValidationsPinPath = fileURLToPath(new URL("../contract/validations-pin.json", import.meta.url));

/** The major version of the rule vocabulary this code evaluates. */
export const SUPPORTED_VALIDATIONS_MAJOR = 1;

export function loadValidations(path: string = defaultValidationsPath): ValidationRules {
  const rules = JSON.parse(readFileSync(path, "utf8")) as ValidationRules;
  const major = Number(String(rules.version).split(".")[0]);
  if (major !== SUPPORTED_VALIDATIONS_MAJOR) {
    throw new Error(
      `${path}: validation rules version ${rules.version}, but this evaluator reads major version ${SUPPORTED_VALIDATIONS_MAJOR}`,
    );
  }
  return rules;
}

export function loadValidationsSchema(path: string = defaultValidationsSchemaPath): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function loadValidationsPin(path: string = defaultValidationsPinPath): ValidationsPin {
  return JSON.parse(readFileSync(path, "utf8")) as ValidationsPin;
}
