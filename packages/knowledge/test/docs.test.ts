import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDocsDir, loadDocs, loadDocsPin, normalizePage } from "../src/docs.js";
import { chunkPage, snippet, stem, tokenize } from "../src/search.js";

const pagesDir = join(defaultDocsDir, "pages");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("pinned docs", () => {
  const pin = loadDocsPin();

  it("names its source and leaves the generated API reference out", () => {
    expect(pin.repo).toBe("hyssostech/stp-docs");
    expect(pin.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.license).toBe("MIT");
    expect(pin.count).toBe(pin.files.length);
    expect(pin.excluded.map((e) => e.path)).toEqual(["docs/api/", "docs/api-net/"]);
    for (const f of pin.files) expect(pin.excluded.some((e) => f.path.startsWith(e.path))).toBe(false);
  });

  it("holds exactly the pinned files, byte-identical to upstream (git blob ids)", () => {
    const onDisk = walk(pagesDir)
      .map((p) => "docs/" + relative(pagesDir, p).split("\\").join("/"))
      .sort();
    expect(onDisk).toEqual(pin.files.map((f) => f.path).sort());
    for (const f of pin.files) {
      const bytes = readFileSync(join(pagesDir, f.path.slice("docs/".length)));
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      expect(blob, f.path).toBe(f.blob);
    }
  });

  it("loads every page with a title and without front matter", () => {
    const { pages } = loadDocs();
    expect(pages.length).toBe(pin.count);
    for (const p of pages) {
      expect(p.uri).toBe(`stp-docs://${p.path}`);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.markdown.startsWith("---")).toBe(false);
      expect(p.markdown).not.toMatch(/^:::/m);
    }
  });
});

describe("normalizePage", () => {
  const raw = [
    "---",
    "id: x",
    "title: The Title",
    "sidebar_position: 2",
    "---",
    "",
    "# Heading",
    "",
    "See [roles](./roles) and [wire](../guides/wire.md#skew) and [web](https://example.com/a.md).",
    "",
    ":::tip Pan and zoom",
    "Hold **Ctrl**.",
    ":::",
    "",
    "<details>",
    "<summary><strong>TaskWhat</strong> - what</summary>",
    "",
    "`Ambush`",
    "",
    "</details>",
    "",
    "```js",
    ":::not an admonition",
    "# not a heading",
    "```",
  ].join("\n");
  const known = new Set(["guides/roles", "guides/wire"]);
  const { title, markdown } = normalizePage(raw, "guides/page", known);

  it("takes the title from the front matter and drops it", () => {
    expect(title).toBe("The Title");
    expect(markdown.startsWith("# Heading")).toBe(true);
  });

  it("points relative links at stp-docs:// resources, leaving others alone", () => {
    expect(markdown).toContain("[roles](stp-docs://guides/roles)");
    expect(markdown).toContain("[wire](stp-docs://guides/wire#skew)");
    expect(markdown).toContain("[web](https://example.com/a.md)");
  });

  it("renders admonitions as block quotes and unwraps details", () => {
    expect(markdown).toContain("> **Tip: Pan and zoom**\n>\n> Hold **Ctrl**.");
    expect(markdown).toContain("**TaskWhat - what**");
    expect(markdown).not.toContain("<details>");
  });

  it("leaves code fences untouched", () => {
    expect(markdown).toContain("```js\n:::not an admonition\n# not a heading\n```");
  });

  it("falls back to the first h1 when there is no front-matter title", () => {
    expect(normalizePage("---\nsidebar_label: Short\n---\n# Long title\n", "p").title).toBe("Long title");
    expect(normalizePage("no heading", "some/path").title).toBe("some/path");
  });
});

describe("chunking and tokenizing", () => {
  it("splits at headings outside code fences and keeps the heading path", () => {
    const chunks = chunkPage({
      path: "p",
      uri: "stp-docs://p",
      source: "docs/p.md",
      title: "Page",
      markdown: "# Page\n\nintro\n\n## A\n\ntext a\n\n```\n## not a heading\n```\n\n### A1\n\ntext a1\n\n## B\n\ntext b\n",
    });
    expect(chunks.map((c) => c.headingPath)).toEqual([["Page"], ["Page", "A"], ["Page", "A", "A1"], ["Page", "B"]]);
    expect(chunks[1].text).toContain("## not a heading");
  });

  it("splits identifiers and stems consistently", () => {
    expect(tokenize("onSymbolAdded")).toEqual([stem("onsymboladded"), "symbol", "add"]);
    expect(tokenize("How do I load the scenarios?")).toEqual(["load", "scenario"]);
    expect(stem("deleted")).toBe(stem("delete"));
    expect(stem("switches")).toBe(stem("switching"));
    expect(stem("C2SIM")).toBe("C2SIM");
  });

  it("snips around the first matching word", () => {
    const text = "word ".repeat(100) + "the target is here " + "tail ".repeat(100);
    const s = snippet(text, ["target"]);
    expect(s).toContain("target");
    expect(s.startsWith("...")).toBe(true);
    expect(s.length).toBeLessThan(260);
  });
});
