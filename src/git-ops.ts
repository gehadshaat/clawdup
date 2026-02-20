// Git and GitHub operations for task automation

import { execFile } from "child_process";
import { promisify } from "util";
import { BASE_BRANCH, BRANCH_PREFIX, MERGE_STRATEGY, GIT_ROOT, log } from "./config.js";
import type { PullRequestOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Run a git command from the repository root.
 * Uses GIT_ROOT (repo root) so git operations work correctly in monorepos.
 */
async function git(...args: string[]): Promise<string> {
  log("debug", `git ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: GIT_ROOT,
      timeout: 30000,
    });
    if (
      stderr &&
      !stderr.includes("Already on") &&
      !stderr.includes("Switched to")
    ) {
      log("debug", `git stderr: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${(err as Error).message}`);
  }
}

/**
 * Run a gh (GitHub CLI) command from the repository root.
 */
async function gh(...args: string[]): Promise<string> {
  log("debug", `gh ${args.join(" ")}`);
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: GIT_ROOT,
      timeout: 30000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh ${args.join(" ")} failed: ${(err as Error).message}`);
  }
}

/**
 * Auto-detect the GitHub repo from git remote.
 */
export async function detectGitHubRepo(): Promise<string> {
  const remote = await git("remote", "get-url", "origin");
  // Handle both SSH and HTTPS formats
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Could not detect GitHub repo from remote: ${remote}`);
  }
  return match[1]!;
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(): Promise<string> {
  return git("rev-parse", "--abbrev-ref", "HEAD");
}

/**
 * Ensure we're on the base branch and it's up to date.
 */
export async function syncBaseBranch(): Promise<void> {
  log("info", `Syncing base branch: ${BASE_BRANCH}`);
  await git("fetch", "origin", BASE_BRANCH);
  await git("checkout", BASE_BRANCH);
  await git("reset", "--hard", `origin/${BASE_BRANCH}`);
}

/**
 * Create and checkout a new branch for a task.
 * Branch name format: {prefix}/CU-{task-id}-{slug}
 * The CU-{id} prefix enables ClickUp's GitHub integration to auto-link
 * branches, commits, and PRs to the corresponding ClickUp task.
 */
export async function createTaskBranch(
  taskId: string,
  slug: string,
): Promise<string> {
  const branchName = `${BRANCH_PREFIX}/CU-${taskId}-${slug}`;
  log("info", `Creating branch: ${branchName}`);

  // Make sure base is up to date
  await syncBaseBranch();

  // Create new branch from base
  await git("checkout", "-b", branchName);

  return branchName;
}

/**
 * Check if the working directory has changes.
 */
export async function hasChanges(): Promise<boolean> {
  const status = await git("status", "--porcelain");
  return status.length > 0;
}

/**
 * Get a summary of changes (for PR description).
 */
export async function getChangesSummary(): Promise<{
  stat: string;
  files: string[];
}> {
  const diffStat = await git("diff", "--stat", "HEAD");
  const filesChanged = await git("diff", "--name-only", "HEAD");
  return {
    stat: diffStat,
    files: filesChanged.split("\n").filter(Boolean),
  };
}

/**
 * Stage all changes and commit.
 */
export async function commitChanges(message: string): Promise<string> {
  log("info", "Staging and committing changes");
  await git("add", "-A");
  await git("commit", "-m", message);
  const hash = await git("rev-parse", "--short", "HEAD");
  log("info", `Committed: ${hash}`);
  return hash;
}

/**
 * Push the current branch to origin with retry logic.
 */
export async function pushBranch(branchName: string): Promise<void> {
  const delays = [2000, 4000, 8000, 16000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      log("info", `Pushing ${branchName} (attempt ${attempt + 1})`);
      await git("push", "-u", "origin", branchName);
      log("info", `Push successful`);
      return;
    } catch (err) {
      if (attempt < delays.length) {
        const delay = delays[attempt]!;
        log(
          "warn",
          `Push failed, retrying in ${delay / 1000}s: ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Create a GitHub pull request using the gh CLI.
 * Returns the PR URL.
 */
export async function createPullRequest({
  title,
  body,
  branchName,
  baseBranch,
}: PullRequestOptions): Promise<string> {
  log("info", `Creating PR: "${title}"`);
  const prUrl = await gh(
    "pr",
    "create",
    "--title",
    title,
    "--body",
    body,
    "--base",
    baseBranch || BASE_BRANCH,
    "--head",
    branchName,
  );
  log("info", `PR created: ${prUrl}`);
  return prUrl;
}

/**
 * Check if the working tree is clean (no uncommitted changes).
 */
export async function isWorkingTreeClean(): Promise<boolean> {
  const status = await git("status", "--porcelain", "-uno");
  return status.length === 0;
}

/**
 * Find an existing branch for a task by its ClickUp ID.
 * Checks local branches first, then remote.
 * Returns the branch name (without "origin/" prefix) or null.
 */
export async function findBranchForTask(
  taskId: string,
): Promise<string | null> {
  // Check local branches
  const localResult = await git(
    "branch",
    "--list",
    `${BRANCH_PREFIX}/CU-${taskId}-*`,
  );
  if (localResult) {
    // git branch output has leading whitespace and possibly a * for current branch
    const branch = localResult
      .split("\n")[0]!
      .trim()
      .replace(/^\*\s*/, "");
    return branch;
  }

  // Check remote branches
  const remoteResult = await git(
    "branch",
    "-r",
    "--list",
    `origin/${BRANCH_PREFIX}/CU-${taskId}-*`,
  );
  if (remoteResult) {
    const remoteBranch = remoteResult.split("\n")[0]!.trim();
    // Strip "origin/" prefix to return the branch name
    return remoteBranch.replace(/^origin\//, "");
  }

  return null;
}

/**
 * Checkout an existing branch (local or from remote tracking).
 */
export async function checkoutExistingBranch(
  branchName: string,
): Promise<void> {
  log("info", `Checking out existing branch: ${branchName}`);
  try {
    // Try checking out as a local branch first
    await git("checkout", branchName);
  } catch {
    // If local checkout fails, create a tracking branch from remote
    await git("checkout", "-b", branchName, `origin/${branchName}`);
  }
}

/**
 * Check if the current branch has commits ahead of the base branch.
 */
export async function branchHasCommitsAheadOfBase(): Promise<boolean> {
  const output = await git("log", `${BASE_BRANCH}..HEAD`, "--oneline");
  return output.length > 0;
}

/**
 * Check if a branch has been pushed to the remote.
 */
export async function branchHasBeenPushed(
  branchName: string,
): Promise<boolean> {
  try {
    await git("rev-parse", "--verify", `origin/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up: go back to base branch.
 */
export async function returnToBaseBranch(): Promise<void> {
  log("info", `Returning to ${BASE_BRANCH}`);
  await git("checkout", BASE_BRANCH);
}

/**
 * Delete a local branch.
 */
export async function deleteLocalBranch(branchName: string): Promise<void> {
  try {
    await git("branch", "-D", branchName);
    log("info", `Deleted local branch: ${branchName}`);
  } catch {
    log("debug", `Could not delete branch ${branchName} (may not exist)`);
  }
}

/**
 * Merge a pull request by its URL using the gh CLI.
 * Merge strategy is configurable via MERGE_STRATEGY env var (squash, merge, rebase).
 */
export async function mergePullRequest(prUrl: string): Promise<void> {
  const strategyFlag = MERGE_STRATEGY === "rebase" ? "--rebase"
    : MERGE_STRATEGY === "merge" ? "--merge"
    : "--squash";

  log("info", `Merging PR (${MERGE_STRATEGY}): ${prUrl}`);
  await gh("pr", "merge", prUrl, strategyFlag, "--delete-branch", "--admin");
  log("info", `PR merged successfully: ${prUrl}`);
}

/**
 * Get the status of a pull request (open, closed, merged).
 */
export async function getPRState(prUrl: string): Promise<string> {
  const state = await gh(
    "pr",
    "view",
    prUrl,
    "--json",
    "state",
    "--jq",
    ".state",
  );
  return state.toLowerCase();
}
