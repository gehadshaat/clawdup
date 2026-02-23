// Git and GitHub operations for task automation

import { execFile } from "child_process";
import { promisify } from "util";
import { BASE_BRANCH, BRANCH_PREFIX, GIT_ROOT, log } from "./config.js";
import type { PullRequestOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Run a git command from the repository root.
 * Uses GIT_ROOT (repo root) so git operations work correctly in monorepos.
 */
async function git(...args: string[]): Promise<string> {
  log("info", `$ git ${args.join(" ")}`);
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
  log("info", `$ gh ${args.join(" ")}`);
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

  // Check if a branch for this task already exists (local or remote)
  const existingBranch = await findBranchForTask(taskId);
  if (existingBranch) {
    log("info", `Branch already exists for task ${taskId}: ${existingBranch}. Checking it out.`);
    await checkoutExistingBranch(existingBranch);
    return existingBranch;
  }

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
 * Get the current HEAD commit hash (full SHA).
 * Used to detect if Claude committed changes via Bash.
 */
export async function getHeadHash(): Promise<string> {
  return git("rev-parse", "HEAD");
}

/**
 * Get a summary of changes between the base branch and HEAD (for PR description).
 * Diffs BASE_BRANCH...HEAD so it works correctly after commits have been made.
 */
export async function getChangesSummary(): Promise<{
  stat: string;
  files: string[];
}> {
  const diffStat = await git("diff", "--stat", `${BASE_BRANCH}...HEAD`);
  const filesChanged = await git("diff", "--name-only", `${BASE_BRANCH}...HEAD`);
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
  draft,
}: PullRequestOptions): Promise<string> {
  log("info", `Creating PR: "${title}"${draft ? " (draft)" : ""}`);
  const args = [
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
  ];
  if (draft) {
    args.push("--draft");
  }
  const prUrl = await gh(...args);
  log("info", `PR created: ${prUrl}`);
  return prUrl;
}

/**
 * Create an empty commit (used to enable early PR creation).
 */
export async function createEmptyCommit(message: string): Promise<void> {
  log("info", "Creating empty initial commit for early PR");
  await git("commit", "--allow-empty", "-m", message);
}

/**
 * Mark a draft PR as ready for review.
 */
export async function markPRReady(prUrl: string): Promise<void> {
  log("info", `Marking PR as ready for review: ${prUrl}`);
  await gh("pr", "ready", prUrl);
}

/**
 * Close a pull request without merging.
 */
export async function closePullRequest(prUrl: string): Promise<void> {
  log("info", `Closing PR: ${prUrl}`);
  await gh("pr", "close", prUrl);
}

/**
 * Update a pull request's title and/or body.
 */
export async function updatePullRequest(
  prUrl: string,
  { title, body }: { title?: string; body?: string },
): Promise<void> {
  log("info", `Updating PR: ${prUrl}`);
  const args = ["pr", "edit", prUrl];
  if (title) {
    args.push("--title", title);
  }
  if (body) {
    args.push("--body", body);
  }
  await gh(...args);
}

/**
 * Find an existing open PR for a branch.
 * Returns the PR URL or null if none exists.
 */
export async function findExistingPR(
  branchName: string,
): Promise<string | null> {
  try {
    const prUrl = await gh(
      "pr",
      "view",
      branchName,
      "--json",
      "url",
      "--jq",
      ".url",
    );
    return prUrl || null;
  } catch {
    return null;
  }
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
 * Check if a merge is in progress.
 */
export async function isInMergeState(): Promise<boolean> {
  try {
    await git("rev-parse", "--verify", "MERGE_HEAD");
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the working tree is in a clean state so we can switch branches.
 * This handles common dirty states:
 *  - Abort any in-progress merge
 *  - Discard uncommitted changes (staged and unstaged)
 * Call this before operations that require a clean checkout (e.g. returnToBaseBranch).
 */
export async function ensureCleanState(): Promise<void> {
  // Abort in-progress merge if any
  if (await isInMergeState()) {
    log("warn", "Detected in-progress merge — aborting to restore clean state");
    try {
      await git("merge", "--abort");
    } catch {
      log("debug", "merge --abort failed (may already be resolved)");
    }
  }

  // Discard any uncommitted changes (staged + unstaged + untracked)
  const status = await git("status", "--porcelain");
  if (status.length > 0) {
    log("warn", "Detected uncommitted changes — discarding to restore clean state");
    await git("reset", "--hard", "HEAD");
    await git("clean", "-fd");
  }
}

/**
 * Clean up: go back to base branch.
 * Ensures any dirty state (in-progress merge, uncommitted changes) is cleaned up first.
 */
export async function returnToBaseBranch(): Promise<void> {
  log("info", `Returning to ${BASE_BRANCH}`);
  await ensureCleanState();
  await git("checkout", BASE_BRANCH);
}

/**
 * Delete a branch both locally and on the remote (best-effort).
 * Used when starting from scratch on a task.
 */
export async function deleteBranchFully(branchName: string): Promise<void> {
  // Delete local branch
  try {
    await git("branch", "-D", branchName);
    log("info", `Deleted local branch: ${branchName}`);
  } catch {
    log("debug", `Could not delete local branch ${branchName} (may not exist)`);
  }

  // Delete remote branch (best-effort)
  try {
    await git("push", "origin", "--delete", branchName);
    log("info", `Deleted remote branch: ${branchName}`);
  } catch {
    log("debug", `Could not delete remote branch ${branchName} (may not exist)`);
  }
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
 * Uses squash merge by default for a clean history.
 */
export async function mergePullRequest(prUrl: string): Promise<void> {
  log("info", `Merging PR: ${prUrl}`);
  await gh("pr", "merge", prUrl, "--squash", "--delete-branch", "--admin");
  log("info", `PR merged successfully: ${prUrl}`);
}

/**
 * Check if the PR is mergeable (no conflicts with base branch).
 * Returns "MERGEABLE", "CONFLICTING", or "UNKNOWN".
 */
export async function getPRMergeability(prUrl: string): Promise<string> {
  try {
    const result = await gh(
      "pr",
      "view",
      prUrl,
      "--json",
      "mergeable",
      "--jq",
      ".mergeable",
    );
    return result.toUpperCase();
  } catch {
    return "UNKNOWN";
  }
}

/**
 * Attempt to merge the base branch into the current branch.
 * Returns true if merge completed cleanly, false if there are conflicts.
 */
export async function mergeBaseBranch(): Promise<boolean> {
  log("info", `Merging ${BASE_BRANCH} into current branch`);
  await git("fetch", "origin", BASE_BRANCH);
  try {
    await git("merge", `origin/${BASE_BRANCH}`, "--no-edit");
    log("info", "Merge completed cleanly — no conflicts");
    return true;
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("CONFLICT") || message.includes("Automatic merge failed")) {
      log("warn", "Merge resulted in conflicts");
      return false;
    }
    // If the error is not about conflicts, rethrow
    throw err;
  }
}

/**
 * Get the list of files with merge conflicts.
 */
export async function getConflictedFiles(): Promise<string[]> {
  const output = await git("diff", "--name-only", "--diff-filter=U");
  return output.split("\n").filter(Boolean);
}

/**
 * Abort an in-progress merge.
 */
export async function abortMerge(): Promise<void> {
  log("info", "Aborting merge");
  await git("merge", "--abort");
}

/**
 * Stage resolved files and commit the merge.
 */
export async function commitMergeResolution(): Promise<void> {
  log("info", "Committing merge resolution");
  await git("add", "-A");
  await git("commit", "--no-edit");
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

/**
 * Get the review decision for a pull request.
 * Returns "CHANGES_REQUESTED", "APPROVED", "REVIEW_REQUIRED", or "NONE".
 * "NONE" means no reviews have been submitted yet.
 */
export async function getPRReviewDecision(prUrl: string): Promise<string> {
  try {
    const result = await gh(
      "pr",
      "view",
      prUrl,
      "--json",
      "reviewDecision",
      "--jq",
      ".reviewDecision",
    );
    return result ? result.toUpperCase() : "NONE";
  } catch {
    return "NONE";
  }
}

/**
 * Get review comments from a pull request.
 * Returns an array of review comments with author, body, and creation date.
 */
export async function getPRReviewComments(
  prUrl: string,
): Promise<Array<{ author: string; body: string; createdAt: string }>> {
  try {
    const result = await gh(
      "pr",
      "view",
      prUrl,
      "--json",
      "reviews",
      "--jq",
      '[.reviews[] | select(.body != "") | {author: .author.login, body: .body, createdAt: .submittedAt}]',
    );
    if (!result || result === "[]") return [];
    return JSON.parse(result) as Array<{ author: string; body: string; createdAt: string }>;
  } catch {
    return [];
  }
}

/**
 * Get inline review comments (code-level comments) from a pull request.
 * Uses the GitHub API via gh to fetch review comments on the diff.
 */
export async function getPRInlineComments(
  prUrl: string,
): Promise<Array<{ author: string; body: string; path: string; line: number | null; createdAt: string }>> {
  try {
    // Extract owner/repo and PR number from the URL
    const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) return [];
    const [, repo, prNumber] = match;

    const result = await gh(
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--jq",
      '[.[] | {author: .user.login, body: .body, path: .path, line: .line, createdAt: .created_at}]',
    );
    if (!result || result === "[]") return [];
    return JSON.parse(result) as Array<{ author: string; body: string; path: string; line: number | null; createdAt: string }>;
  } catch {
    return [];
  }
}
