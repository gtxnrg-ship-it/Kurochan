import { describe, expect, it } from "vitest";
import {
  parseInlineMarkdown,
  parseMarkdown,
  safeMarkdownHref,
} from "../public/markdown.mjs";

describe("safe Markdown parser", () => {
  it("parses headings, paragraphs, lists, quotations, rules and fenced code", () => {
    expect(
      parseMarkdown(
        [
          "# A heading",
          "",
          "A short paragraph",
          "continued on a second line.",
          "",
          "- First",
          "- Second",
          "",
          "> A quoted thought",
          "",
          "```ts",
          "const answer = 42;",
          "```",
          "",
          "---",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "heading", level: 1, value: "A heading" },
      { type: "paragraph", value: "A short paragraph\ncontinued on a second line." },
      { type: "list", ordered: false, items: ["First", "Second"] },
      { type: "quote", value: "A quoted thought" },
      { type: "code-block", language: "ts", value: "const answer = 42;" },
      { type: "rule" },
    ]);
  });

  it("supports inline code, bold, emphasis and safe links", () => {
    expect(parseInlineMarkdown("Use `code`, **bold**, *clear* and [docs](https://example.test/guide).")).toEqual([
      { type: "text", value: "Use " },
      { type: "code", value: "code" },
      { type: "text", value: ", " },
      { type: "strong", children: [{ type: "text", value: "bold" }] },
      { type: "text", value: ", " },
      { type: "emphasis", children: [{ type: "text", value: "clear" }] },
      { type: "text", value: " and " },
      { type: "link", label: "docs", href: "https://example.test/guide" },
      { type: "text", value: "." },
    ]);
  });

  it("rejects script and credential-bearing links", () => {
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(safeMarkdownHref("data:text/html,hello")).toBeNull();
    expect(safeMarkdownHref("https://user:password@example.test")).toBeNull();
    expect(safeMarkdownHref("https://example.test/good")).toBe("https://example.test/good");
    expect(parseInlineMarkdown("[click](javascript:alert(1))").some((token) => token.type === "link")).toBe(false);
  });

  it("keeps HTML-like content as plain text tokens instead of executable markup", () => {
    expect(parseInlineMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      { type: "text", value: "<img src=x onerror=alert(1)>" },
    ]);
  });
});
