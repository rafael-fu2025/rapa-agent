// Quick CLI: build the system prompt with all registered tools and print
// the byte/line counts. Used to verify that the per-tool refactor didn't
// blow the context budget.
//
// Run with: npx tsx src/scripts/measure-prompt.ts
import { buildSystemPrompt } from "../lib/agent/prompt-builder.js";
import { registerAllTools, toolRegistry } from "../tools/index.js";

registerAllTools();
const tools = toolRegistry.list();
const prompt = buildSystemPrompt(tools, 12, "agent");

const bytes = Buffer.byteLength(prompt, "utf8");
const lines = prompt.split("\n").length;
const words = prompt.split(/\s+/).length;
// Rough token estimate: 1 token ≈ 4 chars for English
const tokens = Math.ceil(prompt.length / 4);

console.log("System prompt (agent mode, 12 iterations, all 30 tools):");
console.log(`  bytes:  ${bytes}`);
console.log(`  lines:  ${lines}`);
console.log(`  words:  ${words}`);
console.log(`  ~tokens: ${tokens}`);
console.log("");
console.log("First 5 lines:");
console.log(prompt.split("\n").slice(0, 5).join("\n"));
console.log("");
console.log("Sample tool section (read_file):");
const toolRefStart = prompt.indexOf("## TOOL REFERENCE");
const sample = prompt.slice(toolRefStart, toolRefStart + 1500);
console.log(sample);
console.log("...truncated...");
console.log("");
console.log(`Tool reference section length: ${prompt.length - toolRefStart} chars`);
