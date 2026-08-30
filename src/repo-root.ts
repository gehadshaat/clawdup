// Repo-root utilities shared by the CLI, setup wizard, and config loader.
// clawdup is installed globally and configured per-repository: everything it
// reads or writes (.clawdup.env, clawdup.config.mjs, state files) lives at
// the repository root, regardless of which subdirectory it is invoked from.

import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Detect the git repository root for the given directory.
 * Falls back to the directory itself when not inside a git repository.
 */
export function detectRepoRoot(cwd: string = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * Entries every clawdup-managed repository should ignore: the env file holds
 * secrets and must never be committed; the rest are local runtime state.
 */
export const GITIGNORE_ENTRIES: readonly string[] = [
  ".clawdup.env",
  ".env.clickup",
  ".clawdup.todo.json",
  ".clawdup.lock",
  ".clawdup.sessions.json",
  ".clawdup-sessions/",
  ".clawdup-worktrees/",
];

/**
 * Ensure the repo-root .gitignore contains the clawdup entries.
 * Creates .gitignore if missing. Returns the entries that were added
 * (empty array when everything was already present).
 */
export function ensureGitignoreEntries(repoRoot: string): string[] {
  const gitignorePath = resolve(repoRoot, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";

  const existingLines = new Set(
    existing.split("\n").map((line) => line.trim()),
  );
  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => !existingLines.has(entry),
  );
  if (missing.length === 0) return [];

  const prefix =
    existing.length === 0
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
  const block = `${prefix}# clawdup (local config + runtime state — never commit)\n${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, existing + block);
  return [...missing];
}
