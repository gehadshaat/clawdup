// Configuration module.
// Resolves settings from (in priority order):
//   1. Environment variables
//   2. .clawup.env in the package directory (cwd)
//   3. clawup.config.mjs in the package directory (cwd)
//   4. Defaults
//
// Designed for per-package use: each package that depends on clawup
// has its own .clawup.env with its own ClickUp list ID, API key, etc.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import type { UserConfig } from "./types.js";

// PROJECT_ROOT is the directory where clawup was invoked (the package directory).
// Config files (.clawup.env, clawup.config.mjs, CLAUDE.md) are resolved from here.
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
// Look for .clawup.env in the project root
const envCandidates = [
  resolve(PROJECT_ROOT, ".clawup.env"),
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
// Load clawup.config.mjs if it exists.
// This allows users to customize the Claude prompt, hooks, etc.
let userConfig: UserConfig = {};
const configPath = resolve(PROJECT_ROOT, "clawup.config.mjs");
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
    console.error(`Set it in .clawup.env (in your project root) or export it.`);
    process.exit(1);
  }
  return val;
}

// ClickUp
export const CLICKUP_API_TOKEN: string = required("CLICKUP_API_TOKEN");
export const CLICKUP_LIST_ID: string = required("CLICKUP_LIST_ID");

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

// Polling
export const POLL_INTERVAL_MS: number = parseInt(
  process.env.POLL_INTERVAL_MS || "30000",
  10,
);

// Claude Code
export const CLAUDE_COMMAND: string = process.env.CLAUDE_COMMAND || "claude";
export const CLAUDE_TIMEOUT_MS: number = parseInt(
  process.env.CLAUDE_TIMEOUT_MS || "600000",
  10,
);
export const CLAUDE_MAX_TURNS: number = parseInt(
  process.env.CLAUDE_MAX_TURNS || "50",
  10,
);

// Branch naming
export const BRANCH_PREFIX: string = process.env.BRANCH_PREFIX || "clickup";

// Merge strategy: "squash" | "merge" | "rebase"
export const MERGE_STRATEGY: string = process.env.MERGE_STRATEGY || "squash";

// Logging
export const LOG_LEVEL: string = process.env.LOG_LEVEL || "info";

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, ...args: unknown[]): void {
  const levels: Record<string, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };
  if (levels[level]! >= levels[LOG_LEVEL]!) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    if (level === "error") {
      console.error(prefix, ...args);
    } else if (level === "warn") {
      console.warn(prefix, ...args);
    } else {
      console.log(prefix, ...args);
    }
  }
}
