// Self-healing tool-call harness (research C3).
//
// When a tool call fails with a "validation" error, instead of just returning
// a terse error message, build a structured correction envelope the model can
// use to re-emit a correct call. Inspired by the AutoBe + Typia pattern that
// lifted Qwen 3.5 from 6.75% to 99.8% tool-call success on the Qwen Korea
// meetup benchmark.

import type { ToolDefinition, ToolResult } from "../tools.js";

export type SchemaCorrection = {
  rule: string;
  message: string;
  /** The corrected shape the model should emit. */
  expectedSchema: {
    toolName: string;
    parameters: Record<
      string,
      { type: string; required: boolean; description?: string }
    >;
  };
  /** An example of a correct payload. */
  example?: Record<string, unknown>;
};

/**
 * Build a structured correction for a validation error. Returns null if the
 * error is not a validation-style error (in which case retry won't help).
 */
export function buildSchemaCorrection(
  toolName: string,
  toolDefinition: ToolDefinition | undefined,
  previousParameters: Record<string, unknown>,
  result: ToolResult
): SchemaCorrection | null {
  if (result.errorCategory !== "validation") return null;
  if (!toolDefinition) return null;

  const parameters: SchemaCorrection["expectedSchema"]["parameters"] = {};
  for (const [name, param] of Object.entries(toolDefinition.parameters)) {
    parameters[name] = {
      type: param.type,
      required: param.required === true,
      description: param.description
    };
  }

  return {
    rule: "schema_correction",
    message:
      `Tool call validation failed for ${toolName}.\n`
      + `Error: ${result.error ?? "unknown validation error"}\n`
      + `Please re-emit the ${toolName} call with parameters matching the schema below.`,
    expectedSchema: {
      toolName,
      parameters
    },
    example: previousParameters
  };
}

/**
 * Render a correction as a single string suitable for stuffing back into the
 * model's history as a user/system message.
 */
export function renderSchemaCorrection(correction: SchemaCorrection): string {
  const lines: string[] = [correction.message, ""];
  lines.push("Required parameters:");
  for (const [name, param] of Object.entries(correction.expectedSchema.parameters)) {
    const req = param.required ? "(required)" : "(optional)";
    lines.push(`  - ${name}: ${param.type} ${req}${param.description ? " — " + param.description : ""}`);
  }
  if (correction.example) {
    lines.push("");
    lines.push("Previous (invalid) attempt:");
    lines.push(JSON.stringify(correction.example, null, 2));
  }
  return lines.join("\n");
}
