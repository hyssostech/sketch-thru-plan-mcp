#!/usr/bin/env node
// Re-pin the STP OpenRPC contract and the call-validation rules from hyssostech/sketch-thru-plan-sdk-js.
//
//   node scripts/update-contract.mjs [--ref <branch|tag|sha>]                re-pin from GitHub (default: main)
//   node scripts/update-contract.mjs --check [--ref <ref>]                   exit 1 if a pin is behind <ref>
//   node scripts/update-contract.mjs --from-git <sdk-js clone> [--ref <ref>] re-pin from a local clone, with git
//                                                                            (no network; default ref: HEAD)
//
// Each file is pinned to the last commit that touched it, and the pin files record that commit:
// contract/pin.json for the contract, contract/validations-pin.json for the rules and their schema.
// After a re-pin, regenerate the tool snapshot (`npx vitest run -u`) and review its diff: that diff is
// what agents will see change.
//
// Credential-free: both GitHub endpoints are public. GITHUB_TOKEN, when set, only raises the rate limit.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "hyssostech/sketch-thru-plan-sdk-js";
const here = (p) => fileURLToPath(new URL(`../packages/contract-tools/contract/${p}`, import.meta.url));

/** What is pinned: each source path, where its copy goes, and which pin file records it. */
const CONTRACT = { path: "json-api/sketch-thru-plan-api.json", file: here("sketch-thru-plan-api.json") };
const RULES = { path: "json-api/sketch-thru-plan-validations.json", file: here("sketch-thru-plan-validations.json") };
const RULES_SCHEMA = { path: "json-api/sketch-thru-plan-validations.schema.json", file: here("sketch-thru-plan-validations.schema.json") };
const CONTRACT_PIN = here("pin.json");
const RULES_PIN = here("validations-pin.json");

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
  return args[i + 1];
};
const check = args.includes("--check");
const fromGit = valueOf("--from-git");
const ref = valueOf("--ref") ?? (fromGit ? "HEAD" : "main");
if (check && fromGit) throw new Error("--check compares with GitHub; it does not combine with --from-git");

// ---- sources: GitHub, or a local clone through git -----------------------------------------------

const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
async function get(url, accept) {
  const res = await fetch(url, { headers: { ...headers, accept } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}
const git = (...a) => execFileSync("git", ["-C", fromGit, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The last commit at or before `ref` that touched `path`. */
async function lastCommit(path) {
  if (fromGit) {
    const sha = git("log", "-1", "--format=%H", ref, "--", path).trim();
    if (!sha) throw new Error(`${fromGit}@${ref}: no commit touches ${path}`);
    return sha;
  }
  const commits = await (
    await get(`https://api.github.com/repos/${REPO}/commits?sha=${encodeURIComponent(ref)}&path=${path}&per_page=1`, "application/vnd.github+json")
  ).json();
  if (!Array.isArray(commits) || commits.length === 0) throw new Error(`${REPO}@${ref}: no commit touches ${path}`);
  return commits[0].sha;
}

async function content(sha, path) {
  if (fromGit) return git("show", `${sha}:${path}`);
  return (await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${path}`, "application/json")).text();
}

// ---- pin -----------------------------------------------------------------------------------------

const contractSha = await lastCommit(CONTRACT.path);
const contractText = await content(contractSha, CONTRACT.path);
const version = JSON.parse(contractText).info?.version;
if (!version) throw new Error(`${REPO}@${contractSha}: contract has no info.version`);

const rulesSha = await lastCommit(RULES.path);
const rulesText = await content(rulesSha, RULES.path);
const schemaText = await content(rulesSha, RULES_SCHEMA.path);
const rules = JSON.parse(rulesText);
if (rules.contractVersion !== version) {
  throw new Error(
    `${REPO}@${rulesSha.slice(0, 12)}: the validation rules were checked against contract ${rules.contractVersion}, ` +
      `but the contract at ${contractSha.slice(0, 12)} is ${version}; pin a ref where they agree.`,
  );
}

const pins = [
  { what: "contract", file: CONTRACT.file, text: contractText, sha: contractSha, label: `version ${version}` },
  { what: "validation rules", file: RULES.file, text: rulesText, sha: rulesSha, label: `version ${rules.version}` },
  { what: "validation rules schema", file: RULES_SCHEMA.file, text: schemaText, sha: rulesSha, label: "" },
];

if (check) {
  const drift = pins.filter((p) => readFileSync(p.file, "utf8") !== p.text);
  if (drift.length === 0) {
    console.log(`up to date: the pinned contract and validation rules match ${REPO}@${ref}`);
    process.exit(0);
  }
  for (const p of drift) console.error(`DRIFT: the pinned ${p.what} differs from ${REPO}@${ref} (${p.sha.slice(0, 12)}${p.label ? `, ${p.label}` : ""})`);
  console.error("Run `npm run contract:update`, then `npx vitest run -u`, and review the snapshot diff.");
  process.exit(1);
}

for (const p of pins) writeFileSync(p.file, p.text);
const source = fromGit ? `${REPO} (local clone ${fromGit})` : REPO;
writeFileSync(CONTRACT_PIN, JSON.stringify({ repo: REPO, path: CONTRACT.path, ref: contractSha, version }, null, 2) + "\n");
writeFileSync(
  RULES_PIN,
  JSON.stringify(
    { repo: REPO, path: RULES.path, schemaPath: RULES_SCHEMA.path, ref: rulesSha, version: rules.version, contractVersion: rules.contractVersion },
    null,
    2,
  ) + "\n",
);
console.log(
  `pinned ${source}: contract ${contractSha.slice(0, 12)} (version ${version}), validation rules ${rulesSha.slice(0, 12)} ` +
    `(version ${rules.version}). Now run \`npx vitest run -u\` and review the snapshot diff.`,
);
