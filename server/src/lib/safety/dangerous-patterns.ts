// Dangerous command pattern detection + plain-language risk explanation.
//
// These patterns are evaluated against every shell command the agent wants
// to execute, even commands that have been auto-approved at the tool level.
// A match at severity "destructive" or "irreversible" will force user
// approval, overriding any auto-approve setting.
//
// The pattern list is intentionally simple (regex over a normalised command
// string) and conservative. False positives are fine — false negatives
// (allowing a destructive command through) are not.
//
// References: OWASP A03 (Injection) and the AISI Top 10 for agentic systems
// (ASI02 — Tool Misuse).

export type CommandRiskSeverity = "low" | "medium" | "high" | "destructive" | "irreversible";

export type DangerousPattern = {
  id: string;
  /** Severity, in increasing order of impact. */
  severity: CommandRiskSeverity;
  /** Human-readable one-liner. */
  label: string;
  /** Plain-English explanation the user sees in the approval dialog. */
  explanation: string;
  /** Regex (case-insensitive). Matched against the normalised command. */
  pattern: RegExp;
  /** What to call the action that can occur if the command runs. */
  consequence: string;
};

// ---------------------------------------------------------------------------
// Pattern table. Order is intentional: more specific patterns come first so
// they win over the catch-alls below. The `id` is the stable identifier we
// surface in audit logs and the agent run timeline.
// ---------------------------------------------------------------------------
const PATTERNS: DangerousPattern[] = [
  {
    id: "rm-rf-root",
    severity: "irreversible",
    label: "Recursive delete of root or system directory",
    explanation: "This command will recursively delete files starting from a system-critical location.",
    consequence: "All files in the target directory and its children will be permanently deleted.",
    pattern: /\brm\s+(-\w*r\w*f\w*|--recursive\s+--force|-rf|-fr|-r\s+-f|-f\s+-r)\s+(\/|\.\.|\~\/|\$HOME|\/etc|\/usr|\/var|\/boot|\/sys|\/proc|C:\\Windows)/i
  },
  {
    id: "rm-rf-wildcard",
    severity: "destructive",
    label: "Recursive delete with wildcard or unanchored path",
    explanation: "This command will recursively delete files matching a wildcard. Glob expansion may match more files than the model intended.",
    consequence: "All files matching the wildcard (which may be more than expected) will be permanently deleted.",
    pattern: /\brm\s+(-\w*r\w*f\w*|--recursive\s+--force|-rf|-fr|-r\s+-f|-f\s+-r)\s+\/?\*|\brm\s+(-\w*r\w*f\w*|--recursive\s+--force|-rf|-fr|-r\s+-f|-f\s+-r)\s+\$|\brm\s+(-\w*r\w*f\w*|--recursive\s+--force|-rf|-fr|-r\s+-f|-f\s+-r)\s+\.\s*\*$/i
  },
  {
    id: "rm-rf",
    severity: "high",
    label: "Recursive force delete",
    explanation: "This command will recursively and forcefully delete files. There is no recycle bin to recover from.",
    consequence: "Files at the target path (and all subdirectories) will be permanently deleted.",
    pattern: /\brm\s+(-\w*r\w*f\w*|--recursive\s+--force|-rf|-fr|-r\s+-f|-f\s+-r)\b/i
  },
  {
    id: "dd-disk-overwrite",
    severity: "irreversible",
    label: "Raw disk overwrite with dd",
    explanation: "This command writes data directly to a block device. The targeted disk will have its contents destroyed at the byte level.",
    consequence: "The entire target disk will be overwritten. The operating system and all data will be lost.",
    pattern: /\bdd\s+.*\bof=\/dev\/(sd|hd|nvme|vd|disk)\b/i
  },
  {
    id: "mkfs",
    severity: "irreversible",
    label: "Format filesystem",
    explanation: "This command creates a new filesystem on a device, which erases all existing data on the partition.",
    consequence: "All data on the target device will be lost.",
    pattern: /\bmkfs(\.\w+)?\s+\/dev\//i
  },
  {
    id: "shutdown",
    severity: "high",
    label: "System shutdown or reboot",
    explanation: "This command will shut down or restart the system. Any unsaved work in other applications will be lost.",
    consequence: "The system will become unavailable. Processes and open files may not be saved.",
    pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[0-6])\b/i
  },
  {
    id: "chmod-777",
    severity: "medium",
    label: "World-writable permission change",
    explanation: "This command makes the target file or directory readable, writable, and executable by every user on the system.",
    consequence: "Any user or process will be able to read, modify, or execute the file. This often introduces security vulnerabilities.",
    pattern: /\bchmod\s+(-R\s+)?(0?777|0?666|0?7777)\b/i
  },
  {
    id: "chown-everyone",
    severity: "medium",
    label: "Ownership change to root or current user across many files",
    explanation: "This command recursively changes ownership to root or the current user. Other users or services may lose access.",
    consequence: "Files will be reassigned ownership, which may break services or expose files to unintended users.",
    pattern: /\bchown\s+(-R\s+)?(root|0|:0)\s+(\/|\.\.|\.\s|\.\/)/i
  },
  {
    id: "sudo",
    severity: "medium",
    label: "Sudo / superuser command",
    explanation: "This command runs with elevated privileges via sudo. Any further actions in the command will execute as root.",
    consequence: "The command will be allowed to modify system files, install packages, or change system configuration.",
    pattern: /^\s*sudo\b/i
  },
  {
    id: "curl-pipe-shell",
    severity: "high",
    label: "Download and execute remote script",
    explanation: "This command downloads code from the internet and pipes it directly into a shell. The code is executed without inspection.",
    consequence: "Code from the network will run with the user's full permissions. If the server is compromised, it can run anything on this machine.",
    pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh|fish|pwsh|powershell|cmd|node|python|perl|ruby)/i
  },
  {
    id: "eval-base64",
    severity: "high",
    label: "Decoded payload execution",
    explanation: "This command decodes a base64 blob and executes it. The actual code is hidden from the human reader.",
    consequence: "Obfuscated code will run with the user's full permissions. This is a common malware delivery pattern.",
    pattern: /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh|fish|pwsh|powershell|cmd|node|python|perl|ruby)/i
  },
  {
    id: "git-force-push",
    severity: "high",
    label: "Force push to a branch",
    explanation: "This command will rewrite the history of a remote branch. Other collaborators' unpushed commits may be lost.",
    consequence: "Commits on the remote will be discarded. Team members who pulled the old history will need to reconcile.",
    pattern: /\bgit\s+push\s+[^\n]*\s(--force|-f)\b/i
  },
  {
    id: "git-clean-fdx",
    severity: "high",
    label: "Git clean with force and untracked directories",
    explanation: "This command removes all untracked files and directories from the working tree, including those matched by .gitignore.",
    consequence: "All untracked work-in-progress and ignored files will be permanently deleted.",
    pattern: /\bgit\s+clean\s+[^\n]*\s(-fdx|-fd|-fdxf)\b/i
  },
  {
    id: "git-reset-hard",
    severity: "high",
    label: "Git reset --hard",
    explanation: "This command moves HEAD to a previous commit and discards all uncommitted changes in the working tree and index.",
    consequence: "All uncommitted changes will be lost. Uncommitted work cannot be recovered.",
    pattern: /\bgit\s+reset\s+(--hard)\b/i
  },
  {
    id: "git-checkout-discard",
    severity: "high",
    label: "Git checkout discarding local changes",
    explanation: "This command will overwrite local changes to a file with the version from a commit or branch.",
    consequence: "Any unsaved local changes to the target file will be lost.",
    pattern: /\bgit\s+checkout\s+[^\n]*\s--\s+[^\n]+/i
  },
  {
    id: "npm-publish",
    severity: "high",
    label: "Publish to npm registry",
    explanation: "This command publishes the current package to the npm registry, making it visible to other developers.",
    consequence: "A new version will be publicly released. Unpublishing a published version is restricted by npm policy.",
    pattern: /\bnpm\s+publish\b/i
  },
  {
    id: "docker-rm-all",
    severity: "high",
    label: "Remove all Docker containers or images",
    explanation: "This command removes every Docker container or image on the system.",
    consequence: "All containers or images will be deleted. Any data not in persistent volumes will be lost.",
    pattern: /\bdocker\s+(container|image)\s+prune\s+(-a|--all)|^\s*docker\s+rm\s+(-f\s+)?\$\(docker\s+ps|\bdocker\s+system\s+prune\s+-a\b/i
  },
  {
    id: "drop-table",
    severity: "irreversible",
    label: "Drop database table",
    explanation: "This SQL command drops a table. All data and the table schema are deleted.",
    consequence: "The table and all rows will be permanently removed.",
    pattern: /\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE)\b/i
  },
  {
    id: "sql-without-where",
    severity: "high",
    label: "DELETE or UPDATE without WHERE",
    explanation: "This SQL command modifies or deletes rows without a WHERE clause. It will affect every row in the table.",
    consequence: "Every row in the target table will be deleted or updated.",
    pattern: /\b(DELETE|UPDATE)\b[^\n;]*;\s*$/i
  },
  {
    id: "disk-format",
    severity: "irreversible",
    label: "Format disk partition",
    explanation: "This command formats a disk partition, destroying all data on it.",
    consequence: "All data on the target partition will be lost.",
    pattern: /\b(format\s+[a-zA-Z]:|diskpart\s+clean)\b/i
  },
  {
    id: "registry-delete",
    severity: "irreversible",
    label: "Windows registry key deletion",
    explanation: "This command deletes a Windows registry key. Removing the wrong key can destabilise or break the operating system.",
    consequence: "The targeted registry key (and all subkeys) will be removed. Some changes cannot be undone without a backup.",
    pattern: /\breg\s+delete\b/i
  },
  {
    id: "killall",
    severity: "medium",
    label: "Kill all processes by name",
    explanation: "This command terminates every process matching the given name.",
    consequence: "All processes with the matching name will be terminated. The system may become unstable if critical services are killed.",
    pattern: /\b(killall|pkill\s+-9\s+\S+)\b/i
  }
];

const SEVERITY_RANK: Record<CommandRiskSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  destructive: 3,
  irreversible: 4
};

export type CommandRiskAssessment = {
  command: string;
  matches: Array<{
    pattern: DangerousPattern;
    matchedText: string;
  }>;
  /** Highest severity across all matches. "low" when no patterns matched. */
  severity: CommandRiskSeverity;
  /** True when at least one match is destructive or irreversible. */
  requiresConfirmation: boolean;
  /** Human-readable summary, one line per match. */
  summary: string[];
};

function normaliseForMatching(command: string): string {
  // Collapse multiple spaces but keep newlines, since the agent sometimes
  // sends multi-line scripts. The patterns use [^\n] for spans so the
  // newline handling is fine.
  return command.replace(/[ \t]+/g, " ").trim();
}

export function analyseCommandRisk(command: string): CommandRiskAssessment {
  const normalised = normaliseForMatching(command);
  const matches: CommandRiskAssessment["matches"] = [];
  for (const pattern of PATTERNS) {
    const m = normalised.match(pattern.pattern);
    if (m) {
      matches.push({ pattern, matchedText: m[0] });
    }
  }

  let top: CommandRiskSeverity = "low";
  for (const match of matches) {
    if (SEVERITY_RANK[match.pattern.severity] > SEVERITY_RANK[top]) {
      top = match.pattern.severity;
    }
  }

  return {
    command,
    matches,
    severity: top,
    requiresConfirmation: matches.some(
      (m) => m.pattern.severity === "high" || m.pattern.severity === "destructive" || m.pattern.severity === "irreversible"
    ),
    summary: matches.length === 0
      ? []
      : matches.map((m) => `${m.pattern.label}: ${m.pattern.explanation}`)
  };
}

/**
 * Return all patterns that the tool is allowed to auto-approve. We keep
 * this list empty by default — operators must opt in by listing pattern ids
 * in the agent's auto-approve settings.
 */
export function getDangerousPatternIds(): string[] {
  return PATTERNS.map((p) => p.id);
}

export function getDangerousPatterns(): DangerousPattern[] {
  return [...PATTERNS];
}
