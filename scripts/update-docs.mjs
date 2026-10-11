#!/usr/bin/env node
// Re-pin the public STP docs (hyssostech/stp-docs, docs/**/*.md) into packages/knowledge/stp-docs.
//
//   node scripts/update-docs.mjs [--ref <branch|tag|sha>]                re-pin from GitHub (default: main)
//   node scripts/update-docs.mjs --check [--ref <ref>]                   exit 1 if the pin differs from <ref>
//   node scripts/update-docs.mjs --from-git <stp-docs clone> [--ref <ref>] re-pin from a local clone, with git
//                                                                        (no network; default ref: HEAD)
//
// The pages are copied verbatim; the knowledge server strips Docusaurus front matter and admonition
// syntax when it loads them (packages/knowledge/src/docs.ts), so the pinned copy stays byte-identical
// to upstream and its git blob ids in pin.json can be checked against the source repo.
//
// The generated API reference (docs/api, docs/api-net: TypeDoc / .NET reference pages) is left out on
// purpose - see EXCLUDED below and the README.
//
// Fetches with git (no GitHub API, no credentials): the docs repo is public. --from-git reads a local
// clone instead, for a branch not pushed yet or a machine without access to github.com; the pin still
// names hyssostech/stp-docs and the resolved commit, so re-pin from GitHub once that commit is merged.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "hyssostech/stp-docs";
const URL_ = `https://github.com/${REPO}.git`;
const DOCS = "docs";
const EXCLUDED = [
  {
    path: "docs/api/",
    reason:
      "generated TypeDoc reference for the JS SDK; measured to lower search recall (STP-1061), and the JSON-RPC contract is indexed instead",
  },
  {
    path: "docs/api-net/",
    reason:
      "generated reference for the .NET SDK; measured to lower search recall (STP-1061), and the JSON-RPC contract is indexed instead",
  },
];

const root = fileURLToPath(new URL("../packages/knowledge/stp-docs/", import.meta.url));
const pagesDir = join(root, "pages");
const pinFile = join(root, "pin.json");

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

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const gitBytes = (cwd, ...a) => execFileSync("git", a, { cwd, maxBuffer: 64 * 1024 * 1024 });

const work = fromGit ?? mkdtempSync(join(tmpdir(), "stp-docs-"));
try {
  // Blobless clone: resolves any branch, tag or sha; only the pinned pages' blobs are fetched.
  if (!fromGit) git(work, "clone", "--quiet", "--filter=blob:none", "--no-checkout", URL_, ".");
  let tip;
  // A local clone names its own branches without origin/; try the plain ref first there.
  const candidates = fromGit ? [ref, `origin/${ref}`] : [`origin/${ref}`, ref];
  for (const candidate of candidates) {
    try {
      tip = git(work, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
      break;
    } catch {
      // try the next spelling
    }
  }
  if (!tip) throw new Error(`${fromGit ?? REPO}: cannot resolve ref '${ref}'`);
  // Pin the resolved commit itself (it carries the repo's LICENSE); --check compares pages, not shas,
  // so commits that leave docs/ alone never show up as drift.
  const sha = tip;

  const files = git(work, "ls-tree", "-r", sha, "--", DOCS)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { path, blob: meta.split(" ")[2] };
    })
    .filter((f) => /\.mdx?$/.test(f.path))
    .filter((f) => !EXCLUDED.some((e) => f.path.startsWith(e.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) throw new Error(`${REPO}@${sha}: no pages under ${DOCS}/`);

  if (check) {
    const pin = JSON.parse(readFileSync(pinFile, "utf8"));
    const key = (list) => list.map((f) => `${f.path} ${f.blob}`).join("\n");
    if (key(pin.files) === key(files)) {
      console.log(`up to date: pinned docs match ${REPO}@${ref} (${sha.slice(0, 12)}, ${files.length} pages)`);
      process.exit(0);
    }
    console.error(
      `DRIFT: the pinned docs (${pin.ref.slice(0, 12)}, ${pin.count} pages) differ from ${REPO}@${ref} ` +
        `(${sha.slice(0, 12)}, ${files.length} pages). Run \`npm run docs:update\`, then \`npm test\`, and review the diff ` +
        "(including the search evaluation score).",
    );
    process.exit(1);
  }

  // Read each page from its blob, never from a working tree: a local clone's checkout may differ from
  // the pinned commit (another branch, uncommitted edits).
  const pages = files.map((f) => ({ ...f, bytes: fromGit ? gitBytes(work, "cat-file", "blob", f.blob) : null }));
  if (!fromGit) git(work, "checkout", "--quiet", sha, "--", ...files.map((f) => f.path));
  rmSync(pagesDir, { recursive: true, force: true });
  for (const f of pages) {
    const target = join(pagesDir, f.path.slice(DOCS.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes ?? readFileSync(join(work, f.path)));
  }
  const pin = { repo: REPO, path: DOCS, ref: sha, license: "MIT", count: files.length, excluded: EXCLUDED, files };
  writeFileSync(pinFile, JSON.stringify(pin, null, 2) + "\n");
  const source = fromGit ? `${REPO} (local clone ${fromGit})` : REPO;
  console.log(`pinned ${source}@${sha.slice(0, 12)} (${files.length} pages). Now run \`npm test\` and review the diff.`);
} finally {
  if (!fromGit) rmSync(work, { recursive: true, force: true });
}
