#!/usr/bin/env node
// Re-pin the STP OpenRPC contract from hyssostech/sketch-thru-plan-sdk-js.
//
//   node scripts/update-contract.mjs [--ref <branch|tag|sha>]   re-pin (default: main)
//   node scripts/update-contract.mjs --check [--ref <ref>]      exit 1 if the pin is behind <ref>
//
// After a re-pin, regenerate the tool snapshot (`npx vitest run -u`) and review its diff:
// that diff is what agents will see change.
//
// Credential-free: both endpoints are public. GITHUB_TOKEN, when set, only raises the rate limit.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "hyssostech/sketch-thru-plan-sdk-js";
const PATH = "json-api/sketch-thru-plan-api.json";
const contractFile = fileURLToPath(new URL("../packages/contract-tools/contract/sketch-thru-plan-api.json", import.meta.url));
const pinFile = fileURLToPath(new URL("../packages/contract-tools/contract/pin.json", import.meta.url));

const args = process.argv.slice(2);
const check = args.includes("--check");
const refIdx = args.indexOf("--ref");
const ref = refIdx === -1 ? "main" : args[refIdx + 1];
if (!ref) throw new Error("--ref needs a value");

const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

async function get(url, accept) {
  const res = await fetch(url, { headers: { ...headers, accept } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// Resolve the ref to the last commit that touched the contract, so the pin names a commit
// that actually changed it rather than whatever happened to be the branch tip.
const commits = await (
  await get(`https://api.github.com/repos/${REPO}/commits?sha=${encodeURIComponent(ref)}&path=${PATH}&per_page=1`, "application/vnd.github+json")
).json();
if (!Array.isArray(commits) || commits.length === 0) throw new Error(`${REPO}@${ref}: no commit touches ${PATH}`);
const sha = commits[0].sha;

const text = await (await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${PATH}`, "application/json")).text();
const version = JSON.parse(text).info?.version;
if (!version) throw new Error(`${REPO}@${sha}: contract has no info.version`);

const pinned = readFileSync(contractFile, "utf8");
if (check) {
  if (pinned === text) {
    console.log(`up to date: pinned contract matches ${REPO}@${ref} (${sha.slice(0, 12)}, version ${version})`);
    process.exit(0);
  }
  const pin = JSON.parse(readFileSync(pinFile, "utf8"));
  console.error(
    `DRIFT: the pinned contract (version ${pin.version}, ${pin.ref.slice(0, 12)}) differs from ${REPO}@${ref} ` +
      `(version ${version}, ${sha.slice(0, 12)}). Run \`npm run contract:update\`, then \`npx vitest run -u\`, and review the snapshot diff.`,
  );
  process.exit(1);
}

writeFileSync(contractFile, text);
writeFileSync(pinFile, JSON.stringify({ repo: REPO, path: PATH, ref: sha, version }, null, 2) + "\n");
console.log(`pinned ${REPO}@${sha.slice(0, 12)} (version ${version}). Now run \`npx vitest run -u\` and review the snapshot diff.`);
