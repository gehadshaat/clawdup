// ClickUp API v2 client
// Docs: https://clickup.com/api

import { CLICKUP_API_TOKEN, CLICKUP_LIST_ID, CLICKUP_PARENT_TASK_ID, STATUS, DRY_RUN } from "./config.js";
import { log } from "./logger.js";
import type { ClickUpTask, ClickUpUser, ClickUpList, ClickUpComment, ClickUpDependency } from "./types.js";

const BASE_URL = "https://api.clickup.com/api/v2";

/**
 * Extract plain text from a ClickUp comment.
 * Tries `comment_text` first, then falls back to extracting text
 * from the `comment` rich-text block array.
 */
export function getCommentText(comment: ClickUpComment): string {
  if (comment.comment_text && comment.comment_text.trim()) {
    return comment.comment_text;
  }
  if (comment.comment && Array.isArray(comment.comment)) {
    return comment.comment
      .map((block) => block.text || "")
      .join("")
      .trim();
  }
  return "";
}

async function request<T>(
  method: string,
  path: string,
  body: Record<string, unknown> | null = null,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  log("debug", `ClickUp API: ${method} ${path}`);

  const res = await fetch(url, opts);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `ClickUp API error ${res.status} ${method} ${path}: ${text}`,
    );
  }

  return text ? (JSON.parse(text) as T) : (null as T);
}

// Cache the resolved list ID when using parent task mode
let resolvedListId: string | null = null;

/**
 * Get the effective list ID.
 * In list mode, returns CLICKUP_LIST_ID directly.
 * In parent task mode, fetches the parent task to determine its list.
 */
async function getEffectiveListId(): Promise<string> {
  if (CLICKUP_LIST_ID) return CLICKUP_LIST_ID;
  if (resolvedListId) return resolvedListId;

  const parent = await request<ClickUpTask>(
    "GET",
    `/task/${CLICKUP_PARENT_TASK_ID}`,
  );
  if (!parent.list?.id) {
    throw new Error(
      "Could not determine list ID from parent task. Ensure the parent task exists.",
    );
  }
  resolvedListId = parent.list.id;
  return resolvedListId;
}

/**
 * Sort tasks by priority (urgent first) then by date created (oldest first).
 */
function sortByPriorityAndDate(tasks: ClickUpTask[]): void {
  tasks.sort((a, b) => {
    const pa = a.priority ? parseInt(a.priority.id) : 99;
    const pb = b.priority ? parseInt(b.priority.id) : 99;
    if (pa !== pb) return pa - pb;
    const da = a.date_created ? parseInt(a.date_created) : 0;
    const db = b.date_created ? parseInt(b.date_created) : 0;
    return da - db;
  });
}

/**
 * Get all tasks in the configured list with a specific status.
 * Returns tasks sorted by priority (urgent first) then by date created.
 */
async function getListTasksByStatus(status: string): Promise<ClickUpTask[]> {
  const listId = await getEffectiveListId();
  const params = new URLSearchParams({
    include_closed: "false",
    subtasks: "true",
    order_by: "created",
    reverse: "false",
  });
  params.append("statuses[]", status);

  const data = await request<{ tasks: ClickUpTask[] }>(
    "GET",
    `/list/${listId}/task?${params.toString()}`,
  );
  const tasks = data.tasks || [];
  sortByPriorityAndDate(tasks);

  log(
    "info",
    `Found ${tasks.length} task(s) with status "${status}" in list ${listId}`,
  );
  return tasks;
}

/**
 * Get subtasks of the configured parent task that match a specific status.
 * Fetches the parent task with subtasks, filters by status, then fetches
 * full details for each matching subtask.
 */
async function getParentSubtasksByStatus(status: string): Promise<ClickUpTask[]> {
  const parent = await request<ClickUpTask>(
    "GET",
    `/task/${CLICKUP_PARENT_TASK_ID}?include_subtasks=true`,
  );

  const subtasks = parent.subtasks || [];
  const matching = subtasks.filter(
    (s) => s.status?.status?.toLowerCase() === status.toLowerCase(),
  );

  // Fetch full details for each matching subtask
  const fullTasks: ClickUpTask[] = [];
  for (const sub of matching) {
    const task = await getTask(sub.id);
    fullTasks.push(task);
  }

  sortByPriorityAndDate(fullTasks);

  log(
    "info",
    `Found ${fullTasks.length} subtask(s) with status "${status}" under parent task ${CLICKUP_PARENT_TASK_ID}`,
  );
  return fullTasks;
}

/**
 * Get tasks with a specific status.
 * In list mode, queries the configured list.
 * In parent task mode, queries subtasks of the configured parent task.
 */
export async function getTasksByStatus(status: string): Promise<ClickUpTask[]> {
  if (CLICKUP_PARENT_TASK_ID) {
    return getParentSubtasksByStatus(status);
  }
  return getListTasksByStatus(status);
}

/**
 * Get a single task by ID.
 */
export async function getTask(taskId: string): Promise<ClickUpTask> {
  return request<ClickUpTask>("GET", `/task/${taskId}`);
}

/**
 * Get dependencies for a task.
 * Returns both `dependencies` (tasks this task blocks) and `waiting_on` (tasks this task waits on).
 */
export async function getTaskDependencies(
  taskId: string,
): Promise<{ dependencies: ClickUpDependency[]; waitingOn: ClickUpDependency[] }> {
  try {
    const data = await request<{
      dependencies: ClickUpDependency[];
      waiting_on: ClickUpDependency[];
    }>("GET", `/task/${taskId}/dependency`);
    return {
      dependencies: data.dependencies || [],
      waitingOn: data.waiting_on || [],
    };
  } catch (err) {
    const message = (err as Error).message || "";
    // The dependency endpoint may not exist for all ClickUp plans or task types.
    // Treat 404 as "no dependencies" rather than a failure.
    if (message.includes("404")) {
      log("debug", `Dependency endpoint not available for task ${taskId}, treating as no dependencies`);
      return { dependencies: [], waitingOn: [] };
    }
    throw err;
  }
}

/**
 * Check if a task has unresolved dependencies (tasks it's waiting on that aren't completed).
 * Returns an array of { id, name, status } for each unresolved dependency.
 * Returns an empty array if all dependencies are resolved.
 */
export async function getUnresolvedDependencies(
  taskId: string,
): Promise<Array<{ id: string; name: string; status: string }>> {
  const { waitingOn } = await getTaskDependencies(taskId);

  if (waitingOn.length === 0) return [];

  const unresolved: Array<{ id: string; name: string; status: string }> = [];

  for (const dep of waitingOn) {
    try {
      const depTask = await getTask(dep.depends_on);
      const status = depTask.status?.status?.toLowerCase() || "";
      if (status !== STATUS.COMPLETED.toLowerCase()) {
        unresolved.push({
          id: depTask.id,
          name: depTask.name,
          status: depTask.status?.status || "unknown",
        });
      }
    } catch (err) {
      log("warn", `Could not fetch dependency task ${dep.depends_on}: ${(err as Error).message}`);
      // Treat unreachable dependencies as unresolved to be safe
      unresolved.push({
        id: dep.depends_on,
        name: "(unknown)",
        status: "unreachable",
      });
    }
  }

  return unresolved;
}

/**
 * Update a task's status.
 */
export async function updateTaskStatus(
  taskId: string,
  newStatus: string,
): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would update task ${taskId} status → "${newStatus}"`);
    return;
  }
  log("info", `Updating task ${taskId} status to "${newStatus}"`);
  await request("PUT", `/task/${taskId}`, {
    status: newStatus,
  });
}

/**
 * Add a comment to a task.
 */
export async function addTaskComment(
  taskId: string,
  commentText: string,
): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would add comment to task ${taskId}: ${commentText.slice(0, 100)}...`);
    return;
  }
  log("info", `Adding comment to task ${taskId}`);
  await request("POST", `/task/${taskId}/comment`, {
    comment_text: commentText,
    notify_all: true,
  });
}

/**
 * Add a comment to a task directed at a specific user.
 * Uses the `assignee` field to ensure the user receives a notification.
 */
export async function addTaskCommentForUser(
  taskId: string,
  commentText: string,
  assigneeId: number,
): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would add comment to task ${taskId} for user ${assigneeId}: ${commentText.slice(0, 100)}...`);
    return;
  }
  log("info", `Adding comment to task ${taskId} (assigned to user ${assigneeId})`);
  await request("POST", `/task/${taskId}/comment`, {
    comment_text: commentText,
    assignee: assigneeId,
    notify_all: false,
  });
}

/**
 * Notify the task creator with a comment.
 * Falls back to a regular comment if no creator info is available.
 */
export async function notifyTaskCreator(
  taskId: string,
  creator: ClickUpUser | undefined,
  commentText: string,
): Promise<void> {
  if (creator?.id) {
    const mention = creator.username ? `@${creator.username} ` : "";
    await addTaskCommentForUser(taskId, `${mention}${commentText}`, creator.id);
  } else {
    await addTaskComment(taskId, commentText);
  }
}

/**
 * Get comments on a task.
 */
export async function getTaskComments(
  taskId: string,
): Promise<ClickUpComment[]> {
  const data = await request<{ comments: ClickUpComment[] }>(
    "GET",
    `/task/${taskId}/comment`,
  );
  return data.comments || [];
}

/**
 * Find the PR URL from a task's comments.
 * The automation posts a comment with the PR URL when it creates one.
 * Returns the URL string or null if not found.
 */
export async function findPRUrlInComments(
  taskId: string,
): Promise<string | null> {
  const comments = await getTaskComments(taskId);
  // Search comments newest-first for a GitHub PR URL
  const prUrlPattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = getCommentText(comments[i]!);
    const match = text.match(prUrlPattern);
    if (match) {
      return match[0]!;
    }
  }
  return null;
}

/**
 * Get the names of all non-closed tasks in the configured list/parent.
 * Used for deduplication when creating follow-up tasks via .clawdup.todo.json.
 * Returns a Set of lowercased, trimmed task names.
 */
export async function getExistingTaskNames(): Promise<Set<string>> {
  const names = new Set<string>();

  if (CLICKUP_PARENT_TASK_ID) {
    const parent = await request<ClickUpTask>(
      "GET",
      `/task/${CLICKUP_PARENT_TASK_ID}?include_subtasks=true`,
    );
    for (const sub of parent.subtasks || []) {
      names.add(sub.name.toLowerCase().trim());
    }
  } else {
    const listId = await getEffectiveListId();
    const params = new URLSearchParams({
      include_closed: "false",
      subtasks: "true",
    });
    const data = await request<{ tasks: ClickUpTask[] }>(
      "GET",
      `/list/${listId}/task?${params.toString()}`,
    );
    for (const task of data.tasks || []) {
      names.add(task.name.toLowerCase().trim());
    }
  }

  return names;
}

/**
 * Create a new task in the ClickUp list.
 * In parent task mode, creates the task as a subtask of the configured parent.
 */
export async function createTask(
  name: string,
  description?: string,
): Promise<ClickUpTask> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create task: "${name}"`);
    return { id: "dry-run", name, url: "https://dry-run" } as ClickUpTask;
  }
  const listId = await getEffectiveListId();
  log("info", `Creating new task: "${name}"`);
  const body: Record<string, unknown> = {
    name,
    description: description || "",
    status: STATUS.TODO,
  };
  if (CLICKUP_PARENT_TASK_ID) {
    body.parent = CLICKUP_PARENT_TASK_ID;
  }
  return request<ClickUpTask>("POST", `/list/${listId}/task`, body);
}

// ─── Tier 1 & Tier 2 context for the 3-tiered task context system ───

/**
 * Tier 1: Get a compact summary of ALL tasks in the project.
 * Groups tasks by status and lists only names — no descriptions.
 * Gives Claude awareness of the full project landscape.
 */
export async function getAllTasksSummary(): Promise<string> {
  let tasks: ClickUpTask[];

  if (CLICKUP_PARENT_TASK_ID) {
    const parent = await request<ClickUpTask>(
      "GET",
      `/task/${CLICKUP_PARENT_TASK_ID}?include_subtasks=true`,
    );
    tasks = parent.subtasks || [];
  } else {
    const listId = await getEffectiveListId();
    const params = new URLSearchParams({
      include_closed: "true",
      subtasks: "true",
    });
    const data = await request<{ tasks: ClickUpTask[] }>(
      "GET",
      `/list/${listId}/task?${params.toString()}`,
    );
    tasks = data.tasks || [];
  }

  if (tasks.length === 0) return "(no tasks found)";

  // Group by status
  const grouped = new Map<string, ClickUpTask[]>();
  for (const task of tasks) {
    const status = task.status?.status || "unknown";
    if (!grouped.has(status)) grouped.set(status, []);
    grouped.get(status)!.push(task);
  }

  const lines: string[] = [];
  for (const [status, statusTasks] of grouped) {
    lines.push(`### ${status} (${statusTasks.length})`);
    for (const t of statusTasks) {
      const priority = t.priority ? ` [${t.priority.priority}]` : "";
      lines.push(`- ${t.name} (CU-${t.id})${priority}`);
    }
    lines.push("");
  }

  log("debug", `Tier 1 project overview: ${tasks.length} tasks across ${grouped.size} statuses`);
  return lines.join("\n");
}

/**
 * Tier 2: Get context about tasks related to the current task.
 * Includes: dependencies (what this task waits on / blocks),
 * tasks currently in progress, and recently completed tasks.
 * Each includes a brief description (first ~200 chars).
 */
export async function getRelatedTasksContext(task: ClickUpTask): Promise<string> {
  const parts: string[] = [];

  // Dependencies
  try {
    const { dependencies, waitingOn } = await getTaskDependencies(task.id);

    if (waitingOn.length > 0) {
      parts.push("### This task depends on:");
      for (const dep of waitingOn) {
        try {
          const depTask = await getTask(dep.depends_on);
          const desc = (depTask.text_content || depTask.description || "").slice(0, 200);
          const status = depTask.status?.status || "unknown";
          parts.push(`- **${depTask.name}** (CU-${depTask.id}) [${status}]`);
          if (desc) parts.push(`  ${desc}${desc.length >= 200 ? "..." : ""}`);
        } catch {
          parts.push(`- (CU-${dep.depends_on}) — could not fetch details`);
        }
      }
      parts.push("");
    }

    if (dependencies.length > 0) {
      parts.push("### Tasks blocked by this task:");
      for (const dep of dependencies) {
        try {
          const depTask = await getTask(dep.task_id);
          const desc = (depTask.text_content || depTask.description || "").slice(0, 200);
          const status = depTask.status?.status || "unknown";
          parts.push(`- **${depTask.name}** (CU-${depTask.id}) [${status}]`);
          if (desc) parts.push(`  ${desc}${desc.length >= 200 ? "..." : ""}`);
        } catch {
          parts.push(`- (CU-${dep.task_id}) — could not fetch details`);
        }
      }
      parts.push("");
    }
  } catch (err) {
    log("debug", `Could not fetch dependencies for task ${task.id}: ${(err as Error).message}`);
  }

  // In-progress tasks (siblings working alongside this one)
  try {
    const inProgress = await getTasksByStatus(STATUS.IN_PROGRESS);
    const siblings = inProgress.filter((t) => t.id !== task.id);
    if (siblings.length > 0) {
      parts.push("### Currently in progress:");
      for (const t of siblings) {
        const desc = (t.text_content || t.description || "").slice(0, 200);
        parts.push(`- **${t.name}** (CU-${t.id})`);
        if (desc) parts.push(`  ${desc}${desc.length >= 200 ? "..." : ""}`);
      }
      parts.push("");
    }
  } catch (err) {
    log("debug", `Could not fetch in-progress tasks: ${(err as Error).message}`);
  }

  // Recently completed tasks
  try {
    const completed = await getTasksByStatus(STATUS.COMPLETED);
    if (completed.length > 0) {
      // Show up to 10 most recently completed
      const recent = completed.slice(0, 10);
      parts.push(`### Recently completed (${recent.length} of ${completed.length}):`);
      for (const t of recent) {
        const desc = (t.text_content || t.description || "").slice(0, 200);
        parts.push(`- **${t.name}** (CU-${t.id})`);
        if (desc) parts.push(`  ${desc}${desc.length >= 200 ? "..." : ""}`);
      }
      parts.push("");
    }
  } catch (err) {
    log("debug", `Could not fetch completed tasks: ${(err as Error).message}`);
  }

  if (parts.length === 0) return "(no related tasks found)";

  log("debug", `Tier 2 related context built for task ${task.id}`);
  return parts.join("\n");
}

/**
 * Known prompt injection patterns.
 * These are logged as warnings when detected in task content.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+a/i,
  /new\s+system\s+prompt/i,
  /override\s+(the\s+)?system/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /<\/task>/i,
  /IMPORTANT:\s*ignore/i,
  /CRITICAL:\s*override/i,
];

/**
 * Check task content for known prompt injection patterns.
 * Returns an array of matched pattern descriptions.
 */
export function detectInjectionPatterns(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      matches.push(match[0]);
    }
  }
  return matches;
}

// Maximum lengths for task content sent to Claude
const MAX_CHECKLIST_ITEM_LENGTH = 500;
const MAX_TASK_CONTEXT_BYTES = 50_000; // 50KB total budget for tier 3 (current task)

/**
 * Truncate a string to a maximum length, appending "... (truncated)" if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "... (truncated)";
}

/**
 * Extract a clean task description from ClickUp task data.
 * Combines title, description, and any checklist items.
 * Applies length limits and content boundaries to prevent prompt injection.
 */
export function formatTaskForClaude(
  task: ClickUpTask,
  comments?: ClickUpComment[],
): string {
  // Check for injection patterns in all untrusted content
  const allContent = [
    task.name,
    task.text_content || task.description || "",
    ...(comments || []).map((c) => getCommentText(c)),
  ].join("\n");

  const injectionMatches = detectInjectionPatterns(allContent);
  if (injectionMatches.length > 0) {
    log(
      "warn",
      `Potential prompt injection detected in task ${task.id}: ${injectionMatches.join(", ")}`,
    );
  }

  const parts: string[] = [];

  parts.push(`# Task: ${truncate(task.name, 200)}`);
  parts.push(`Task ID: ${task.id}`);
  parts.push(`URL: ${task.url}`);

  if (task.priority) {
    parts.push(`Priority: ${task.priority.priority}`);
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`Tags: ${task.tags.map((t) => t.name).join(", ")}`);
  }

  parts.push("");

  if (task.text_content) {
    parts.push("## Description");
    parts.push(task.text_content);
    parts.push("");
  } else if (task.description) {
    parts.push("## Description");
    parts.push(task.description);
    parts.push("");
  }

  // Include checklist items if any
  if (task.checklists && task.checklists.length > 0) {
    parts.push("## Checklist");
    for (const checklist of task.checklists) {
      parts.push(`### ${truncate(checklist.name, MAX_CHECKLIST_ITEM_LENGTH)}`);
      for (const item of checklist.items || []) {
        const check = item.resolved ? "[x]" : "[ ]";
        parts.push(`- ${check} ${truncate(item.name, MAX_CHECKLIST_ITEM_LENGTH)}`);
      }
    }
    parts.push("");
  }

  // Include subtasks if any
  if (task.subtasks && task.subtasks.length > 0) {
    parts.push("## Subtasks");
    for (const sub of task.subtasks) {
      const done = sub.status?.status === STATUS.COMPLETED ? "[x]" : "[ ]";
      parts.push(`- ${done} ${truncate(sub.name, MAX_CHECKLIST_ITEM_LENGTH)}`);
    }
    parts.push("");
  }

  // Include ALL comments, sorted newest-first.
  // If the total output exceeds the context budget, drop oldest comments first.
  if (comments && comments.length > 0) {
    // Sort newest-first (ClickUp returns oldest-first by default)
    const sorted = [...comments].sort((a, b) => {
      const da = a.date ? parseInt(a.date) : 0;
      const db = b.date ? parseInt(b.date) : 0;
      return db - da;
    });

    const commentLines: string[] = [];
    commentLines.push("## Comments");
    commentLines.push(`(${sorted.length} comment${sorted.length === 1 ? "" : "s"}, newest first)`);

    for (const comment of sorted) {
      const text = getCommentText(comment);
      if (!text.trim()) continue;
      const user = comment.user?.username || "Unknown";
      const date = comment.date
        ? new Date(parseInt(comment.date)).toISOString().split("T")[0]
        : "";
      const header = date ? `**${user}** (${date}):` : `**${user}**:`;
      commentLines.push(`${header}\n${text}\n`);
    }

    // Apply context budget: if adding all comments exceeds the limit,
    // trim from the end (oldest comments, since we sorted newest-first)
    const baseParts = parts.join("\n");
    const baseSize = Buffer.byteLength(baseParts, "utf-8");
    const allComments = commentLines.join("\n");
    const totalSize = baseSize + Buffer.byteLength(allComments, "utf-8");

    if (totalSize <= MAX_TASK_CONTEXT_BYTES) {
      parts.push(...commentLines);
    } else {
      // Add comments one by one until we hit the budget
      const budgetRemaining = MAX_TASK_CONTEXT_BYTES - baseSize;
      const kept: string[] = [commentLines[0]!, commentLines[1]!]; // header lines
      let keptSize = Buffer.byteLength(kept.join("\n"), "utf-8");

      for (let i = 2; i < commentLines.length; i++) {
        const line = commentLines[i]!;
        const lineSize = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
        if (keptSize + lineSize > budgetRemaining) {
          kept.push(`\n... (${commentLines.length - i} older comments omitted to fit context budget)`);
          break;
        }
        kept.push(line);
        keptSize += lineSize;
      }
      parts.push(...kept);
    }
  }

  return parts.join("\n");
}

/**
 * Automation comment markers used to identify comments posted by this automation.
 * Used to determine which comments are "new" (posted after the automation last acted).
 */
const AUTOMATION_COMMENT_MARKERS = [
  "🤖 Automation",
  "✅ Automation completed",
  "⚠️ Automation",
  "❌ Automation",
  "🔄 Automation",
  "🔀 PR has merge conflicts",
  "🔍 Automation needs",
];

/**
 * Check if a comment was posted by the automation.
 */
function isAutomationComment(commentText: string): boolean {
  return AUTOMATION_COMMENT_MARKERS.some((marker) => commentText.includes(marker));
}

/**
 * Get new ClickUp comments on a task that were posted after the automation's
 * last comment. These represent human review feedback.
 * Returns only non-automation comments that appeared after the last automation comment.
 */
export async function getNewReviewFeedback(
  taskId: string,
): Promise<ClickUpComment[]> {
  const comments = await getTaskComments(taskId);

  // Find the index of the last automation comment
  let lastAutomationIdx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = getCommentText(comments[i]!);
    if (isAutomationComment(text)) {
      lastAutomationIdx = i;
      break;
    }
  }

  // If no automation comment found, return all non-automation comments.
  // This handles cases where the task was manually moved to IN REVIEW
  // or where automation comments weren't detected.
  if (lastAutomationIdx === -1) {
    log("debug", `No automation comment found for task ${taskId}. Returning all non-automation comments.`);
    return comments.filter((c) => {
      const text = getCommentText(c);
      return text.trim() !== "" && !isAutomationComment(text);
    });
  }

  // Return all non-automation comments after the last automation comment
  const newComments: ClickUpComment[] = [];
  for (let i = lastAutomationIdx + 1; i < comments.length; i++) {
    const text = getCommentText(comments[i]!);
    if (text.trim() && !isAutomationComment(text)) {
      newComments.push(comments[i]!);
    }
  }

  return newComments;
}

/**
 * Validate that a task ID matches the expected ClickUp format (alphanumeric).
 * Prevents injection through malformed task IDs.
 */
export function isValidTaskId(taskId: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(taskId) && taskId.length <= 30;
}

/**
 * Create a slug from a task name for use in branch names.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Get the list info including available statuses.
 * In parent task mode, resolves the list from the parent task.
 */
export async function getListInfo(): Promise<ClickUpList> {
  const listId = await getEffectiveListId();
  return request<ClickUpList>("GET", `/list/${listId}`);
}

/**
 * Validate that the configured statuses exist in the ClickUp list.
 */
export async function validateStatuses(): Promise<boolean> {
  const list = await getListInfo();
  const availableStatuses = list.statuses.map((s) => s.status.toLowerCase());

  log("info", `List "${list.name}" statuses: ${availableStatuses.join(", ")}`);

  const missing: string[] = [];
  for (const [key, value] of Object.entries(STATUS)) {
    if (!availableStatuses.includes(value.toLowerCase())) {
      missing.push(`${key}: "${value}"`);
    }
  }

  if (missing.length > 0) {
    log(
      "warn",
      `The following configured statuses are not in the ClickUp list: ${missing.join(", ")}`,
    );
    log(
      "warn",
      `Available statuses: ${list.statuses.map((s) => `"${s.status}"`).join(", ")}`,
    );
    log(
      "warn",
      `Please create these statuses in ClickUp or update your .env config.`,
    );
    return false;
  }

  log("info", "All configured statuses validated successfully.");
  return true;
}
