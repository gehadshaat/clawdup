// ClickUp API v2 client
// Docs: https://clickup.com/api

import { CLICKUP_API_TOKEN, CLICKUP_LIST_ID, STATUS, log } from "./config.js";
import type { ClickUpTask, ClickUpList, ClickUpComment } from "./types.js";

const BASE_URL = "https://api.clickup.com/api/v2";

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    log("debug", `ClickUp API: ${method} ${path}${attempt > 0 ? ` (retry ${attempt})` : ""}`);

    const res = await fetch(url, opts);

    // Handle rate limiting (429)
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_DELAYS[attempt] || 4000;
      log("warn", `ClickUp API rate limited. Waiting ${waitMs / 1000}s before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Retry on server errors (5xx)
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS[attempt] || 4000;
      log("warn", `ClickUp API server error ${res.status}. Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `ClickUp API error ${res.status} ${method} ${path}: ${text}`,
      );
    }

    return text ? (JSON.parse(text) as T) : (null as T);
  }

  throw new Error(`ClickUp API: max retries exceeded for ${method} ${path}`);
}

/**
 * Get all tasks in the list with a specific status.
 * Returns tasks sorted by priority (urgent first) then by date created.
 */
export async function getTasksByStatus(status: string): Promise<ClickUpTask[]> {
  const params = new URLSearchParams({
    include_closed: "false",
    subtasks: "true",
    order_by: "created",
    reverse: "false",
  });
  params.append("statuses[]", status);

  const data = await request<{ tasks: ClickUpTask[] }>(
    "GET",
    `/list/${CLICKUP_LIST_ID}/task?${params.toString()}`,
  );
  const tasks = data.tasks || [];

  // Sort by priority (1=urgent, 2=high, 3=normal, 4=low, null=no priority)
  tasks.sort((a, b) => {
    const pa = a.priority ? parseInt(a.priority.id) : 99;
    const pb = b.priority ? parseInt(b.priority.id) : 99;
    return pa - pb;
  });

  log(
    "info",
    `Found ${tasks.length} task(s) with status "${status}" in list ${CLICKUP_LIST_ID}`,
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
 */
export async function createTask(
  name: string,
  description?: string,
): Promise<ClickUpTask> {
  log("info", `Creating new task: "${name}"`);
  return request<ClickUpTask>("POST", `/list/${CLICKUP_LIST_ID}/task`, {
    name,
    description: description || "",
    status: STATUS.TODO,
  });
}

/**
 * Extract a clean task description from ClickUp task data.
 * Combines title, description, checklist items, and optionally recent comments.
 */
export function formatTaskForClaude(task: ClickUpTask, comments?: ClickUpComment[]): string {
  const parts: string[] = [];

  parts.push(`# Task: ${task.name}`);
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
      parts.push(`### ${checklist.name}`);
      for (const item of checklist.items || []) {
        const check = item.resolved ? "[x]" : "[ ]";
        parts.push(`- ${check} ${item.name}`);
      }
    }
    parts.push("");
  }

  // Include subtasks if any
  if (task.subtasks && task.subtasks.length > 0) {
    parts.push("## Subtasks");
    for (const sub of task.subtasks) {
      const done = sub.status?.status === STATUS.COMPLETED ? "[x]" : "[ ]";
      parts.push(`- ${done} ${sub.name}`);
    }
    parts.push("");
  }

  // Include recent comments (useful context for retried tasks)
  if (comments && comments.length > 0) {
    // Show the most recent comments (up to 10) so Claude has context
    const recent = comments.slice(-10);
    parts.push("## Comments");
    parts.push(`(showing ${recent.length} most recent of ${comments.length} comments)`);
    for (const c of recent) {
      if (c.comment_text) {
        parts.push(`**${c.comment_by || "Unknown"}** (${c.date || "unknown date"}):`);
        parts.push(c.comment_text);
        parts.push("");
      }
    }
  }

  return parts.join("\n");
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
 */
export async function getListInfo(): Promise<ClickUpList> {
  return request<ClickUpList>("GET", `/list/${CLICKUP_LIST_ID}`);
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
