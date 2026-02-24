// Configuration module.
// Resolves settings from (in priority order):
//   1. Environment variables
//   2. .clawdup.env in the package directory (cwd)
//   3. clawdup.config.mjs in the package directory (cwd)
//   4. Defaults
//
// Designed for per-package use: each package that depends on clawdup
// has its own .clawdup.env with its own ClickUp list ID, API key, etc.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import type { UserConfig } from "./types.js";

// PROJECT_ROOT is the directory where clawdup was invoked (the package directory).
// Config files (.clawdup.env, clawdup.config.mjs, CLAUDE.md) are resolved from here.
export const PROJECT_ROOT: string = process.cwd();

// GIT_ROOT is the repository root (where .git lives).
// Git operations (branch, commit, push) always run from here.
// In a monorepo, this is the repo root, not the individual package directory.
export const GIT_ROOT: string = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return PROJECT_ROOT;
  }
})();

// --- .env loading ---
// Look for .clawdup.env in the project root
const envCandidates = [
  resolve(PROJECT_ROOT, ".clawdup.env"),
  resolve(PROJECT_ROOT, ".env.clickup"),
];

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed
        .slice(eqIndex + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    break; // only load the first one found
  }
}

// --- User config file ---
// Load clawdup.config.mjs if it exists.
// This allows users to customize the Claude prompt, hooks, etc.
let userConfig: UserConfig = {};
const configPath = resolve(PROJECT_ROOT, "clawdup.config.mjs");
if (existsSync(configPath)) {
  try {
    const mod = await import(`file://${configPath}`);
    userConfig = (mod.default || mod) as UserConfig;
  } catch (err) {
    console.warn(
      `Warning: Failed to load ${configPath}: ${(err as Error).message}`,
    );
  }
}
export { userConfig };

// --- Required env vars ---
function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`ERROR: Missing required environment variable: ${name}`);
    console.error(`Set it in .clawdup.env (in your project root) or export it.`);
    process.exit(1);
  }
  return val;
}

// ClickUp
export const CLICKUP_API_TOKEN: string = required("CLICKUP_API_TOKEN");
export const CLICKUP_LIST_ID: string = process.env.CLICKUP_LIST_ID || "";
export const CLICKUP_PARENT_TASK_ID: string = process.env.CLICKUP_PARENT_TASK_ID || "";

if (!CLICKUP_LIST_ID && !CLICKUP_PARENT_TASK_ID) {
  console.error(
    "ERROR: Either CLICKUP_LIST_ID or CLICKUP_PARENT_TASK_ID must be set.",
  );
  console.error(
    "Set one in .clawdup.env (in your project root) or export it.",
  );
  process.exit(1);
}

// GitHub
export const GITHUB_REPO: string = process.env.GITHUB_REPO || "";
export const BASE_BRANCH: string = process.env.BASE_BRANCH || "main";

// Task statuses
export const STATUS = {
  TODO: process.env.STATUS_TODO || "to do",
  IN_PROGRESS: process.env.STATUS_IN_PROGRESS || "in progress",
  IN_REVIEW: process.env.STATUS_IN_REVIEW || "in review",
  APPROVED: process.env.STATUS_APPROVED || "approved",
  REQUIRE_INPUT: process.env.STATUS_REQUIRE_INPUT || "require input",
  COMPLETED: process.env.STATUS_COMPLETED || "complete",
  BLOCKED: process.env.STATUS_BLOCKED || "blocked",
} as const;

// --- Validation helpers ---

function parsePositiveInt(name: string, raw: string | undefined, defaultValue: number): number {
  const str = raw || String(defaultValue);
  const value = parseInt(str, 10);
  if (isNaN(value) || value < 0) {
    console.error(`ERROR: ${name} must be a non-negative integer, got "${str}".`);
    process.exit(1);
  }
  return value;
}

// Polling
export const POLL_INTERVAL_MS: number = parsePositiveInt(
  "POLL_INTERVAL_MS",
  process.env.POLL_INTERVAL_MS,
  30000,
);

if (POLL_INTERVAL_MS > 0 && POLL_INTERVAL_MS < 5000) {
  console.error(
    `ERROR: POLL_INTERVAL_MS is ${POLL_INTERVAL_MS}ms (${POLL_INTERVAL_MS / 1000}s). ` +
    `Minimum is 5000ms (5s) to avoid excessive API calls.`,
  );
  process.exit(1);
}

// Relaunch interval (default: 10 minutes). Set to 0 to disable.
export const RELAUNCH_INTERVAL_MS: number = parsePositiveInt(
  "RELAUNCH_INTERVAL_MS",
  process.env.RELAUNCH_INTERVAL_MS,
  600000,
);

if (RELAUNCH_INTERVAL_MS > 0 && RELAUNCH_INTERVAL_MS < 60000) {
  console.error(
    `ERROR: RELAUNCH_INTERVAL_MS is ${RELAUNCH_INTERVAL_MS}ms (${RELAUNCH_INTERVAL_MS / 1000}s). ` +
    `Minimum is 60000ms (1min) when enabled. Set to 0 to disable.`,
  );
  process.exit(1);
}

// Claude Code
export const CLAUDE_COMMAND: string = process.env.CLAUDE_COMMAND || "claude";
export const CLAUDE_TIMEOUT_MS: number = parsePositiveInt(
  "CLAUDE_TIMEOUT_MS",
  process.env.CLAUDE_TIMEOUT_MS,
  600000,
);

if (CLAUDE_TIMEOUT_MS < 30000) {
  console.error(
    `ERROR: CLAUDE_TIMEOUT_MS is ${CLAUDE_TIMEOUT_MS}ms (${CLAUDE_TIMEOUT_MS / 1000}s). ` +
    `Minimum is 30000ms (30s) to allow Claude to complete meaningful work.`,
  );
  process.exit(1);
}

export const CLAUDE_MAX_TURNS: number = parsePositiveInt(
  "CLAUDE_MAX_TURNS",
  process.env.CLAUDE_MAX_TURNS,
  50,
);

if (CLAUDE_MAX_TURNS < 1) {
  console.error("ERROR: CLAUDE_MAX_TURNS must be at least 1.");
  process.exit(1);
}

if (CLAUDE_MAX_TURNS > 500) {
  console.error(
    `ERROR: CLAUDE_MAX_TURNS is ${CLAUDE_MAX_TURNS}. Maximum is 500 to prevent runaway sessions.`,
  );
  process.exit(1);
}

// Auto-approve mode: skip manual review and merge PRs immediately after Claude completes
export const AUTO_APPROVE: boolean = (process.env.AUTO_APPROVE || "").toLowerCase() === "true";

// Dry-run mode: simulate the full automation flow without making any changes
export const DRY_RUN: boolean = (process.env.DRY_RUN || "").toLowerCase() === "true";

// Branch naming
export const BRANCH_PREFIX: string = process.env.BRANCH_PREFIX || "clickup";

if (!/^[a-zA-Z0-9_-]+$/.test(BRANCH_PREFIX)) {
  console.error(
    `ERROR: BRANCH_PREFIX "${BRANCH_PREFIX}" contains invalid characters. ` +
    `Only alphanumeric characters, hyphens, and underscores are allowed.`,
  );
  process.exit(1);
}
