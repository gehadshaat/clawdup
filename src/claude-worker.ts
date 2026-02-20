// Claude Code worker - invokes Claude CLI to work on tasks.
// The system prompt is built dynamically:
//   1. Base automation rules (always included)
//   2. CLAUDE.md from the project/repo root (if it exists)
//   3. Custom prompt from clawup.config.mjs (if provided)

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  CLAUDE_COMMAND,
  CLAUDE_TIMEOUT_MS,
  CLAUDE_MAX_TURNS,
  PROJECT_ROOT,
  GIT_ROOT,
  userConfig,
  log,
} from "./config.js";
import type { ClickUpTask, ClaudeResult } from "./types.js";

const NEEDS_INPUT_MARKERS = [
  "NEEDS_MORE_INFO",
  "REQUIRE_INPUT",
  "NEED_CLARIFICATION",
  "BLOCKED:",
  "I need more information",
  "I need clarification",
  "could you clarify",
  "could you provide",
  "I cannot proceed without",
  "insufficient information",
  "the task description is unclear",
];

/**
 * Build the system prompt for Claude.
 * Combines base rules + project context (CLAUDE.md) + user config.
 */
function buildSystemPrompt(taskPrompt: string): string {
  const parts: string[] = [];

  // Base automation rules (always present)
  parts.push(`You are working on a ClickUp task in this codebase.
Your job is to implement the requested changes described below.

IMPORTANT RULES:
1. Read the task carefully and understand what needs to be done.
2. Explore the relevant code before making changes.
3. Make the minimal changes needed to complete the task.
4. Follow the project's existing coding standards and conventions.
5. If you do NOT have enough information to complete the task, output "NEEDS_MORE_INFO:" followed by a clear description of what information is missing. Do not guess or make assumptions about unclear requirements.
6. Do NOT commit or push changes - the automation will handle that.
7. Do NOT create new branches - you're already on the correct branch.`);

  // Project context from CLAUDE.md
  // In a monorepo, check both the package directory and the repo root.
  const claudeMdCandidates = [resolve(PROJECT_ROOT, "CLAUDE.md")];
  if (GIT_ROOT !== PROJECT_ROOT) {
    claudeMdCandidates.push(resolve(GIT_ROOT, "CLAUDE.md"));
  }
  for (const claudeMdPath of claudeMdCandidates) {
    if (existsSync(claudeMdPath)) {
      try {
        const claudeMd = readFileSync(claudeMdPath, "utf-8");
        parts.push(`\n## Project Context (from CLAUDE.md)\n\n${claudeMd}`);
      } catch {
        // ignore read errors
      }
      break;
    }
  }

  // Custom prompt from user config
  if (userConfig.prompt) {
    parts.push(`\n## Additional Instructions\n\n${userConfig.prompt}`);
  }

  // The actual task
  parts.push(`\nHere is the task to work on:\n\n${taskPrompt}`);

  return parts.join("\n");
}

/**
 * Run Claude Code on a task.
 */
export async function runClaudeOnTask(
  taskPrompt: string,
  taskId: string,
): Promise<ClaudeResult> {
  const systemPrompt = buildSystemPrompt(taskPrompt);

  log("info", `Running Claude Code on task ${taskId}...`);

  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;

    const args = [
      "-p", // print mode (non-interactive)
      "--output-format",
      "text",
      "--max-turns",
      String(CLAUDE_MAX_TURNS),
      "--verbose",
    ];

    // Allow user config to append extra CLI args
    if (userConfig.claudeArgs && Array.isArray(userConfig.claudeArgs)) {
      args.push(...userConfig.claudeArgs);
    }

    const proc = spawn(CLAUDE_COMMAND, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    proc.stdin.write(systemPrompt);
    proc.stdin.end();

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      log("debug", `claude stderr: ${text.trim()}`);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      log("warn", `Claude Code timed out after ${CLAUDE_TIMEOUT_MS}ms`);
      proc.kill("SIGTERM");
    }, CLAUDE_TIMEOUT_MS);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);

      if (timedOut) {
        resolve({
          success: false,
          output,
          needsInput: false,
          error: `Claude Code timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`,
        });
        return;
      }

      if (code !== 0 && code !== null) {
        log("warn", `Claude Code exited with code ${code}`);
      }

      const needsInput = NEEDS_INPUT_MARKERS.some((marker) =>
        output.toLowerCase().includes(marker.toLowerCase()),
      );

      if (needsInput) {
        log("info", `Claude indicated it needs more input for task ${taskId}`);
        resolve({
          success: false,
          output,
          needsInput: true,
        });
        return;
      }

      resolve({
        success: code === 0 || code === null,
        output,
        needsInput: false,
        error: code !== 0 ? `Exited with code ${code}` : undefined,
      });
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      log("error", `Failed to spawn Claude Code: ${err.message}`);
      resolve({
        success: false,
        output,
        needsInput: false,
        error: `Failed to run Claude Code: ${err.message}`,
      });
    });
  });
}

/**
 * Extract the "needs input" reason from Claude's output.
 */
export function extractNeedsInputReason(output: string): string {
  for (const marker of NEEDS_INPUT_MARKERS) {
    const idx = output.toLowerCase().indexOf(marker.toLowerCase());
    if (idx !== -1) {
      const after = output.slice(idx);
      const lines = after.split("\n").filter((l) => l.trim());
      return lines.slice(0, 5).join("\n");
    }
  }
  return "Claude Code indicated it needs more information to complete this task.";
}

/**
 * Generate a commit message from the task info and Claude's output.
 */
export function generateCommitMessage(
  task: ClickUpTask,
  claudeOutput: string,
): string {
  const taskRef = `[CU-${task.id}]`;
  const title = task.name;

  const lines = claudeOutput
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  let summary = "";
  if (lines.length > 0) {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      const line = lines[i]!.trim();
      if (
        line.length > 20 &&
        !line.startsWith("#") &&
        !line.startsWith("```") &&
        !line.startsWith("-")
      ) {
        summary = line;
        break;
      }
    }
  }

  const msg = `${taskRef} ${title}`;
  if (summary && summary.length < 200) {
    return `${msg}\n\n${summary}`;
  }
  return msg;
}

/**
 * Generate a PR body from the task info and Claude's output.
 */
export function generatePRBody(
  task: ClickUpTask,
  _claudeOutput: string,
  changedFiles: string[],
): string {
  const parts: string[] = [];

  parts.push(`## Summary`);
  parts.push(
    `Automated implementation for ClickUp task: [${task.name}](${task.url})`,
  );
  parts.push("");

  if (task.text_content) {
    parts.push(`## Task Description`);
    parts.push(task.text_content.slice(0, 500));
    if (task.text_content.length > 500) parts.push("...");
    parts.push("");
  }

  if (changedFiles && changedFiles.length > 0) {
    parts.push(`## Files Changed`);
    for (const f of changedFiles) {
      parts.push(`- \`${f}\``);
    }
    parts.push("");
  }

  parts.push(`## Test Plan`);
  parts.push(`- [ ] Review the changes manually`);
  parts.push(`- [ ] Verify build succeeds`);
  parts.push(`- [ ] Run tests`);
  parts.push(`- [ ] Visual review if applicable`);
  parts.push("");

  parts.push(`---`);
  parts.push(`*Automated by [clawup](https://github.com)*`);
  parts.push(`ClickUp Task: ${task.url}`);

  return parts.join("\n");
}
