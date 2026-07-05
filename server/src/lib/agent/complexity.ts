// §5.3 — Adaptive stall detection.
//
// Estimate task complexity from the user's first message and scale the
// stall-detection thresholds accordingly. Simple tasks ("rename this
// function") get tight thresholds so we don't burn turns; complex tasks
// ("migrate the auth system to OAuth2") get loose thresholds so we
// don't bail mid-migration.
//
// Scoring inputs:
//   - Prompt length (longer = more complex)
//   - Number of distinct file paths mentioned
//   - Heavy-action verbs ("refactor", "migrate", "rewrite", "build", "implement")
//   - Code-fence count (suggests the user pasted source)
//   - Question marks (more questions → more complex)
//
// Output: a complexity score in [0, 1] plus a human label.

export type ComplexityAssessment = {
  score: number;
  label: "trivial" | "simple" | "moderate" | "complex" | "very-complex";
  /** Suggested multiplier for the agent's stall thresholds. */
  thresholdMultiplier: number;
  signals: {
    length: number;
    filePathCount: number;
    heavyVerbCount: number;
    codeFenceCount: number;
    questionCount: number;
  };
};

const HEAVY_VERBS = [
  "refactor", "rewrite", "migrate", "redesign", "rebuild", "rearchitect",
  "build", "implement", "design", "create", "develop", "architect",
  "transform", "convert", "port", "modernize", "restructure",
  "add.*support", "introduce", "integrate", "wire up", "bootstrap",
  "rename", "extract", "split", "merge", "consolidate", "split.*up",
  "all", "every", "entire", "complete", "comprehensive", "full"
];

export function estimateComplexity(
  prompt: string,
  seedHistory?: Array<{ role: string; content: string | null | unknown }>
): ComplexityAssessment {
  const haystack = [prompt, ...((seedHistory ?? []).map((m) => (typeof m.content === "string" ? m.content : "")))].join("\n");
  const lower = haystack.toLowerCase();

  const length = haystack.length;
  // File paths are at least 5 chars and contain a `/` or `\` or `.`
  const filePathMatches = haystack.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,5}/g) ?? [];
  const filePathCount = filePathMatches.length;
  const codeFenceCount = (haystack.match(/```/g) ?? []).length / 2;
  const questionCount = (haystack.match(/\?/g) ?? []).length;

  let heavyVerbCount = 0;
  for (const verb of HEAVY_VERBS) {
    if (verb.includes(".*")) {
      const re = new RegExp(verb, "i");
      if (re.test(lower)) heavyVerbCount += 1;
    } else if (new RegExp(`\\b${verb}\\b`, "i").test(lower)) {
      heavyVerbCount += 1;
    }
  }

  // Weighted score. Tune by hand based on observed workloads.
  // - Length up to 4k chars saturates the length axis
  // - 6+ file paths is "many files"
  // - 3+ heavy verbs is "complex intent"
  const lengthScore = Math.min(1, length / 4000);
  const fileScore = Math.min(1, filePathCount / 6);
  const verbScore = Math.min(1, heavyVerbCount / 3);
  const codeScore = Math.min(1, codeFenceCount / 2);
  const questionScore = Math.min(1, questionCount / 3);

  const score = Math.max(
    lengthScore,
    0.5 * fileScore + 0.3 * verbScore + 0.2 * codeScore,
    0.6 * verbScore + 0.4 * fileScore
  );
  const clamped = Math.max(0, Math.min(1, score));

  let label: ComplexityAssessment["label"];
  let thresholdMultiplier: number;
  if (clamped < 0.1) { label = "trivial"; thresholdMultiplier = 0.5; }
  else if (clamped < 0.3) { label = "simple"; thresholdMultiplier = 0.75; }
  else if (clamped < 0.6) { label = "moderate"; thresholdMultiplier = 1.0; }
  else if (clamped < 0.8) { label = "complex"; thresholdMultiplier = 1.4; }
  else { label = "very-complex"; thresholdMultiplier = 1.75; }

  return {
    score: Number(clamped.toFixed(3)),
    label,
    thresholdMultiplier,
    signals: {
      length,
      filePathCount,
      heavyVerbCount,
      codeFenceCount,
      questionCount
    }
  };
}

/**
 * Scale a threshold constant by the multiplier, rounded to the nearest
 * integer with a minimum of 1.
 */
export function scaleThreshold(base: number, multiplier: number): number {
  return Math.max(1, Math.round(base * multiplier));
}
