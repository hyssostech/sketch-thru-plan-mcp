// Lexical search over the STP docs and the contract: heading-sized chunks ranked with BM25.
// Deliberately dependency-free and deterministic, so the evaluation score is reproducible.
import type { Contract, ContractEvent, ContractMethod } from "stp-mcp-contract-tools";
import { exclusionReason } from "stp-mcp-contract-tools";
import type { DocPage } from "./docs.js";

export type ChunkKind = "doc" | "method" | "event";

/** A searchable passage: a page section under one heading, or one contract method or event. */
export interface Chunk {
  uri: string;
  kind: ChunkKind;
  /** Title of the page (or contract entry) the passage belongs to. */
  title: string;
  /** Headings from the page title down to this passage's own heading. */
  headingPath: string[];
  /** The passage text, as Markdown. */
  text: string;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
  snippet: string;
}

export const API_SCHEME = "stp-api://";

/** Canonical (URL-normalized) resource URIs of contract entries, as resources/read looks them up. */
export function methodUri(name: string): string {
  return new URL(`${API_SCHEME}method/${name}`).href;
}

export function eventUri(name: string): string {
  return new URL(`${API_SCHEME}event/${name}`).href;
}

// ---------------------------------------------------------------------------------------------
// Tokenizing

const STOPWORDS = new Set(
  (
    "a about after all also an and any are as at be been before being but by can could did do does doing " +
    "done for from get gets got had has have having here how i if in into is it its just me my need no not " +
    "of on once only or other our out own same should so some such than that the their them then there these " +
    "they this those through to too under until up use used using very want was we were what when where " +
    "which while who whom why will with would you your"
  ).split(" "),
);

/** A light suffix stemmer: consistent rather than linguistically exact, applied to docs and queries alike. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (/(ss|us|is)$/.test(w)) {
    // class, status, analysis: not plurals
  } else if (/(ches|shes|xes|sses)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && /([bdgmnpt])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** Splits identifiers as well as prose: "onSymbolAdded" yields onsymboladded, symbol, add. */
function words(text: string): { raw: string; word: string; parts: string[] }[] {
  const out: { raw: string; word: string; parts: string[] }[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    const raw = m[0];
    const parts = raw
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ")
      .map((p) => p.toLowerCase());
    out.push({ raw, word: raw.toLowerCase(), parts: parts.length > 1 ? parts : [] });
  }
  return out;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const { word, parts } of words(text)) {
    for (const t of [word, ...parts]) {
      if (t.length < 2 && !/\d/.test(t)) continue;
      if (STOPWORDS.has(t)) continue;
      tokens.push(stem(t));
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Chunking

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Splits a page at its headings (h1-h4), outside code fences. Each section keeps its heading path. */
export function chunkPage(page: DocPage): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let body: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = body.join("\n").trim();
    if (text) {
      chunks.push({
        uri: page.uri,
        kind: "doc",
        title: page.title,
        headingPath: path.length > 0 ? [...path] : [page.title],
        text,
      });
    }
    body = [];
  };

  for (const line of page.markdown.split("\n")) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[1] === fence) fence = null;
      body.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      body.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      path.length = Math.min(path.length, level - 1);
      while (path.length < level - 1) path.push(path.length === 0 ? page.title : "");
      path.push(h[2].replace(/[`*_]/g, ""));
      continue;
    }
    body.push(line);
  }
  flush();
  // Empty intermediate levels (an h3 straight under the h1) are dropped from the displayed path.
  for (const c of chunks) c.headingPath = c.headingPath.filter(Boolean);
  return chunks;
}

function paramLines(entry: ContractMethod | ContractEvent): string[] {
  return (entry.params ?? []).map((p) => `- \`${p.name}\`${p.description ? `: ${p.description}` : ""}`);
}

/** One passage per contract method and event: name, description, params and availability. */
export function contractChunks(contract: Contract): Chunk[] {
  const chunks: Chunk[] = [];
  for (const m of contract.methods) {
    const reason = exclusionReason(m);
    const lines = [m.description ?? "", "", "Params:", ...paramLines(m)];
    if (m.result) lines.push("", `Result: \`${m.result.name}\`${m.result.description ? ` - ${m.result.description}` : ""}`);
    if (reason) lines.push("", `Not available: ${reason}.`);
    chunks.push({
      uri: methodUri(m.name),
      kind: "method",
      title: `${m.name} (STP API method)`,
      headingPath: ["STP JSON-RPC API", "Methods", m.name],
      text: lines.join("\n").trim(),
    });
  }
  for (const e of contract["x-stpEvents"] ?? []) {
    chunks.push({
      uri: eventUri(e.name),
      kind: "event",
      title: `${e.name} (STP API event)`,
      headingPath: ["STP JSON-RPC API", "Events", e.name],
      text: [e.description ?? "", "", "Params:", ...paramLines(e)].join("\n").trim(),
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// BM25

const K1 = 1.2;
const B = 0.75;
/** Title and heading words count this many times: a section named for the query is the best answer. */
const HEADING_WEIGHT = 2;
/** At most this many passages per page in one result list, so a long page cannot crowd out the rest. */
export const MAX_PER_PAGE = 2;

interface IndexedChunk {
  chunk: Chunk;
  tf: Map<string, number>;
  length: number;
}

/** Markdown reduced to readable text, for snippets. */
function plain(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, " ")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[|*`#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit distance with adjacent transpositions (optimal string alignment); stops early past max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

export class SearchIndex {
  readonly chunks: Chunk[];
  private readonly indexed: IndexedChunk[];
  private readonly df = new Map<string, number>();
  /** The most frequent surface word for each term, to phrase suggestions readably. */
  private readonly surface = new Map<string, Map<string, number>>();
  private readonly avgLength: number;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.indexed = chunks.map((chunk) => {
      const tokens = [
        ...Array<string[]>(HEADING_WEIGHT).fill(tokenize([chunk.title, ...chunk.headingPath].join(" "))).flat(),
        ...tokenize(chunk.text),
      ];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.recordSurface([chunk.title, ...chunk.headingPath, chunk.text].join("\n"));
      return { chunk, tf, length: tokens.length };
    });
    this.avgLength = this.indexed.reduce((n, c) => n + c.length, 0) / Math.max(1, this.indexed.length);
  }

  private recordSurface(text: string) {
    for (const { raw, word, parts } of words(text)) {
      // Identifiers keep their spelling (LoadNewScenario); their parts and prose words are lower case.
      const forms: [string, string][] = [[word, parts.length > 0 ? raw : word], ...parts.map((p): [string, string] => [p, p])];
      for (const [w, shown] of forms) {
        if (w.length < 3 || STOPWORDS.has(w)) continue;
        const t = stem(w);
        const seen = this.surface.get(t) ?? new Map<string, number>();
        seen.set(shown, (seen.get(shown) ?? 0) + 1);
        this.surface.set(t, seen);
      }
    }
  }

  private idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.indexed.length - n + 0.5) / (n + 0.5));
  }

  /** The searchable terms of a query (stopwords and punctuation removed, stemmed, de-duplicated). */
  queryTerms(query: string): string[] {
    return [...new Set(tokenize(query))];
  }

  /** Query terms that occur nowhere in the index. */
  unknownTerms(query: string): string[] {
    return this.queryTerms(query).filter((t) => !this.df.has(t));
  }

  /** Ranked passages, best first, at most MAX_PER_PAGE from any one page. Empty when no term matches. */
  search(query: string, k: number): SearchHit[] {
    const terms = this.queryTerms(query);
    const scored: { c: IndexedChunk; score: number }[] = [];
    for (const c of this.indexed) {
      let score = 0;
      for (const t of terms) {
        const f = c.tf.get(t);
        if (!f) continue;
        score += (this.idf(t) * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * c.length) / this.avgLength));
      }
      if (score > 0) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score || a.c.chunk.uri.localeCompare(b.c.chunk.uri));
    const perPage = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const { c, score } of scored) {
      const n = perPage.get(c.chunk.uri) ?? 0;
      if (n >= MAX_PER_PAGE) continue;
      perPage.set(c.chunk.uri, n + 1);
      hits.push({ chunk: c.chunk, score: Math.round(score * 1000) / 1000, snippet: snippet(c.chunk.text, terms) });
      if (hits.length >= k) break;
    }
    return hits;
  }

  /** Indexed words close to the query words the index does not know (typos, other spellings). */
  suggest(query: string, max = 5): string[] {
    const out: string[] = [];
    for (const { word, parts } of words(query)) {
      for (const w of [word, ...parts]) {
        const s = stem(w);
        if (w.length < 4 || STOPWORDS.has(w) || this.df.has(s)) continue;
        const budget = s.length >= 8 ? 2 : 1;
        const close = [...this.surface.entries()]
          .map(([term, forms]) => ({ forms, d: editDistance(s, term, budget), df: this.df.get(term) ?? 0 }))
          .filter((x) => x.d <= budget && x.df > 0)
          .sort((a, b) => a.d - b.d || b.df - a.df)
          .slice(0, 2);
        for (const { forms } of close) {
          const best = [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
          if (!out.includes(best)) out.push(best);
          if (out.length >= max) return out;
        }
      }
    }
    return out;
  }
}

const SNIPPET_LENGTH = 240;

/** A window of the passage around the first query term it contains. */
export function snippet(markdown: string, terms: string[]): string {
  const text = plain(markdown);
  const wanted = new Set(terms);
  let at = 0;
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    if (tokenize(m[0]).some((t) => wanted.has(t))) {
      at = m.index ?? 0;
      break;
    }
  }
  let start = Math.max(0, at - 60);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    start = space === -1 || space > at ? start : space + 1;
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > at) end = space;
  }
  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}
