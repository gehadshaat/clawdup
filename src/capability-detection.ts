// Capability detection module.
// Analyzes project structure and task content to determine which
// Claude Code tools, agents, and skills are appropriate for a task.
//
// This enables clawdup to dynamically expand Claude's capabilities
// beyond the minimal safe default when the project or task warrants it.

import { existsSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { PROJECT_ROOT, GIT_ROOT } from "./config.js";
import { log } from "./logger.js";
import type {
  ToolProfileName,
  CapabilityHint,
  CapabilityAnalysis,
  ClickUpTask,
} from "./types.js";

/**
 * Tools available in each named profile.
 * Profiles are cumulative: each higher tier includes all tools from lower tiers.
 */
export const TOOL_PROFILES: Record<ToolProfileName, string[]> = {
  minimal: ["Edit", "Write", "Read", "Glob", "Grep", "Bash"],
  standard: [
    "Edit",
    "Write",
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "Task",
    "WebFetch",
    "WebSearch",
  ],
  full: [
    "Edit",
    "Write",
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "Task",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
  ],
  custom: [], // populated from user config
};

/**
 * File extension patterns that suggest specific tools would be useful.
 */
const PROJECT_FILE_HINTS: Array<{
  glob: string;
  tool: string;
  reason: string;
}> = [
  {
    glob: "**/*.ipynb",
    tool: "NotebookEdit",
    reason: "Project contains Jupyter notebooks",
  },
];

/**
 * Task description keywords that suggest specific tools would be useful.
 * Patterns are matched case-insensitively against the task name + description.
 */
const TASK_KEYWORD_HINTS: Array<{
  patterns: RegExp[];
  tool: string;
  reason: string;
}> = [
  {
    patterns: [/\bresearch\b/i, /\binvestigat/i, /\bexplor/i, /\banalyz/i],
    tool: "Task",
    reason: "Task involves research or exploration (sub-agents can parallelize)",
  },
  {
    patterns: [/\bweb\s*search/i, /\blook\s*up\b/i, /\bfind\s*online\b/i, /\bdocumentation\b/i],
    tool: "WebSearch",
    reason: "Task may require web search for documentation or references",
  },
  {
    patterns: [/\bfetch\s*url\b/i, /\bdownload\b/i, /\bapi\s*docs?\b/i, /\bweb\s*page\b/i],
    tool: "WebFetch",
    reason: "Task may require fetching content from URLs",
  },
  {
    patterns: [/\bnotebook\b/i, /\bjupyter\b/i, /\.ipynb\b/i],
    tool: "NotebookEdit",
    reason: "Task involves Jupyter notebook editing",
  },
  {
    patterns: [
      /\blarge\s*(code)?base\b/i,
      /\bmulti.?file\b/i,
      /\brefactor/i,
      /\barchitect/i,
      /\bdesign\b/i,
      /\bmany\s*files?\b/i,
    ],
    tool: "Task",
    reason: "Task scope suggests sub-agents for parallel exploration",
  },
];

/**
 * Detect project-level capability hints by checking for specific file types.
 * Uses git ls-files for speed when available, falls back to filesystem checks.
 */
function detectProjectHints(): CapabilityHint[] {
  const hints: CapabilityHint[] = [];

  for (const { glob, tool, reason } of PROJECT_FILE_HINTS) {
    if (hasFilesMatching(glob)) {
      hints.push({ tool, reason });
    }
  }

  // Check if project has many files (suggests sub-agents would help)
  const fileCount = estimateProjectFileCount();
  if (fileCount > 500) {
    hints.push({
      tool: "Task",
      reason: `Large project (~${fileCount} tracked files) — sub-agents can parallelize exploration`,
    });
  }

  return hints;
}

/**
 * Detect task-level capability hints from the task name and description.
 */
function detectTaskHints(task: ClickUpTask): CapabilityHint[] {
  const hints: CapabilityHint[] = [];
  const searchText = `${task.name} ${task.description || ""} ${task.text_content || ""}`;

  for (const { patterns, tool, reason } of TASK_KEYWORD_HINTS) {
    if (patterns.some((p) => p.test(searchText))) {
      hints.push({ tool, reason });
    }
  }

  return hints;
}

/**
 * Check if the project contains files matching a glob pattern.
 * Uses git ls-files for tracked files (fast), ignores untracked.
 */
function hasFilesMatching(pattern: string): boolean {
  try {
    const result = execFileSync(
      "git",
      ["ls-files", "--cached", "--", pattern],
      {
        cwd: GIT_ROOT,
        encoding: "utf-8",
        timeout: 5000,
      },
    );
    return result.trim().length > 0;
  } catch {
    // Fallback: check common locations directly
    const simplePattern = pattern.replace("**/", "").replace("*.", ".");
    const candidates = [
      resolve(PROJECT_ROOT, simplePattern),
      resolve(GIT_ROOT, simplePattern),
    ];
    return candidates.some((p) => existsSync(p));
  }
}

/**
 * Estimate the number of tracked files in the project.
 */
function estimateProjectFileCount(): number {
  try {
    const result = execFileSync(
      "git",
      ["ls-files", "--cached"],
      {
        cwd: GIT_ROOT,
        encoding: "utf-8",
        timeout: 10000,
      },
    );
    return result.trim().split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Deduplicate hints, keeping the first occurrence of each tool.
 */
function deduplicateHints(hints: CapabilityHint[]): CapabilityHint[] {
  const seen = new Set<string>();
  const result: CapabilityHint[] = [];
  for (const hint of hints) {
    if (!seen.has(hint.tool)) {
      seen.add(hint.tool);
      result.push(hint);
    }
  }
  return result;
}

/**
 * Determine the minimum profile that includes all the recommended tools.
 */
function recommendProfile(tools: string[]): ToolProfileName {
  const minimalSet = new Set(TOOL_PROFILES.minimal);
  const standardSet = new Set(TOOL_PROFILES.standard);

  // Check if minimal covers everything
  if (tools.every((t) => minimalSet.has(t))) {
    return "minimal";
  }

  // Check if standard covers everything
  if (tools.every((t) => standardSet.has(t))) {
    return "standard";
  }

  // Need full profile
  return "full";
}

/**
 * Analyze a project and task to detect which Claude Code capabilities are needed.
 * Returns capability hints, recommended tools, and the appropriate tool profile.
 */
export function analyzeCapabilities(task: ClickUpTask): CapabilityAnalysis {
  const projectHints = detectProjectHints();
  const taskHints = detectTaskHints(task);
  const allHints = deduplicateHints([...projectHints, ...taskHints]);

  // Start with minimal tools and add detected ones
  const toolSet = new Set(TOOL_PROFILES.minimal);
  for (const hint of allHints) {
    toolSet.add(hint.tool);
  }

  const recommendedTools = Array.from(toolSet);
  const recommendedProfile = recommendProfile(recommendedTools);

  if (allHints.length > 0) {
    log("info", `Capability analysis detected ${allHints.length} hint(s):`);
    for (const hint of allHints) {
      log("info", `  + ${hint.tool}: ${hint.reason}`);
    }
    log("info", `Recommended profile: ${recommendedProfile}`);
  } else {
    log("debug", `No additional capabilities detected — using minimal profile`);
  }

  return {
    detectedHints: allHints,
    recommendedTools,
    recommendedProfile,
  };
}

/**
 * Resolve the final set of allowed tools based on:
 * 1. User config (highest priority — explicit override)
 * 2. Capability analysis (auto-detected recommendations)
 * 3. Default (minimal profile)
 *
 * @param configProfile - Profile from user config (CLAUDE_TOOL_PROFILE env or config file)
 * @param configTools - Explicit tool list from user config (overrides profile)
 * @param analysis - Auto-detected capability analysis (optional)
 */
export function resolveAllowedTools(
  configProfile: ToolProfileName | undefined,
  configTools: string[] | undefined,
  analysis?: CapabilityAnalysis,
): string[] {
  // Explicit custom tool list takes highest priority
  if (configTools && configTools.length > 0) {
    log("debug", `Using custom allowed tools from config: ${configTools.join(", ")}`);
    return configTools;
  }

  // Explicit profile from config
  if (configProfile && configProfile !== "custom") {
    const tools = TOOL_PROFILES[configProfile];
    if (tools) {
      log("debug", `Using tool profile '${configProfile}' from config: ${tools.join(", ")}`);
      return tools;
    }
  }

  // Auto-detected recommendations
  if (analysis && analysis.recommendedProfile !== "minimal") {
    log("debug", `Using auto-detected tools: ${analysis.recommendedTools.join(", ")}`);
    return analysis.recommendedTools;
  }

  // Default: minimal profile
  return TOOL_PROFILES.minimal;
}

/**
 * Build a capability guidance section for the system prompt.
 * When additional tools beyond minimal are available, this tells Claude
 * what extra capabilities it has and when to use them.
 */
export function buildCapabilityGuidance(
  allowedTools: string[],
  hints: CapabilityHint[],
): string {
  const minimalSet = new Set(TOOL_PROFILES.minimal);
  const extraTools = allowedTools.filter((t) => !minimalSet.has(t));

  if (extraTools.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push("\n## Available Capabilities");
  lines.push("");
  lines.push(
    "In addition to standard file editing and shell tools, you have access to:",
  );

  if (extraTools.includes("Task")) {
    lines.push(
      "- **Task (Sub-agents)**: Spawn specialized sub-agents for parallel work. Use the Task tool with subagent_type to delegate:",
    );
    lines.push(
      '  - `Explore`: Fast codebase exploration — searching files, reading code, answering questions about architecture.',
    );
    lines.push(
      '  - `Plan`: Design implementation plans before writing code — identifies critical files and trade-offs.',
    );
    lines.push(
      '  - `general-purpose`: Complex multi-step research or code search tasks.',
    );
    lines.push(
      "  Use sub-agents when the task requires exploring a large codebase, researching multiple files, or parallelizing independent queries.",
    );
  }

  if (extraTools.includes("WebSearch")) {
    lines.push(
      "- **WebSearch**: Search the web for documentation, API references, or current information. Use when you need up-to-date info beyond your training data.",
    );
  }

  if (extraTools.includes("WebFetch")) {
    lines.push(
      "- **WebFetch**: Fetch and analyze content from URLs. Use for reading documentation pages, API specs, or reference material linked in the task.",
    );
  }

  if (extraTools.includes("NotebookEdit")) {
    lines.push(
      "- **NotebookEdit**: Edit Jupyter notebook cells directly. Use when modifying .ipynb files.",
    );
  }

  if (hints.length > 0) {
    lines.push("");
    lines.push("**Why these capabilities were enabled:**");
    for (const hint of hints) {
      lines.push(`- ${hint.reason}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
