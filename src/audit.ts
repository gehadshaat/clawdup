// Backlog audit module.
// Analyzes ClickUp tasks for duplicates, stale items, and overlaps.
// Groups tasks by theme and generates an actionable report.

import { getAllTasks, getTaskComments, getCommentText, addTaskComment, updateTask } from "./clickup-api.js";
import { STATUS, DRY_RUN } from "./config.js";
import { log } from "./logger.js";
import type { ClickUpTask, ClickUpComment } from "./types.js";

// Theme keywords used to group tasks
const THEME_KEYWORDS: Record<string, string[]> = {
  docs: ["doc", "readme", "documentation", "guide", "template", "onboarding"],
  ci: ["ci", "pipeline", "workflow", "github actions", "dry-run", "dry run"],
  telemetry: ["metric", "telemetry", "logging", "log", "monitor", "observability"],
  safety: ["safety", "security", "injection", "sanitiz", "prompt injection", "boundary"],
  testing: ["test", "coverage", "spec", "assertion"],
  config: ["config", "configuration", "env", "environment", "setup", "init"],
  pr: ["pr", "pull request", "review", "merge", "branch"],
  claude: ["claude", "worker", "prompt", "llm", "ai"],
  ux: ["ux", "cli", "output", "format", "display", "ui"],
  error: ["error", "retry", "fallback", "resilience", "recovery", "timeout"],
};

export interface AuditTask {
  id: string;
  name: string;
  url: string;
  status: string;
  tags: string[];
  themes: string[];
  dateCreated: Date;
  description: string;
}

export interface DuplicateGroup {
  reason: string;
  tasks: AuditTask[];
}

export interface AuditReport {
  totalTasks: number;
  improvementTasks: number;
  tasksByStatus: Record<string, AuditTask[]>;
  tasksByTheme: Record<string, AuditTask[]>;
  potentialDuplicates: DuplicateGroup[];
  staleTasks: AuditTask[];
  untaggedTasks: AuditTask[];
  recommendations: string[];
}

/**
 * Convert a ClickUp task to an AuditTask with computed fields.
 */
function toAuditTask(task: ClickUpTask): AuditTask {
  const name = task.name.toLowerCase();
  const description = (task.text_content || task.description || "").toLowerCase();
  const combined = `${name} ${description}`;

  const themes: string[] = [];
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (keywords.some((kw) => combined.includes(kw))) {
      themes.push(theme);
    }
  }

  return {
    id: task.id,
    name: task.name,
    url: task.url,
    status: task.status?.status || "unknown",
    tags: (task.tags || []).map((t) => t.name),
    themes,
    dateCreated: task.date_created ? new Date(parseInt(task.date_created)) : new Date(),
    description: task.text_content || task.description || "",
  };
}

/**
 * Calculate token overlap similarity between two strings.
 * Returns a value between 0 (no overlap) and 1 (identical tokens).
 */
function tokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap++;
  }

  return overlap / Math.max(tokensA.size, tokensB.size);
}

/**
 * Find potential duplicate task groups by comparing titles and descriptions.
 */
function findDuplicates(tasks: AuditTask[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const used = new Set<string>();

  for (let i = 0; i < tasks.length; i++) {
    if (used.has(tasks[i]!.id)) continue;

    const similar: AuditTask[] = [];
    for (let j = i + 1; j < tasks.length; j++) {
      if (used.has(tasks[j]!.id)) continue;

      const titleSim = tokenSimilarity(tasks[i]!.name, tasks[j]!.name);
      const descSim = tokenSimilarity(tasks[i]!.description, tasks[j]!.description);
      // Weight title similarity more heavily
      const combined = titleSim * 0.7 + descSim * 0.3;

      if (combined > 0.5 || titleSim > 0.6) {
        similar.push(tasks[j]!);
        used.add(tasks[j]!.id);
      }
    }

    if (similar.length > 0) {
      used.add(tasks[i]!.id);
      groups.push({
        reason: `Similar titles/descriptions (${similar.length + 1} tasks)`,
        tasks: [tasks[i]!, ...similar],
      });
    }
  }

  return groups;
}

/**
 * Find tasks that appear stale based on status and age.
 * "Stale" means: in review for >14 days, or in progress for >7 days,
 * or in require input for >14 days.
 */
function findStaleTasks(tasks: AuditTask[]): AuditTask[] {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  return tasks.filter((task) => {
    const ageMs = now - task.dateCreated.getTime();
    const ageDays = ageMs / DAY_MS;
    const status = task.status.toLowerCase();

    if (status === STATUS.IN_REVIEW.toLowerCase() && ageDays > 14) return true;
    if (status === STATUS.IN_PROGRESS.toLowerCase() && ageDays > 7) return true;
    if (status === STATUS.REQUIRE_INPUT.toLowerCase() && ageDays > 14) return true;
    if (status === STATUS.BLOCKED.toLowerCase() && ageDays > 14) return true;
    return false;
  });
}

/**
 * Run a full backlog audit and return the report.
 */
export async function runAudit(): Promise<AuditReport> {
  log("info", "Starting backlog audit...");

  const allTasks = await getAllTasks(false);
  const auditTasks = allTasks.map(toAuditTask);

  // Filter for improvement-tagged tasks
  const improvementTasks = auditTasks.filter((t) =>
    t.tags.some((tag) => tag.toLowerCase() === "improvement"),
  );

  log("info", `Total open tasks: ${auditTasks.length}, improvement-tagged: ${improvementTasks.length}`);

  // Group by status
  const tasksByStatus: Record<string, AuditTask[]> = {};
  for (const task of auditTasks) {
    const status = task.status.toLowerCase();
    if (!tasksByStatus[status]) tasksByStatus[status] = [];
    tasksByStatus[status]!.push(task);
  }

  // Group by theme
  const tasksByTheme: Record<string, AuditTask[]> = {};
  for (const task of auditTasks) {
    if (task.themes.length === 0) {
      if (!tasksByTheme["uncategorized"]) tasksByTheme["uncategorized"] = [];
      tasksByTheme["uncategorized"]!.push(task);
    }
    for (const theme of task.themes) {
      if (!tasksByTheme[theme]) tasksByTheme[theme] = [];
      tasksByTheme[theme]!.push(task);
    }
  }

  // Find duplicates (among improvement tasks primarily, but check all)
  const potentialDuplicates = findDuplicates(auditTasks);

  // Find stale tasks
  const staleTasks = findStaleTasks(auditTasks);

  // Find tasks without the improvement tag that might need it
  const untaggedTasks = auditTasks.filter(
    (t) => t.tags.length === 0,
  );

  // Generate recommendations
  const recommendations: string[] = [];

  if (potentialDuplicates.length > 0) {
    recommendations.push(
      `Found ${potentialDuplicates.length} group(s) of potentially duplicative tasks. Review and merge or close duplicates.`,
    );
  }

  if (staleTasks.length > 0) {
    recommendations.push(
      `Found ${staleTasks.length} stale task(s) that may need attention or closure.`,
    );
  }

  if (untaggedTasks.length > 0) {
    recommendations.push(
      `Found ${untaggedTasks.length} task(s) without any tags. Consider adding the "improvement" tag or relevant area tags.`,
    );
  }

  const largeThemes = Object.entries(tasksByTheme)
    .filter(([, tasks]) => tasks.length > 5)
    .map(([theme, tasks]) => `${theme} (${tasks.length})`);
  if (largeThemes.length > 0) {
    recommendations.push(
      `Themes with many tasks: ${largeThemes.join(", ")}. Consider consolidating within these areas.`,
    );
  }

  return {
    totalTasks: auditTasks.length,
    improvementTasks: improvementTasks.length,
    tasksByStatus,
    tasksByTheme,
    potentialDuplicates,
    staleTasks,
    untaggedTasks,
    recommendations,
  };
}

/**
 * Format the audit report as a human-readable markdown string.
 */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];

  lines.push("# Backlog Audit Report");
  lines.push("");
  lines.push(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  lines.push(`**Total open tasks:** ${report.totalTasks}`);
  lines.push(`**Improvement-tagged:** ${report.improvementTasks}`);
  lines.push("");

  // Status breakdown
  lines.push("## Tasks by Status");
  lines.push("");
  for (const [status, tasks] of Object.entries(report.tasksByStatus).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    lines.push(`- **${status}**: ${tasks.length} task(s)`);
  }
  lines.push("");

  // Theme breakdown
  lines.push("## Tasks by Theme");
  lines.push("");
  for (const [theme, tasks] of Object.entries(report.tasksByTheme).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    lines.push(`### ${theme} (${tasks.length})`);
    for (const task of tasks) {
      lines.push(`- [${task.name}](${task.url}) — *${task.status}*`);
    }
    lines.push("");
  }

  // Potential duplicates
  if (report.potentialDuplicates.length > 0) {
    lines.push("## Potential Duplicates");
    lines.push("");
    for (const group of report.potentialDuplicates) {
      lines.push(`### ${group.reason}`);
      for (const task of group.tasks) {
        lines.push(`- [${task.name}](${task.url}) — *${task.status}*`);
      }
      lines.push("");
    }
  }

  // Stale tasks
  if (report.staleTasks.length > 0) {
    lines.push("## Stale Tasks");
    lines.push("");
    lines.push("Tasks that may need attention based on their status and age:");
    lines.push("");
    for (const task of report.staleTasks) {
      const age = Math.floor(
        (Date.now() - task.dateCreated.getTime()) / (24 * 60 * 60 * 1000),
      );
      lines.push(
        `- [${task.name}](${task.url}) — *${task.status}* (created ${age} days ago)`,
      );
    }
    lines.push("");
  }

  // Untagged tasks
  if (report.untaggedTasks.length > 0) {
    lines.push("## Untagged Tasks");
    lines.push("");
    lines.push("Tasks without any tags — consider adding relevant tags:");
    lines.push("");
    for (const task of report.untaggedTasks) {
      lines.push(`- [${task.name}](${task.url}) — *${task.status}*`);
    }
    lines.push("");
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  // Grooming patterns
  lines.push("## Grooming Patterns for Future Audits");
  lines.push("");
  lines.push("When performing future backlog cleanup:");
  lines.push("1. **Filter by improvement tag** — focus on tasks tagged `improvement`");
  lines.push("2. **Group by theme** — use keywords to cluster related tasks (docs, CI, safety, etc.)");
  lines.push("3. **Check for duplicates** — compare titles with >50% token overlap");
  lines.push("4. **Review stale items** — tasks in review >14 days or blocked >14 days likely need action");
  lines.push("5. **Tag consistently** — ensure all tasks have at least one tag for discoverability");
  lines.push("6. **Tighten scopes** — vague tasks should be updated with clear acceptance criteria");
  lines.push("");

  return lines.join("\n");
}

/**
 * Run the audit and print the report to stdout.
 * Optionally writes comments to stale/duplicate tasks.
 */
export async function runAuditAndReport(options: {
  annotate?: boolean;
}): Promise<void> {
  const report = await runAudit();
  const formatted = formatAuditReport(report);

  console.log(formatted);

  if (options.annotate) {
    log("info", "Annotating stale tasks with audit comments...");

    for (const task of report.staleTasks) {
      const comment =
        `🔍 Backlog audit: This task has been in "${task.status}" status since ${task.dateCreated.toISOString().split("T")[0]}. ` +
        `Please review whether it is still relevant and actionable, or if it should be closed/updated.`;
      await addTaskComment(task.id, comment);
      log("info", `Commented on stale task: ${task.name} (${task.id})`);
    }

    for (const group of report.potentialDuplicates) {
      const taskList = group.tasks
        .map((t) => `- ${t.name} (${t.url})`)
        .join("\n");
      for (const task of group.tasks) {
        const comment =
          `🔍 Backlog audit: This task may overlap with other tasks:\n${taskList}\n\n` +
          `Consider merging these into a single, well-scoped task or closing duplicates.`;
        await addTaskComment(task.id, comment);
        log("info", `Commented on potential duplicate: ${task.name} (${task.id})`);
      }
    }

    log("info", "Audit annotations complete.");
  }

  // Summary
  console.log("\n---");
  console.log(
    `Audit complete. ${report.totalTasks} total tasks, ` +
    `${report.potentialDuplicates.length} duplicate group(s), ` +
    `${report.staleTasks.length} stale task(s), ` +
    `${report.untaggedTasks.length} untagged task(s).`,
  );
  if (!options.annotate) {
    console.log("Run with --annotate to add audit comments to tasks in ClickUp.");
  }
}
