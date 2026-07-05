// §4.5 — Tests for the error-recovery suggestion helpers.

import { describe, expect, it } from "vitest";
import { Suggest, withSuggestions } from "../suggestions.js";

describe("withSuggestions", () => {
  it("attaches suggestions to a failure result", () => {
    const r = withSuggestions({ success: false, error: "boom" }, ["Try X", "Try Y"]);
    expect(r.suggestions).toEqual(["Try X", "Try Y"]);
  });

  it("deduplicates and caps at 5 suggestions", () => {
    const r = withSuggestions(
      { success: false, error: "x" },
      ["A", "B", "C", "A", "B", "D", "E", "F", "G"]
    );
    expect(r.suggestions?.length).toBe(5);
    expect(r.suggestions).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns the original result unchanged when no suggestions are passed", () => {
    const r = withSuggestions({ success: false, error: "x" }, []);
    expect(r.suggestions).toBeUndefined();
  });
});

describe("Suggestion helpers", () => {
  it("Suggest.fileNotFound attaches list_directory + search_files hints", () => {
    const r = Suggest.fileNotFound({ success: false, error: "ENOENT" }, "foo.ts");
    expect(r.suggestions).toBeDefined();
    expect(r.suggestions?.length).toBeGreaterThanOrEqual(1);
    expect(r.suggestions?.some((s) => /list_directory/.test(s))).toBe(true);
  });

  it("Suggest.editNotFound recommends re-read_file first", () => {
    const r = Suggest.editNotFound({ success: false, error: "match not found" }, "old text");
    expect(r.suggestions?.some((s) => /read_file/.test(s))).toBe(true);
  });

  it("Suggest.editAmbiguous mentions the occurrence count", () => {
    const r = Suggest.editAmbiguous({ success: false, error: "ambiguous" }, 3);
    expect(r.suggestions?.some((s) => /3/.test(s))).toBe(true);
  });

  it("Suggest.shellTimeout recommends start_process for long-running commands", () => {
    const r = Suggest.shellTimeout({ success: false, error: "timed out" }, "long-running-build.sh");
    expect(r.suggestions?.some((s) => /start_process|background/i.test(s))).toBe(true);
  });

  it("Suggest.commandNotFound suggests checking the README", () => {
    const r = Suggest.commandNotFound({ success: false, error: "command not found" }, "magic-tool");
    expect(r.suggestions?.some((s) => /README|install/i.test(s))).toBe(true);
  });

  it("Suggest.httpForbidden recommends browser_* as a fallback", () => {
    const r = Suggest.httpForbidden({ success: false, error: "HTTP 403" }, "https://example.com");
    expect(r.suggestions?.some((s) => /browser_/i.test(s))).toBe(true);
  });

  it("Suggest.httpRateLimit suggests waiting or switching keys", () => {
    const r = Suggest.httpRateLimit({ success: false, error: "HTTP 429" }, "https://example.com");
    expect(r.suggestions?.some((s) => /wait|switch/i.test(s))).toBe(true);
  });

  it("Suggest.permissionDenied is generic about permissions", () => {
    const r = Suggest.permissionDenied({ success: false, error: "EACCES" }, "/secret");
    expect(r.suggestions).toBeDefined();
  });

  it("Suggest.generic attaches a single hint verbatim", () => {
    const r = Suggest.generic({ success: false, error: "?" }, "Try calling foo_bar");
    expect(r.suggestions).toEqual(["Try calling foo_bar"]);
  });
});
