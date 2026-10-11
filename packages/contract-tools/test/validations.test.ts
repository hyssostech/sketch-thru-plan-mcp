import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exclusionReason,
  loadContract,
  loadPin,
  loadValidations,
  loadValidationsPin,
  safetyClass,
  SUPPORTED_VALIDATIONS_MAJOR,
} from "../src/index.js";

const contract = loadContract();
const rules = loadValidations();
const pin = loadValidationsPin();

describe("pinned validation rules (STP-1064)", () => {
  it("match their pin, and were checked against the pinned contract", () => {
    expect(rules.version).toBe(pin.version);
    expect(rules.contractVersion).toBe(pin.contractVersion);
    expect(rules.contractVersion).toBe(contract.info.version);
    expect(pin.repo).toBe(loadPin().repo);
    expect(pin.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("cover every write and destructive tool, and name no other method", () => {
    const stateChanging = contract.methods.filter((m) => exclusionReason(m) === null && safetyClass(m) !== "read").map((m) => m.name);
    expect(Object.keys(rules.methods).sort()).toEqual(stateChanging.sort());
  });

  it("refuse a rule file of another major version", () => {
    const path = join(mkdtempSync(join(tmpdir(), "stp-rules-")), "rules.json");
    writeFileSync(path, JSON.stringify({ ...rules, version: `${SUPPORTED_VALIDATIONS_MAJOR + 1}.0.0` }));
    expect(() => loadValidations(path)).toThrow(/this evaluator reads major version 1/);
  });
});
