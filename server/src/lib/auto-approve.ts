// Auto-approve pattern matching and management

import { prisma } from "./db.js";

export type MatchType = "exact" | "wildcard" | "regex" | "prefix";

export type AutoApprovePattern = {
  id: string;
  name: string;
  pattern: string;
  matchType: MatchType;
  toolName?: string;
  scope: string;
  enabled: boolean;
  useCount: number;
  lastUsedAt: Date | null;
};

/**
 * Check if a command matches a pattern based on match type
 */
export function matchesPattern(command: string, pattern: string, matchType: MatchType): boolean {
  const normalizedCommand = command.trim();
  const normalizedPattern = pattern.trim();

  switch (matchType) {
    case "exact":
      return normalizedCommand === normalizedPattern;

    case "prefix":
      return normalizedCommand.startsWith(normalizedPattern);

    case "wildcard": {
      // Convert wildcard pattern to regex
      // * matches any characters, ? matches single character
      const regexPattern = normalizedPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
        .replace(/\*/g, ".*") // * becomes .*
        .replace(/\?/g, "."); // ? becomes .
      const regex = new RegExp(`^${regexPattern}$`, "i");
      return regex.test(normalizedCommand);
    }

    case "regex": {
      try {
        const regex = new RegExp(normalizedPattern, "i");
        return regex.test(normalizedCommand);
      } catch {
        // Invalid regex pattern, no match
        return false;
      }
    }

    default:
      return false;
  }
}

/**
 * Check if a command should be auto-approved based on stored patterns
 */
export async function shouldAutoApprove(params: {
  userId: string;
  command: string;
  toolName: string;
  workspaceId?: string;
  conversationId?: string;
}): Promise<{ approved: boolean; matchedPattern?: AutoApprovePattern }> {
  const { userId, command, toolName, workspaceId, conversationId } = params;

  // Fetch all enabled patterns for this user with appropriate scope
  const patterns = await prisma.autoApprovePattern.findMany({
    where: {
      userId,
      enabled: true,
      OR: [
        { scope: "global" },
        { scope: "workspace", workspaceId },
        { scope: "conversation", conversationId }
      ]
    },
    orderBy: [
      { scope: "desc" }, // conversation > workspace > global
      { updatedAt: "desc" }
    ]
  });

  // Check each pattern
  for (const pattern of patterns) {
    // If pattern specifies a tool, it must match
    if (pattern.toolName && pattern.toolName !== toolName) {
      continue;
    }

    // Check if command matches the pattern
    if (matchesPattern(command, pattern.pattern, pattern.matchType as MatchType)) {
      // Update usage stats
      await prisma.autoApprovePattern.update({
        where: { id: pattern.id },
        data: {
          useCount: { increment: 1 },
          lastUsedAt: new Date()
        }
      });

      return {
        approved: true,
        matchedPattern: {
          id: pattern.id,
          name: pattern.name,
          pattern: pattern.pattern,
          matchType: pattern.matchType as MatchType,
          toolName: pattern.toolName ?? undefined,
          scope: pattern.scope,
          enabled: pattern.enabled,
          useCount: pattern.useCount + 1,
          lastUsedAt: new Date()
        }
      };
    }
  }

  return { approved: false };
}

/**
 * Suggest a pattern name based on the command
 */
export function suggestPatternName(command: string, toolName: string): string {
  const cmd = command.trim();
  
  // Extract first few words
  const words = cmd.split(/\s+/).slice(0, 3);
  const preview = words.join(" ");
  
  if (preview.length > 40) {
    return `${toolName}: ${preview.slice(0, 37)}...`;
  }
  
  return `${toolName}: ${preview}`;
}

/**
 * Suggest match type based on command characteristics
 */
export function suggestMatchType(command: string): MatchType {
  const cmd = command.trim();
  
  // If command has wildcards or variables, suggest wildcard
  if (cmd.includes("*") || cmd.includes("$") || cmd.includes("{")) {
    return "wildcard";
  }
  
  // If command is very specific (long with specific paths/args), suggest exact
  if (cmd.length > 50 && (cmd.includes("/") || cmd.includes("\\"))) {
    return "exact";
  }
  
  // Default to prefix for common commands
  return "prefix";
}
