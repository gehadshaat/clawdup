// Git and GitHub operations for task automation

import { execFile } from "child_process";
import { promisify } from "util";
import { BASE_BRANCH, BRANCH_PREFIX, GIT_ROOT, DRY_RUN } from "./config.js";
import { log } from "./logger.js";
import type { PullRequestOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Run a git command from the repository root.
 * Uses GIT_ROOT (repo root) so git operations work correctly in monorepos.
 */
async function git(...args: string[]): Promise<string> {
  log("debug", `$ git ${args.join(" ")}`);
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
  log("debug", `$ gh ${args.join(" ")}`);
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
 * Ensure the git working tree and index are in a clean state.
 * Aborts any in-progress merge/rebase/cherry-pick, resets the index,
 * and cleans untracked files. This is a forceful recovery operation
 * that allows subsequent git operations (checkout, branch) to succeed
 * even after a crash or interrupted operation.
 */
export async function ensureCleanState(): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would ensure git state is clean");
    return;
  }
  log("info", "Ensuring git state is clean before proceeding");

  // Abort any in-progress merge
  try {
    await git("merge", "--abort");
    log("info", "Aborted in-progress merge");
  } catch {
    // No merge in progress — ignore
  }

  // Abort any in-progress rebase
  try {
    await git("rebase", "--abort");
    log("info", "Aborted in-progress rebase");
  } catch {
    // No rebase in progress — ignore
  }

  // Abort any in-progress cherry-pick
  try {
    await git("cherry-pick", "--abort");
    log("info", "Aborted in-progress cherry-pick");
  } catch {
    // No cherry-pick in progress — ignore
  }

  // Reset index and working tree to HEAD
  try {
    await git("reset", "--hard", "HEAD");
  } catch {
    // If reset --hard HEAD fails (e.g. invalid HEAD), try without ref
    try {
      await git("reset", "--hard");
    } catch (err) {
      log("warn", `Failed to reset: ${(err as Error).message}`);
    }
  }

  // Clean untracked files and directories
  try {
    await git("clean", "-fd");
  } catch (err) {
    log("warn", `Failed to clean untracked files: ${(err as Error).message}`);
  }
}

/**
 * Ensure we're on the base branch and it's up to date.
 * Forcefully cleans any dirty state first so checkout always succeeds.
 * Uses force checkout (-f) to bypass broken index states (e.g. unresolved merges).
 * Falls back to creating the local branch from remote if it doesn't exist locally.
 */
export async function syncBaseBranch(): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would sync base branch: ${BASE_BRANCH}`);
    return;
  }
  log("info", `Syncing base branch: ${BASE_BRANCH}`);
  await ensureCleanState();

  // Fetch all refs from origin (not just base branch) so that remote branch
  // lookups (e.g. findBranchForTask) have up-to-date information.
  // Use --prune to clean up stale remote tracking refs for deleted branches.
  try {
    await git("fetch", "origin", "--prune");
  } catch {
    // Fall back to fetching just the base branch if full fetch fails
    await git("fetch", "origin", BASE_BRANCH);
  }

  // Force checkout to bypass broken index (unresolved merges, etc.)
  try {
    await git("checkout", "-f", BASE_BRANCH);
  } catch {
    // Local branch may not exist (e.g. all branches were deleted).
    // Create it from remote.
    try {
      await git("checkout", "-f", "-B", BASE_BRANCH, `origin/${BASE_BRANCH}`);
    } catch (err) {
      throw new Error(`Cannot checkout ${BASE_BRANCH}: ${(err as Error).message}`);
    }
  }

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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create branch: ${branchName}`);
    return branchName;
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would commit: ${message}`);
    return "dry-run";
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would push branch: ${branchName}`);
    return;
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create PR: "${title}"${draft ? " (draft)" : ""} (branch: ${branchName})`);
    return "https://github.com/dry-run/pull/0";
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create empty commit: ${message}`);
    return;
  }
  log("info", "Creating empty initial commit for early PR");
  await git("commit", "--allow-empty", "-m", message);
}

/**
 * Mark a draft PR as ready for review.
 */
export async function markPRReady(prUrl: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would mark PR as ready: ${prUrl}`);
    return;
  }
  log("info", `Marking PR as ready for review: ${prUrl}`);
  await gh("pr", "ready", prUrl);
}

/**
 * Close a pull request without merging.
 */
export async function closePullRequest(prUrl: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would close PR: ${prUrl}`);
    return;
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would update PR: ${prUrl}`);
    return;
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would checkout branch: ${branchName}`);
    return;
  }
  log("info", `Checking out existing branch: ${branchName}`);

  // Fetch latest for this branch from origin
  try {
    await git("fetch", "origin", branchName);
  } catch {
    log("debug", `Could not fetch ${branchName} from origin (may be local-only)`);
  }

  // Force checkout to bypass dirty index state
  try {
    await git("checkout", "-f", branchName);
  } catch {
    // If local checkout fails, create a tracking branch from remote
    await git("checkout", "-f", "-b", branchName, `origin/${branchName}`);
  }

  // Reset to the latest remote version if it exists
  try {
    await git("reset", "--hard", `origin/${branchName}`);
    log("info", `Reset ${branchName} to latest from origin`);
  } catch {
    // Branch may not exist on remote — local-only branch is fine
    log("debug", `No remote tracking for ${branchName} — using local version`);
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
 * Forcefully cleans any dirty state first so checkout always succeeds.
 * Uses force checkout (-f) to bypass broken index states.
 */
export async function returnToBaseBranch(): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would return to ${BASE_BRANCH}`);
    return;
  }
  log("info", `Returning to ${BASE_BRANCH}`);
  await ensureCleanState();
  try {
    await git("checkout", "-f", BASE_BRANCH);
  } catch {
    // Local branch may not exist — create from remote
    await git("checkout", "-f", "-B", BASE_BRANCH, `origin/${BASE_BRANCH}`);
  }
}

/**
 * Delete all local branches except the base branch.
 * This ensures a clean slate when starting, removing stale branches
 * left from previous runs that may no longer exist on the remote.
 */
export async function pruneLocalBranches(): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would prune local branches");
    return;
  }
  try {
    const output = await git("branch", "--list");
    const branches = output
      .split("\n")
      .map((b) => b.trim().replace(/^\*\s*/, ""))
      .filter((b) => b && b !== BASE_BRANCH);

    for (const branch of branches) {
      try {
        await git("branch", "-D", branch);
        log("info", `Pruned local branch: ${branch}`);
      } catch {
        log("debug", `Could not prune branch ${branch}`);
      }
    }

    if (branches.length > 0) {
      log("info", `Pruned ${branches.length} local branch(es)`);
    }
  } catch (err) {
    log("warn", `Failed to prune local branches: ${(err as Error).message}`);
  }
}

/**
 * Delete a local branch.
 */
export async function deleteLocalBranch(branchName: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would delete branch: ${branchName}`);
    return;
  }
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
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would merge PR: ${prUrl}`);
    return;
  }
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
 * Check the CI/check status of a pull request.
 * Returns an object with the overall status and any failing checks.
 * Uses `gh pr checks` to query GitHub Actions and other status checks.
 */
export async function getPRCheckStatus(prUrl: string): Promise<{
  passing: boolean;
  pending: boolean;
  failing: string[];
}> {
  try {
    // Query all check runs for the PR as JSON
    const result = await gh(
      "pr",
      "checks",
      prUrl,
      "--json",
      "name,state,conclusion",
      "--jq",
      '[.[] | {name, state, conclusion}]',
    );

    if (!result || result === "[]") {
      // No checks configured — treat as passing
      return { passing: true, pending: false, failing: [] };
    }

    const checks = JSON.parse(result) as Array<{
      name: string;
      state: string;
      conclusion: string;
    }>;

    const failing: string[] = [];
    let hasPending = false;

    for (const check of checks) {
      const state = (check.state || "").toUpperCase();
      const conclusion = (check.conclusion || "").toUpperCase();

      if (state === "PENDING" || state === "QUEUED" || state === "IN_PROGRESS") {
        hasPending = true;
      } else if (conclusion === "FAILURE" || conclusion === "CANCELLED" || conclusion === "TIMED_OUT") {
        failing.push(check.name);
      }
    }

    return {
      passing: failing.length === 0 && !hasPending,
      pending: hasPending,
      failing,
    };
  } catch {
    // If we can't determine check status, treat as unknown (passing)
    // to avoid blocking merges when gh checks aren't available
    return { passing: true, pending: false, failing: [] };
  }
}

/**
 * Get the head branch name for a pull request.
 */
export async function getPRHeadBranch(prUrl: string): Promise<string> {
  return gh("pr", "view", prUrl, "--json", "headRefName", "--jq", ".headRefName");
}

/**
 * Get the PR number from a PR URL.
 */
export async function getPRNumber(prUrl: string): Promise<number> {
  const result = await gh("pr", "view", prUrl, "--json", "number", "--jq", ".number");
  return parseInt(result, 10);
}

/**
 * Get the most recent failed workflow runs for a branch.
 * Returns run metadata including ID, name, URL, and conclusion.
 */
export async function getFailedWorkflowRuns(
  branchName: string,
  limit: number = 1,
): Promise<Array<{ databaseId: number; name: string; url: string; conclusion: string }>> {
  try {
    const result = await gh(
      "run", "list",
      "--branch", branchName,
      "--status", "failure",
      "--limit", String(limit),
      "--json", "databaseId,name,url,conclusion",
    );
    if (!result || result === "[]") return [];
    return JSON.parse(result) as Array<{ databaseId: number; name: string; url: string; conclusion: string }>;
  } catch {
    return [];
  }
}

/**
 * Get job details for a workflow run, including step-level info.
 * Only returns jobs that failed.
 */
export async function getWorkflowRunJobs(
  runId: number,
): Promise<Array<{ name: string; conclusion: string; steps: Array<{ name: string; conclusion: string }> }>> {
  try {
    const result = await gh(
      "run", "view", String(runId),
      "--json", "jobs",
      "--jq", '[.jobs[] | select(.conclusion == "failure") | {name, conclusion, steps: [.steps[] | {name, conclusion}]}]',
    );
    if (!result || result === "[]") return [];
    return JSON.parse(result) as Array<{ name: string; conclusion: string; steps: Array<{ name: string; conclusion: string }> }>;
  } catch {
    return [];
  }
}

/**
 * Attempt to merge the base branch into the current branch.
 * Returns true if merge completed cleanly, false if there are conflicts.
 */
export async function mergeBaseBranch(): Promise<boolean> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would merge ${BASE_BRANCH} into current branch`);
    return true;
  }
  log("info", `Merging ${BASE_BRANCH} into current branch`);
  await git("fetch", "origin", BASE_BRANCH);
  try {
    await git("merge", `origin/${BASE_BRANCH}`, "--no-edit");
    log("info", "Merge completed cleanly — no conflicts");
    return true;
  } catch (err) {
    // Detect conflicts by checking for unmerged files rather than parsing
    // error messages, because the git() wrapper loses stdout/stderr details
    // where conflict info appears.
    try {
      const conflicted = await getConflictedFiles();
      if (conflicted.length > 0) {
        log("warn", "Merge resulted in conflicts");
        return false;
      }
    } catch {
      // If we can't check for conflicts, fall through to rethrow
    }
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
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would abort merge");
    return;
  }
  log("info", "Aborting merge");
  await git("merge", "--abort");
}

/**
 * Stage resolved files and commit the merge.
 */
export async function commitMergeResolution(): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would commit merge resolution");
    return;
  }
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
