// Retrieval evaluation for search_docs (STP-1061): recall@5 over eval/search-eval.json.
//
// RECALL_FLOOR is set a little below the score measured when the set was written. It guards the
// answerable questions against regressions from search changes and docs re-pins. Do not lower it to
// make a change pass: fix the ranking, or - if a re-pin genuinely removed an answer - say so in the
// change and update the question's expected sources.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKnowledgeServer } from "../src/server.js";

/** Measured 58/59 = 0.983 on the answerable questions (docs aa83c51, contract 0.4.0). */
const RECALL_FLOOR = 0.95;
const K = 5;

interface Question {
  id: string;
  question: string;
  expected: string[];
  noGoodSource?: boolean;
  gap?: string;
  generatedReference?: string[];
}

const evalSet = JSON.parse(readFileSync(new URL("../eval/search-eval.json", import.meta.url), "utf8")) as {
  questions: Question[];
};
const client = new Client({ name: "eval", version: "0" });

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKnowledgeServer().connect(serverSide);
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
});

/** The distinct pages behind the top-k passages, best first; empty when search_docs refuses. */
async function topPages(query: string): Promise<string[]> {
  const res = await client.callTool({ name: "search_docs", arguments: { query, k: K } });
  if (res.isError) return [];
  const body = JSON.parse((res.content as { text: string }[])[0].text) as { results: { uri: string }[] };
  return [...new Set(body.results.map((r) => r.uri))];
}

describe("search_docs evaluation", () => {
  it("is a well-formed set whose expected sources all exist", async () => {
    const { questions } = evalSet;
    expect(questions.length).toBeGreaterThanOrEqual(40);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    const { resources } = await client.listResources();
    const uris = new Set(resources.map((r) => r.uri));
    for (const q of questions) {
      for (const u of q.expected) expect(uris.has(u), `${q.id}: unknown expected source ${u}`).toBe(true);
      if (q.noGoodSource) expect(q.gap, `${q.id}: a gap question needs a gap note`).toBeTruthy();
      else expect(q.expected.length, `${q.id}: an answerable question needs an expected source`).toBeGreaterThan(0);
    }
  });

  it(`keeps recall@${K} on answerable questions at or above ${RECALL_FLOOR}`, async () => {
    const lines: string[] = [];
    let hits = 0;
    let answerable = 0;
    let hitsAll = 0;
    for (const q of evalSet.questions) {
      const pages = await topPages(q.question);
      const rank = pages.findIndex((u) => q.expected.includes(u));
      if (rank >= 0) hitsAll++;
      if (q.noGoodSource) {
        lines.push(`  gap   ${q.id}: ${q.question}\n        top ${K}: ${pages.join(", ") || "(refused)"}`);
        continue;
      }
      answerable++;
      if (rank >= 0) hits++;
      else lines.push(`  MISS  ${q.id}: ${q.question}\n        expected one of: ${q.expected.join(", ")}\n        got: ${pages.join(", ") || "(refused)"}`);
    }
    const recall = hits / answerable;
    const total = evalSet.questions.length;
    console.log(
      [
        `search_docs recall@${K}: answerable ${hits}/${answerable} = ${recall.toFixed(3)} (floor ${RECALL_FLOOR}); ` +
          `all questions ${hitsAll}/${total} = ${(hitsAll / total).toFixed(3)}; ` +
          `${total - answerable} questions marked as having no good source.`,
        ...lines,
      ].join("\n"),
    );
    expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });
});
