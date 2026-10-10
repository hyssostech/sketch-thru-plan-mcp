import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the pinned docs came from (written by scripts/update-docs.mjs). */
export interface DocsPin {
  repo: string;
  /** Directory of the source repo the pages were taken from ("docs"). */
  path: string;
  ref: string;
  license: string;
  count: number;
  excluded: { path: string; reason: string }[];
  /** Source paths (e.g. docs/guides/roles.md) with their git blob ids. */
  files: { path: string; blob: string }[];
}

/** One docs page, as the knowledge server serves it. */
export interface DocPage {
  /** Path below docs/ without the extension, e.g. guides/roles. */
  path: string;
  /** stp-docs://<path> */
  uri: string;
  /** Source path in the docs repo, e.g. docs/guides/roles.md. */
  source: string;
  title: string;
  /** The page with Docusaurus front matter and MDX/admonition syntax turned into plain Markdown. */
  markdown: string;
}

export interface DocsCorpus {
  pin: DocsPin;
  pages: DocPage[];
}

export const DOCS_SCHEME = "stp-docs://";

export const defaultDocsDir = fileURLToPath(new URL("../stp-docs/", import.meta.url));

/** The canonical (URL-normalized) resource URI of a page, as resources/read looks it up. */
export function docUri(path: string): string {
  return new URL(DOCS_SCHEME + path).href;
}

export function loadDocsPin(dir: string = defaultDocsDir): DocsPin {
  return JSON.parse(readFileSync(join(dir, "pin.json"), "utf8")) as DocsPin;
}

/** Loads the pinned pages listed in pin.json and normalizes them. */
export function loadDocs(dir: string = defaultDocsDir): DocsCorpus {
  const pin = loadDocsPin(dir);
  const prefix = pin.path + "/";
  const paths = pin.files.map((f) => {
    if (!f.path.startsWith(prefix)) throw new Error(`docs pin: ${f.path} is not under ${prefix}`);
    return f.path.slice(prefix.length);
  });
  const known = new Set(paths.map(stripExtension));
  const pages = pin.files.map((f, i) => {
    const raw = readFileSync(join(dir, "pages", paths[i]), "utf8");
    const path = stripExtension(paths[i]);
    const { title, markdown } = normalizePage(raw, path, known, paths[i].endsWith(".mdx"));
    return { path, uri: docUri(path), source: f.path, title, markdown };
  });
  return { pin, pages };
}

function stripExtension(path: string): string {
  return path.replace(/\.mdx?$/, "");
}

interface FrontMatter {
  [key: string]: string;
}

function splitFrontMatter(raw: string): { front: FrontMatter; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { front: {}, body: text };
  const front: FrontMatter = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return { front, body: text.slice(m[0].length) };
}

const ADMONITION_OPEN = /^(\s*):::(\w+)(?:\[(.*?)\]|\s+(.*?))?\s*$/;
const ADMONITION_CLOSE = /^\s*:::\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Resolves a relative Markdown link to an stp-docs:// URI when it points at a pinned page. */
function rewriteLink(target: string, pagePath: string, known: Set<string>): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return target;
  const hash = target.indexOf("#");
  const file = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? "" : target.slice(hash);
  const parts = pagePath.split("/").slice(0, -1);
  for (const seg of stripExtension(file).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const resolved = parts.join("/");
  return known.has(resolved) ? docUri(resolved) + anchor : target;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Turns a Docusaurus page into plain Markdown a model can read: drops the front matter (keeping its
 * title), renders admonitions (:::tip ... :::) as block quotes, unwraps <details>/<summary>, drops MDX
 * import/export lines, and points relative links at the stp-docs:// resource of the target page.
 * Code fences are left untouched.
 */
export function normalizePage(
  raw: string,
  pagePath: string,
  known: Set<string> = new Set(),
  mdx = false,
): { title: string; markdown: string } {
  const { front, body } = splitFrontMatter(raw);
  const out: string[] = [];
  let fence: string | null = null;
  let quoteDepth = 0;
  let firstH1: string | undefined;

  for (const line of body.split("\n")) {
    const prefix = "> ".repeat(quoteDepth);
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      out.push(prefix + line);
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(prefix + line);
      continue;
    }
    const open = ADMONITION_OPEN.exec(line);
    if (open) {
      const label = capitalize(open[2]);
      const title = (open[3] ?? open[4] ?? "").trim();
      out.push(prefix + `> **${title ? `${label}: ${title}` : label}**`);
      out.push(prefix + ">");
      quoteDepth++;
      continue;
    }
    if (ADMONITION_CLOSE.test(line) && quoteDepth > 0) {
      quoteDepth--;
      continue;
    }
    if (/^\s*<\/?details>\s*$/.test(line)) continue;
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    if (mdx && /^(import|export)\s/.test(line)) continue;
    let text = line;
    const summary = /^\s*<summary>(.*)<\/summary>\s*$/.exec(text);
    if (summary) text = `**${summary[1].replace(/<[^>]+>/g, "").replace(/\*\*/g, "").trim()}**`;
    text = text.replace(/\]\(([^)\s]+)\)/g, (_m, target: string) => `](${rewriteLink(target, pagePath, known)})`);
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(text);
    if (h1 && firstH1 === undefined) firstH1 = h1[1];
    out.push(text === "" && quoteDepth > 0 ? prefix.trimEnd() : prefix + text);
  }

  const markdown = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = front.title || firstH1 || front.sidebar_label || pagePath;
  return { title, markdown: markdown + "\n" };
}
