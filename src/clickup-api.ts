// ClickUp API v2 client
// Docs: https://clickup.com/api

import {
  CLICKUP_API_TOKEN,
  CLICKUP_LIST_ID,
  CLICKUP_PARENT_TASK_ID,
  STATUS,
  log,
} from "./config.js";
import type { ClickUpTask, ClickUpUser, ClickUpList, ClickUpComment } from "./types.js";

const BASE_URL = "https://api.clickup.com/api/v2";

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

/**
 * Lazy-resolved list ID.
 * In parent task mode, the list ID is derived from the parent task on first use.
 */
let resolvedListId: string | null = null;

/**
 * Get the effective list ID, resolving it from the parent task if needed.
 */
export async function getEffectiveListId(): Promise<string> {
  if (resolvedListId) return resolvedListId;

  if (CLICKUP_LIST_ID) {
    resolvedListId = CLICKUP_LIST_ID;
    return resolvedListId;
  }

  if (CLICKUP_PARENT_TASK_ID) {
    const parentTask = await request<{ list: { id: string } }>(
      "GET",
      `/task/${CLICKUP_PARENT_TASK_ID}`,
    );
    resolvedListId = parentTask.list.id;
    log("info", `Resolved list ID from parent task: ${resolvedListId}`);
    return resolvedListId;
  }

  throw new Error(
    "Either CLICKUP_LIST_ID or CLICKUP_PARENT_TASK_ID must be set",
  );
}

/**
 * Get all tasks in the list with a specific status.
 * In parent task mode, only subtasks of the configured parent task are returned.
 * Returns tasks sorted by priority (urgent first) then by date created.
 */
export async function getTasksByStatus(status: string): Promise<ClickUpTask[]> {
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
  let tasks = data.tasks || [];

  // In parent task mode, filter to only subtasks of the configured parent task
  if (CLICKUP_PARENT_TASK_ID) {
    tasks = tasks.filter((t) => t.parent === CLICKUP_PARENT_TASK_ID);
  }

  // Sort by priority (1=urgent, 2=high, 3=normal, 4=low, null=no priority),
  // then by creation date (oldest first) within the same priority
  tasks.sort((a, b) => {
    const pa = a.priority ? parseInt(a.priority.id) : 99;
    const pb = b.priority ? parseInt(b.priority.id) : 99;
    if (pa !== pb) return pa - pb;
    const da = a.date_created ? parseInt(a.date_created) : 0;
    const db = b.date_created ? parseInt(b.date_created) : 0;
    return da - db;
  });

  const source = CLICKUP_PARENT_TASK_ID
    ? `parent task ${CLICKUP_PARENT_TASK_ID}`
    : `list ${listId}`;
  log(
    "info",
    `Found ${tasks.length} task(s) with status "${status}" in ${source}`,
  );
  return tasks;
}

/**
 * Get a single task by ID.
 */
export async function getTask(taskId: string): Promise<ClickUpTask> {
  return request<ClickUpTask>("GET", `/task/${taskId}`);
}

/**
 * Update a task's status.
 */
export async function updateTaskStatus(
  taskId: string,
  newStatus: string,
): Promise<void> {
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
    const text = comments[i]!.comment_text || "";
    const match = text.match(prUrlPattern);
    if (match) {
      return match[0]!;
    }
  }
  return null;
}

/**
 * Create a new task in the ClickUp list.
 * In parent task mode, the task is created as a subtask of the configured parent.
 */
export async function createTask(
  name: string,
  description?: string,
): Promise<ClickUpTask> {
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
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_COMMENT_LENGTH = 2000;
const MAX_COMMENTS_COUNT = 10;
const MAX_CHECKLIST_ITEM_LENGTH = 500;

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
    ...(comments || []).map((c) => c.comment_text || ""),
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
    parts.push(truncate(task.text_content, MAX_DESCRIPTION_LENGTH));
    parts.push("");
  } else if (task.description) {
    parts.push("## Description");
    parts.push(truncate(task.description, MAX_DESCRIPTION_LENGTH));
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

  // Include comments if any (limited to most recent N)
  if (comments && comments.length > 0) {
    const recentComments = comments.slice(-MAX_COMMENTS_COUNT);
    parts.push("## Comments");
    if (comments.length > MAX_COMMENTS_COUNT) {
      parts.push(`(showing ${MAX_COMMENTS_COUNT} most recent of ${comments.length} comments)`);
    }
    for (const comment of recentComments) {
      const text = comment.comment_text || "";
      if (!text.trim()) continue;
      const user = comment.user?.username || "Unknown";
      const date = comment.date
        ? new Date(parseInt(comment.date)).toISOString().split("T")[0]
        : "";
      const header = date ? `**${user}** (${date}):` : `**${user}**:`;
      parts.push(`${header}\n${truncate(text, MAX_COMMENT_LENGTH)}\n`);
    }
  }

  return parts.join("\n");
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
 * In parent task mode, returns the list that the parent task belongs to.
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
