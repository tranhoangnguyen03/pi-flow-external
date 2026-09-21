import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderOutputText } from "../src/core/subagent-render.ts";

describe("renderOutputText", () => {
  it("renders literal text unchanged when no host theme has been initialized, rather than throwing", () => {
    // No initTheme() call in this test: exercises the exact state a headless
    // caller, an RPC render, or (deliberately, here) an uninitialized test
    // harness is in. getMarkdownTheme()'s underlying theme singleton throws
    // on first access in that state; renderOutputText must swallow that and
    // fall back to plain text rather than crash the tool card.
    const component = renderOutputText("Architecture mapped. No `code` here.");
    expect(() => component.render(80)).not.toThrow();
    expect(component.render(80).join("\n")).toContain("Architecture mapped. No `code` here.");
  });

  it("renders real Markdown once a host theme is available", () => {
    initTheme("dark");
    const component = renderOutputText("**bold answer**");
    const rendered = component.render(80).join("\n");
    // Markdown-rendered bold applies ANSI styling around the text rather
    // than leaving the literal ** markers in the output.
    expect(rendered).not.toContain("**bold answer**");
    expect(rendered).toContain("bold answer");
  });

  it("indents via paddingX the same way the plain-text fallback does", () => {
    const component = renderOutputText("line one\nline two", 4);
    const lines = component.render(80);
    expect(lines.every((line) => line.startsWith("    "))).toBe(true);
  });
});
