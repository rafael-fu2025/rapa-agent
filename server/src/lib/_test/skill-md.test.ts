import { describe, it, expect } from "vitest";
import { parseSkillMd, stringifySkillMd, discoverSkillsInDir } from "../skill-md.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseSkillMd", () => {
  it("parses a minimal valid SKILL.md", () => {
    const source = [
      "---",
      "name: my-skill",
      "description: A short summary of what this skill does.",
      "---",
      "",
      "# My Skill",
      "",
      "Body content goes here."
    ].join("\n");
    const parsed = parseSkillMd(source);
    expect(parsed.frontmatter.name).toBe("my-skill");
    expect(parsed.frontmatter.description).toBe("A short summary of what this skill does.");
    expect(parsed.body).toBe("# My Skill\n\nBody content goes here.");
  });

  it("parses context: fork", () => {
    const source = [
      "---",
      "name: explore",
      "description: Subagent that explores the codebase.",
      "context: fork",
      "---",
      "",
      "Body."
    ].join("\n");
    const parsed = parseSkillMd(source);
    expect(parsed.frontmatter.context).toBe("fork");
  });

  it("rejects context: anything-but-fork", () => {
    const source = [
      "---",
      "name: explore",
      "description: Subagent that explores the codebase.",
      "context: main",
      "---",
      "Body."
    ].join("\n");
    expect(() => parseSkillMd(source)).toThrow(/context/);
  });

  it("rejects non-kebab-case names", () => {
    const source = [
      "---",
      "name: MySkill",
      "description: Invalid name.",
      "---",
      "Body."
    ].join("\n");
    expect(() => parseSkillMd(source)).toThrow(/kebab-case/);
  });

  it("rejects descriptions over 1024 chars", () => {
    const source = [
      "---",
      "name: huge",
      `description: ${"x".repeat(1025)}`,
      "---",
      "Body."
    ].join("\n");
    expect(() => parseSkillMd(source)).toThrow(/1024/);
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseSkillMd("# Just markdown\n\nNo frontmatter.")).toThrow(/frontmatter/);
  });

  it("rejects unclosed frontmatter", () => {
    const source = "---\nname: x\ndescription: y\n\nBody without closing ---";
    expect(() => parseSkillMd(source)).toThrow(/closing/);
  });

  it("rejects missing description", () => {
    const source = "---\nname: x\n---\nBody.";
    expect(() => parseSkillMd(source)).toThrow(/description/);
  });

  it("preserves quoted description values", () => {
    const source = [
      "---",
      "name: quote-test",
      "description: \"Value with: colons and quotes\"",
      "---",
      "Body."
    ].join("\n");
    const parsed = parseSkillMd(source);
    expect(parsed.frontmatter.description).toBe("Value with: colons and quotes");
  });
});

describe("stringifySkillMd", () => {
  it("round-trips a SKILL.md document", () => {
    const original = {
      name: "round-trip",
      description: "Tests round-tripping.",
      body: "Body content."
    };
    const text = stringifySkillMd(original);
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.name).toBe("round-trip");
    expect(parsed.frontmatter.description).toBe("Tests round-tripping.");
    expect(parsed.body).toBe("Body content.");
  });

  it("quotes descriptions containing colons", () => {
    const text = stringifySkillMd({
      name: "with-colon",
      description: "Key: value pairs allowed",
      body: "body"
    });
    expect(text).toContain("description: \"Key: value pairs allowed\"");
  });
});

describe("discoverSkillsInDir", () => {
  it("finds SKILL.md files in a directory tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-md-test-"));
    try {
      await mkdir(join(root, "nested"));
      await mkdir(join(root, "broken"));
      await writeFile(join(root, "SKILL.md"), [
        "---",
        "name: skill-a",
        "description: First skill.",
        "---",
        "Body A."
      ].join("\n"));
      await writeFile(join(root, "nested", "skill.md"), [
        "---",
        "name: skill-b",
        "description: Nested skill.",
        "---",
        "Body B."
      ].join("\n"));
      await writeFile(join(root, "broken", "SKILL.md"), "not-a-skill-md");
      const found = await discoverSkillsInDir(root);
      const names = found.map((f) => f.skill.name).sort();
      expect(names).toEqual(["skill-a", "skill-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
