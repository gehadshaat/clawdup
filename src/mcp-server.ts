// MCP server exposing ClickUp operations as tools for Claude Code.
// Implements Model Context Protocol (JSON-RPC 2.0) over stdio transport.
// Self-contained: uses its own fetch calls to ClickUp API, configured via env vars.

import { createInterface } from "readline";

// --- Configuration from environment (passed via MCP config) ---
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN || "";
const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID || "";
const CLICKUP_PARENT_TASK_ID = process.env.CLICKUP_PARENT_TASK_ID || "";
const STATUS_TODO = process.env.STATUS_TODO || "to do";
const BASE_URL = "https://api.clickup.com/api/v2";

// --- ClickUp API helper ---
async function clickupRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: CLICKUP_API_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickUp API error ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (null as T);
}

// Resolve effective list ID (cached)
let resolvedListId: string | null = null;
async function getEffectiveListId(): Promise<string> {
  if (CLICKUP_LIST_ID) return CLICKUP_LIST_ID;
  if (resolvedListId) return resolvedListId;

  if (!CLICKUP_PARENT_TASK_ID) {
    throw new Error(
      "Neither CLICKUP_LIST_ID nor CLICKUP_PARENT_TASK_ID is configured",
    );
  }

  const parent = await clickupRequest<{ list?: { id: string } }>(
    "GET",
    `/task/${CLICKUP_PARENT_TASK_ID}`,
  );
  if (!parent.list?.id) {
    throw new Error("Could not determine list ID from parent task");
  }
  resolvedListId = parent.list.id;
  return resolvedListId;
}

// --- MCP Tool definitions ---
const TOOLS = [
  {
    name: "clickup_get_task",
    description:
      "Get full details of a ClickUp task by ID, including name, description, status, priority, tags, checklists, and subtasks.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The ClickUp task ID (e.g., '86abc123')",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "clickup_get_tasks_by_status",
    description:
      "Get all tasks with a specific status. In list mode, queries the configured list. In parent task mode, queries subtasks of the parent.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description:
            "Status to filter by (e.g., 'to do', 'in progress', 'in review', 'complete')",
        },
      },
      required: ["status"],
    },
  },
  {
    name: "clickup_create_task",
    description:
      "Create a new task in the configured ClickUp list. In parent task mode, creates it as a subtask of the parent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task title" },
        description: {
          type: "string",
          description: "Task description (markdown supported)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "clickup_update_task_status",
    description: "Update the status of a ClickUp task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The ClickUp task ID" },
        status: {
          type: "string",
          description:
            "New status (e.g., 'to do', 'in progress', 'in review', 'complete', 'blocked')",
        },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "clickup_add_comment",
    description: "Add a comment to a ClickUp task. Notifies all watchers.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The ClickUp task ID" },
        comment: { type: "string", description: "Comment text to add" },
      },
      required: ["task_id", "comment"],
    },
  },
  {
    name: "clickup_get_comments",
    description:
      "Get all comments on a ClickUp task, including author and date.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The ClickUp task ID" },
      },
      required: ["task_id"],
    },
  },
];

// Exported for use in claude-worker.ts when building --allowedTools
export const MCP_TOOL_NAMES = TOOLS.map((t) => `mcp__clawup__${t.name}`);

// --- Tool execution ---
interface ClickUpSubtask {
  id: string;
  status?: { status: string };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "clickup_get_task": {
      const taskId = String(args.task_id);
      return clickupRequest("GET", `/task/${taskId}?include_subtasks=true`);
    }

    case "clickup_get_tasks_by_status": {
      const status = String(args.status);

      if (CLICKUP_PARENT_TASK_ID) {
        const parent = await clickupRequest<{
          subtasks?: ClickUpSubtask[];
        }>("GET", `/task/${CLICKUP_PARENT_TASK_ID}?include_subtasks=true`);
        const subtasks = parent.subtasks || [];
        const matching = subtasks.filter(
          (s) => s.status?.status?.toLowerCase() === status.toLowerCase(),
        );
        const tasks = [];
        for (const sub of matching) {
          const task = await clickupRequest("GET", `/task/${sub.id}`);
          tasks.push(task);
        }
        return { tasks };
      }

      const listId = await getEffectiveListId();
      const params = new URLSearchParams({
        include_closed: "false",
        subtasks: "true",
      });
      params.append("statuses[]", status);
      return clickupRequest(
        "GET",
        `/list/${listId}/task?${params.toString()}`,
      );
    }

    case "clickup_create_task": {
      const listId = await getEffectiveListId();
      const body: Record<string, unknown> = {
        name: String(args.name),
        description: args.description ? String(args.description) : "",
        status: STATUS_TODO,
      };
      if (CLICKUP_PARENT_TASK_ID) {
        body.parent = CLICKUP_PARENT_TASK_ID;
      }
      return clickupRequest("POST", `/list/${listId}/task`, body);
    }

    case "clickup_update_task_status": {
      const taskId = String(args.task_id);
      const status = String(args.status);
      await clickupRequest("PUT", `/task/${taskId}`, { status });
      return { success: true, task_id: taskId, new_status: status };
    }

    case "clickup_add_comment": {
      const taskId = String(args.task_id);
      const comment = String(args.comment);
      await clickupRequest("POST", `/task/${taskId}/comment`, {
        comment_text: comment,
        notify_all: true,
      });
      return { success: true, task_id: taskId };
    }

    case "clickup_get_comments": {
      const taskId = String(args.task_id);
      return clickupRequest("GET", `/task/${taskId}/comment`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC 2.0 protocol ---
interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function sendResponse(
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string },
): void {
  const response: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + "\n");
}

async function handleMessage(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;

  // Notifications (no id) don't require a response
  if (id === undefined) return;

  switch (method) {
    case "initialize": {
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "clawup", version: "1.0.0" },
      });
      break;
    }

    case "tools/list": {
      sendResponse(id, { tools: TOOLS });
      break;
    }

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

      try {
        const result = await executeTool(toolName, toolArgs);
        sendResponse(id, {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        });
      } catch (err) {
        sendResponse(id, {
          content: [
            { type: "text", text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        });
      }
      break;
    }

    default: {
      sendResponse(id, undefined, {
        code: -32601,
        message: `Method not found: ${method}`,
      });
    }
  }
}

// --- Main: read JSONL from stdin, process each message ---
const rl = createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as JsonRpcMessage;
    handleMessage(msg).catch((err: unknown) => {
      process.stderr.write(
        `MCP server error: ${(err as Error).message}\n`,
      );
    });
  } catch {
    process.stderr.write(`Failed to parse MCP message: ${line}\n`);
  }
});

// Keep process alive while waiting for messages
process.stdin.resume();
