// Git and GitHub operations for task automation

import { execFile } from "child_process";
import { promisify } from "util";
import { BASE_BRANCH, BRANCH_PREFIX, GIT_ROOT, DRY_RUN, GITHUB_REPO } from "./config.js";
import { log } from "./logger.js";
import type { PullRequestOptions, StackLinkPlan, StackLinkResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Run a git command in a specific working directory.
 * Used to target worktree slots when MAX_CONCURRENT_TASKS > 1.
 */
async function gitAt(cwd: string, ...args: string[]): Promise<string> {
  log("debug", `$ git ${args.join(" ")} (cwd: ${cwd})`);
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
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
 * Run a git command from the repository root.
 * Uses GIT_ROOT (repo root) so git operations work correctly in monorepos.
 */
async function git(...args: string[]): Promise<string> {
  return gitAt(GIT_ROOT, ...args);
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
export async function ensureCleanState(cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would ensure git state is clean");
    return;
  }
  const dir = cwd ?? GIT_ROOT;
  log("info", "Ensuring git state is clean before proceeding");

  // Abort any in-progress merge
  try {
    await gitAt(dir, "merge", "--abort");
    log("info", "Aborted in-progress merge");
  } catch {
    // No merge in progress — ignore
  }

  // Abort any in-progress rebase
  try {
    await gitAt(dir, "rebase", "--abort");
    log("info", "Aborted in-progress rebase");
  } catch {
    // No rebase in progress — ignore
  }

  // Abort any in-progress cherry-pick
  try {
    await gitAt(dir, "cherry-pick", "--abort");
    log("info", "Aborted in-progress cherry-pick");
  } catch {
    // No cherry-pick in progress — ignore
  }

  // Reset index and working tree to HEAD
  try {
    await gitAt(dir, "reset", "--hard", "HEAD");
  } catch {
    // If reset --hard HEAD fails (e.g. invalid HEAD), try without ref
    try {
      await gitAt(dir, "reset", "--hard");
    } catch (err) {
      log("warn", `Failed to reset: ${(err as Error).message}`);
    }
  }

  // Clean untracked files and directories
  try {
    await gitAt(dir, "clean", "-fd");
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
export async function syncBaseBranch(cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would sync base branch: ${BASE_BRANCH}`);
    return;
  }
  const dir = cwd ?? GIT_ROOT;
  log("info", `Syncing base branch: ${BASE_BRANCH}`);
  await ensureCleanState(dir);

  // Fetch all refs from origin (not just base branch) so that remote branch
  // lookups (e.g. findBranchForTask) have up-to-date information.
  // Use --prune to clean up stale remote tracking refs for deleted branches.
  try {
    await gitAt(dir, "fetch", "origin", "--prune");
  } catch {
    // Fall back to fetching just the base branch if full fetch fails
    await gitAt(dir, "fetch", "origin", BASE_BRANCH);
  }

  // Force checkout to bypass broken index (unresolved merges, etc.)
  try {
    await gitAt(dir, "checkout", "-f", BASE_BRANCH);
  } catch {
    // Local branch may not exist (e.g. all branches were deleted).
    // Create it from remote.
    try {
      await gitAt(dir, "checkout", "-f", "-B", BASE_BRANCH, `origin/${BASE_BRANCH}`);
    } catch (err) {
      throw new Error(`Cannot checkout ${BASE_BRANCH}: ${(err as Error).message}`);
    }
  }

  await gitAt(dir, "reset", "--hard", `origin/${BASE_BRANCH}`);
}

/**
 * Create and checkout a new branch for a task.
 * Branch name format: {prefix}/CU-{task-id}-{slug}
 * The CU-{id} prefix enables ClickUp's GitHub integration to auto-link
 * branches, commits, and PRs to the corresponding ClickUp task.
 *
 * When `baseRef` names a branch other than BASE_BRANCH (stacked-PR mode),
 * the new branch is created from that branch instead of the base branch.
 */
export async function createTaskBranch(
  taskId: string,
  slug: string,
  cwd?: string,
  baseRef?: string,
): Promise<string> {
  const branchName = `${BRANCH_PREFIX}/CU-${taskId}-${slug}`;
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create branch: ${branchName}`);
    return branchName;
  }
  const dir = cwd ?? GIT_ROOT;
  const isWorktree = dir !== GIT_ROOT;
  const stackedBase = baseRef && baseRef !== BASE_BRANCH ? baseRef : null;
  log("info", `Creating branch: ${branchName}${stackedBase ? ` (from ${stackedBase})` : ""}`);

  if (stackedBase) {
    // Stacked mode: start from the previous branch in the stack. It was
    // pushed when its own task succeeded, so origin has it if local is stale.
    await checkoutExistingBranch(stackedBase, dir);
  } else if (!isWorktree) {
    // For the main checkout, sync base before branching. For a slot worktree,
    // the runner has already done `resetSlotToBase(dir)` before calling us —
    // syncing again would attempt `checkout BASE_BRANCH`, which git refuses
    // when the branch is checked out elsewhere.
    await syncBaseBranch(dir);
  }

  // Check if a branch for this task already exists (local or remote)
  const existingBranch = await findBranchForTask(taskId);
  if (existingBranch) {
    log("info", `Branch already exists for task ${taskId}: ${existingBranch}. Checking it out.`);
    await checkoutExistingBranch(existingBranch, dir);
    return existingBranch;
  }

  // Create new branch from current HEAD (which is at base ref).
  await gitAt(dir, "checkout", "-b", branchName);

  return branchName;
}

/**
 * Check if the working directory has changes.
 */
export async function hasChanges(cwd?: string): Promise<boolean> {
  const status = await gitAt(cwd ?? GIT_ROOT, "status", "--porcelain");
  return status.length > 0;
}

/**
 * Get the current HEAD commit hash (full SHA).
 * Used to detect if Claude committed changes via Bash.
 */
export async function getHeadHash(cwd?: string): Promise<string> {
  return gitAt(cwd ?? GIT_ROOT, "rev-parse", "HEAD");
}

/**
 * Get a summary of changes between the base branch and HEAD (for PR description).
 * Diffs {base}...HEAD so it works correctly after commits have been made.
 * Pass `baseRef` to diff against another branch (stacked-PR mode), so a
 * stacked PR's summary shows only its own delta.
 */
export async function getChangesSummary(cwd?: string, baseRef?: string): Promise<{
  stat: string;
  files: string[];
}> {
  const dir = cwd ?? GIT_ROOT;
  const base = baseRef || BASE_BRANCH;
  const diffStat = await gitAt(dir, "diff", "--stat", `${base}...HEAD`);
  const filesChanged = await gitAt(dir, "diff", "--name-only", `${base}...HEAD`);
  return {
    stat: diffStat,
    files: filesChanged.split("\n").filter(Boolean),
  };
}

/**
 * Stage all changes and commit.
 */
export async function commitChanges(message: string, cwd?: string): Promise<string> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would commit: ${message}`);
    return "dry-run";
  }
  const dir = cwd ?? GIT_ROOT;
  log("info", "Staging and committing changes");
  await gitAt(dir, "add", "-A");
  await gitAt(dir, "commit", "-m", message);
  const hash = await gitAt(dir, "rev-parse", "--short", "HEAD");
  log("info", `Committed: ${hash}`);
  return hash;
}

/**
 * Push the current branch to origin with retry logic.
 */
export async function pushBranch(branchName: string, cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would push branch: ${branchName}`);
    return;
  }
  const dir = cwd ?? GIT_ROOT;
  const delays = [2000, 4000, 8000, 16000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      log("info", `Pushing ${branchName} (attempt ${attempt + 1})`);
      await gitAt(dir, "push", "-u", "origin", branchName);
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

// --- Native GitHub stacked PRs (public preview) ---
// A "native stack" is explicit GitHub metadata linking a bottom-up series of
// PRs: merging a lower layer automatically rebases and retargets the layers
// above it, and reviewers get the stack map UI. Stack actions (creating a
// stack, appending layers) go through the official `gh stack` extension —
// `gh stack link` chains the already-created PRs — so stack runs require
// the extension to be installed (the runner offers to install it and
// aborts otherwise). Only the read-only membership lookup uses the Stacks
// REST API via `gh api`, because the extension has no non-interactive
// membership query. Plain chained PRs (each targeting the previous branch)
// are NOT recognized as a stack, and only retarget on merge when the
// merged head branch is deleted.

/** Official GitHub CLI extension providing the `gh stack` commands. */
export const GH_STACK_EXTENSION_REPO = "github/gh-stack";

/** Command a user runs to install the `gh stack` extension. */
export const GH_STACK_INSTALL_COMMAND = `gh extension install ${GH_STACK_EXTENSION_REPO}`;

/**
 * Decide from `gh extension list` output whether the `gh stack` extension
 * is installed. gh derives an extension's command name from its repository
 * name (gh-stack → `gh stack`), so any listed repository with basename
 * "gh-stack" provides the command — the official github/gh-stack or a
 * fork alike.
 */
export function parseGhStackInstalled(extensionList: string): boolean {
  return extensionList
    .split("\n")
    .some((line) =>
      line.split(/\s+/).some((field) => /^(?:[^\s/]+\/)?gh-stack$/i.test(field)),
    );
}

/**
 * Check whether the `gh stack` extension is installed.
 * `gh extension list` exits non-zero when no extensions are installed at
 * all — that (like a missing gh) reads as "not installed".
 */
export async function isGhStackInstalled(): Promise<boolean> {
  try {
    return parseGhStackInstalled(await gh("extension", "list"));
  } catch {
    return false;
  }
}

/**
 * Install the official `gh stack` extension. Throws when the install
 * fails (gh missing, no network, ...).
 */
export async function installGhStackExtension(): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would run: ${GH_STACK_INSTALL_COMMAND}`);
    return;
  }
  log("info", `Installing the gh stack extension: ${GH_STACK_INSTALL_COMMAND}`);
  try {
    await execFileAsync("gh", ["extension", "install", GH_STACK_EXTENSION_REPO], {
      cwd: GIT_ROOT,
      timeout: 120000,
    });
  } catch (err) {
    throw new Error(`${GH_STACK_INSTALL_COMMAND} failed: ${(err as Error).message}`);
  }
  log("info", "gh stack extension installed.");
}

/**
 * Extract the pull request number from a GitHub PR URL.
 */
export function parsePRNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Select the PR URLs of a stacked series that can be linked natively: the
 * trailing run of entries that carry an open PR. An entry without a PR
 * breaks the chain, and everything below the break is unlinkable because
 * each stack layer must target the head of the layer beneath it.
 */
export function selectLinkablePrUrls(entries: Array<{ prUrl?: string }>): string[] {
  const urls: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const prUrl = entries[i]?.prUrl;
    if (!prUrl) break;
    urls.unshift(prUrl);
  }
  return urls;
}

/**
 * Decide how to link a bottom-up series of PRs given each PR's current
 * stack membership: create a new stack, extend the stack the series
 * already bottoms out in (a resumed run), or nothing.
 */
export function planStackLink(
  entries: Array<{ prNumber: number; stackNumber: number | null }>,
): StackLinkPlan {
  if (entries.length === 0) {
    return { action: "skip", reason: "no open PRs in the series" };
  }

  const stacked = entries.filter((e) => e.stackNumber !== null);
  if (stacked.length === 0) {
    if (entries.length < 2) {
      return { action: "skip", reason: "a stack needs at least two open PRs" };
    }
    return { action: "create", prNumbers: entries.map((e) => e.prNumber) };
  }

  const stackNumber = stacked[0]!.stackNumber!;
  if (stacked.some((e) => e.stackNumber !== stackNumber)) {
    return { action: "skip", reason: "the series spans multiple existing stacks" };
  }

  // New layers can only be appended on top, so already-stacked PRs must
  // form the bottom of the series.
  const firstNew = entries.findIndex((e) => e.stackNumber === null);
  if (firstNew === -1) {
    return {
      action: "already-linked",
      stackNumber,
      prNumbers: entries.map((e) => e.prNumber),
    };
  }
  if (entries.slice(firstNew).some((e) => e.stackNumber !== null)) {
    return {
      action: "skip",
      reason: `PRs already in stack #${stackNumber} are not at the bottom of the series`,
    };
  }
  return {
    action: "extend",
    stackNumber,
    prNumbers: entries.slice(firstNew).map((e) => e.prNumber),
  };
}

/** Resolve the owner/repo slug for Stacks API calls. */
async function resolveRepoSlug(): Promise<string> {
  return GITHUB_REPO || (await detectGitHubRepo());
}

/**
 * Look up which native stack (if any) a PR belongs to.
 */
async function getStackNumberForPR(
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const out = await gh(
    "api",
    `repos/${repo}/stacks?pull_request=${prNumber}&per_page=1`,
  );
  const stacks: unknown = JSON.parse(out || "[]");
  if (!Array.isArray(stacks) || stacks.length === 0) return null;
  const num = (stacks[0] as { number?: unknown }).number;
  return typeof num === "number" ? num : null;
}

/**
 * Arguments (after `gh`) for the `gh stack link` invocation realizing a
 * create or extend plan. PRs are passed bottom-to-top as URLs — never bare
 * numbers, which `gh stack link` would read as a stack number in first
 * position. Extending passes the existing stack's number first, appending
 * the new layers on top; creating pins the bottom layer's base branch
 * explicitly (the extension defaults to the repository's default branch).
 */
export function ghStackLinkArgs(
  plan:
    | { action: "create"; baseBranch: string }
    | { action: "extend"; stackNumber: number },
  prUrls: string[],
): string[] {
  return plan.action === "create"
    ? ["stack", "link", "--base", plan.baseBranch, ...prUrls]
    : ["stack", "link", String(plan.stackNumber), ...prUrls];
}

/**
 * Create a native stack from a bottom-up list of PR URLs via
 * `gh stack link`. Returns the new stack's number, read back from the
 * Stacks API afterwards (the extension prints human-readable output, not
 * the number) — null when the read-back fails, which doesn't undo the
 * successful link.
 */
async function createStackFromPRs(
  repo: string,
  prUrls: string[],
  bottomPrNumber: number,
): Promise<number | null> {
  await gh(...ghStackLinkArgs({ action: "create", baseBranch: BASE_BRANCH }, prUrls));
  try {
    return await getStackNumberForPR(repo, bottomPrNumber);
  } catch {
    return null;
  }
}

/**
 * Append PRs (bottom-to-top URLs) onto the top of an existing native stack
 * via `gh stack link <stack-number> ...`.
 */
async function addPRsToStack(
  stackNumber: number,
  prUrls: string[],
): Promise<void> {
  await gh(...ghStackLinkArgs({ action: "extend", stackNumber }, prUrls));
}

/**
 * Link a bottom-up series of open PRs into a native GitHub stack via
 * `gh stack link`, creating a new stack or extending the one a resumed
 * series already sits in. Never throws: failures (including stacked PRs
 * being unavailable on this repository — the feature is in public
 * preview) come back as a result the caller can report, and the chained
 * PRs keep working as-is.
 */
export async function linkStackPRs(prUrls: string[]): Promise<StackLinkResult> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would link ${prUrls.length} PR(s) into a native stack`);
    return { outcome: "skipped", reason: "dry run" };
  }

  const prNumbers: number[] = [];
  const urlByNumber = new Map<number, string>();
  for (const url of prUrls) {
    const n = parsePRNumber(url);
    if (n === null) {
      return { outcome: "skipped", reason: `could not parse a PR number from ${url}` };
    }
    prNumbers.push(n);
    urlByNumber.set(n, url);
  }
  if (prNumbers.length < 2) {
    return { outcome: "skipped", reason: "a native stack needs at least two open PRs" };
  }

  try {
    const repo = await resolveRepoSlug();

    const entries: Array<{ prNumber: number; stackNumber: number | null }> = [];
    for (const prNumber of prNumbers) {
      entries.push({ prNumber, stackNumber: await getStackNumberForPR(repo, prNumber) });
    }

    const plan = planStackLink(entries);
    switch (plan.action) {
      case "create": {
        const urls = plan.prNumbers.map((n) => urlByNumber.get(n)!);
        const stackNumber = await createStackFromPRs(repo, urls, plan.prNumbers[0]!);
        return { outcome: "created", stackNumber, prNumbers: plan.prNumbers };
      }
      case "extend": {
        const urls = plan.prNumbers.map((n) => urlByNumber.get(n)!);
        await addPRsToStack(plan.stackNumber, urls);
        return {
          outcome: "extended",
          stackNumber: plan.stackNumber,
          prNumbers: plan.prNumbers,
        };
      }
      case "already-linked":
        return {
          outcome: "already-linked",
          stackNumber: plan.stackNumber,
          prNumbers: plan.prNumbers,
        };
      case "skip":
        return { outcome: "skipped", reason: plan.reason };
    }
  } catch (err) {
    const message = (err as Error).message;
    if (/unknown command "?stack"?/i.test(message)) {
      // The extension disappeared between the run's up-front check and the
      // linking step — report instead of crashing the finished run.
      return {
        outcome: "failed",
        reason: `the gh stack extension is not installed (install: ${GH_STACK_INSTALL_COMMAND})`,
      };
    }
    if (/HTTP 404/.test(message)) {
      return {
        outcome: "unavailable",
        reason:
          "the Stacks API returned 404 — stacked pull requests (public preview) " +
          "may not be enabled for this repository yet",
      };
    }
    return { outcome: "failed", reason: message };
  }
}

/**
 * Create an empty commit (used to enable early PR creation).
 */
export async function createEmptyCommit(message: string, cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create empty commit: ${message}`);
    return;
  }
  log("info", "Creating empty initial commit for early PR");
  await gitAt(cwd ?? GIT_ROOT, "commit", "--allow-empty", "-m", message);
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
export async function isWorkingTreeClean(cwd?: string): Promise<boolean> {
  const status = await gitAt(cwd ?? GIT_ROOT, "status", "--porcelain", "-uno");
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
  cwd?: string,
): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would checkout branch: ${branchName}`);
    return;
  }
  const dir = cwd ?? GIT_ROOT;
  log("info", `Checking out existing branch: ${branchName}`);

  // Fetch latest for this branch from origin
  try {
    await gitAt(dir, "fetch", "origin", branchName);
  } catch {
    log("debug", `Could not fetch ${branchName} from origin (may be local-only)`);
  }

  // Force checkout to bypass dirty index state
  try {
    await gitAt(dir, "checkout", "-f", branchName);
  } catch {
    // If local checkout fails, create a tracking branch from remote
    await gitAt(dir, "checkout", "-f", "-b", branchName, `origin/${branchName}`);
  }

  // Reset to the latest remote version if it exists
  try {
    await gitAt(dir, "reset", "--hard", `origin/${branchName}`);
    log("info", `Reset ${branchName} to latest from origin`);
  } catch {
    // Branch may not exist on remote — local-only branch is fine
    log("debug", `No remote tracking for ${branchName} — using local version`);
  }
}

/**
 * Check if the current branch has commits ahead of the base branch.
 */
export async function branchHasCommitsAheadOfBase(cwd?: string): Promise<boolean> {
  const output = await gitAt(cwd ?? GIT_ROOT, "log", `${BASE_BRANCH}..HEAD`, "--oneline");
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
 * Resolve a ref to a commit SHA, preferring the local ref and falling back
 * to origin/{ref}. Returns null when neither resolves.
 */
async function resolveRefToSha(ref: string, cwd: string): Promise<string | null> {
  for (const candidate of [ref, `origin/${ref}`]) {
    try {
      return await gitAt(cwd, "rev-parse", "--verify", `${candidate}^{commit}`);
    } catch {
      // Try the next candidate
    }
  }
  return null;
}

/**
 * Check whether `ancestorRef` is an ancestor of `descendantRef`.
 * Each ref is resolved locally first, then via origin/ (branches adopted
 * during a stack resume may exist only on the remote). Returns false when
 * either ref cannot be resolved or the check fails.
 */
export async function isAncestor(
  ancestorRef: string,
  descendantRef: string,
  cwd?: string,
): Promise<boolean> {
  const dir = cwd ?? GIT_ROOT;
  const ancestorSha = await resolveRefToSha(ancestorRef, dir);
  const descendantSha = await resolveRefToSha(descendantRef, dir);
  if (!ancestorSha || !descendantSha) return false;
  try {
    await gitAt(dir, "merge-base", "--is-ancestor", ancestorSha, descendantSha);
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
export async function returnToBaseBranch(cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would return to ${BASE_BRANCH}`);
    return;
  }
  const dir = cwd ?? GIT_ROOT;
  const isWorktree = dir !== GIT_ROOT;
  log("info", `Returning to ${BASE_BRANCH}`);
  await ensureCleanState(dir);

  // Worktrees can't share a branch checkout with the main tree, so use a
  // detached HEAD at the remote base ref instead of checking out the branch.
  if (isWorktree) {
    try {
      await gitAt(dir, "fetch", "origin", BASE_BRANCH);
    } catch {
      // If fetch fails, fall through and try to use whatever we have locally.
    }
    await gitAt(dir, "checkout", "-f", "--detach", `origin/${BASE_BRANCH}`);
    return;
  }

  try {
    await gitAt(dir, "checkout", "-f", BASE_BRANCH);
  } catch {
    // Local branch may not exist — create from remote
    await gitAt(dir, "checkout", "-f", "-B", BASE_BRANCH, `origin/${BASE_BRANCH}`);
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
 * Attempt to merge the base branch into the current branch.
 * Returns true if merge completed cleanly, false if there are conflicts.
 */
export async function mergeBaseBranch(cwd?: string): Promise<boolean> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would merge ${BASE_BRANCH} into current branch`);
    return true;
  }
  const dir = cwd ?? GIT_ROOT;
  log("info", `Merging ${BASE_BRANCH} into current branch`);
  await gitAt(dir, "fetch", "origin", BASE_BRANCH);
  try {
    await gitAt(dir, "merge", `origin/${BASE_BRANCH}`, "--no-edit");
    log("info", "Merge completed cleanly — no conflicts");
    return true;
  } catch (err) {
    // Detect conflicts by checking for unmerged files rather than parsing
    // error messages, because the git() wrapper loses stdout/stderr details
    // where conflict info appears.
    try {
      const conflicted = await getConflictedFiles(dir);
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
export async function getConflictedFiles(cwd?: string): Promise<string[]> {
  const output = await gitAt(cwd ?? GIT_ROOT, "diff", "--name-only", "--diff-filter=U");
  return output.split("\n").filter(Boolean);
}

/**
 * Abort an in-progress merge.
 */
export async function abortMerge(cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would abort merge");
    return;
  }
  log("info", "Aborting merge");
  await gitAt(cwd ?? GIT_ROOT, "merge", "--abort");
}

/**
 * Stage resolved files and commit the merge.
 */
export async function commitMergeResolution(cwd?: string): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would commit merge resolution");
    return;
  }
  const dir = cwd ?? GIT_ROOT;
  log("info", "Committing merge resolution");
  await gitAt(dir, "add", "-A");
  await gitAt(dir, "commit", "--no-edit");
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
 * Returns an array of review comments with author, body, creation date, and
 * review state (APPROVED, CHANGES_REQUESTED, COMMENTED, ...).
 */
export async function getPRReviewComments(
  prUrl: string,
): Promise<Array<{ author: string; body: string; createdAt: string; state?: string }>> {
  try {
    const result = await gh(
      "pr",
      "view",
      prUrl,
      "--json",
      "reviews",
      "--jq",
      '[.reviews[] | select(.body != "") | {author: .author.login, body: .body, createdAt: .submittedAt, state: .state}]',
    );
    if (!result || result === "[]") return [];
    return JSON.parse(result) as Array<{ author: string; body: string; createdAt: string; state?: string }>;
  } catch {
    return [];
  }
}

/**
 * Filter GitHub comments/reviews to those created strictly after `sinceMs`
 * (epoch ms). Entries with a missing or unparsable createdAt are dropped —
 * without a timestamp they can't be proven new, and treating them as new
 * would re-trigger feedback processing on every poll cycle.
 * Pure helper used by the PR feedback poller.
 */
export function filterCommentsSince<T extends { createdAt: string }>(
  comments: T[],
  sinceMs: number,
): T[] {
  return comments.filter((c) => {
    const createdMs = c.createdAt ? Date.parse(c.createdAt) : NaN;
    return !isNaN(createdMs) && createdMs > sinceMs;
  });
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

// --- Worktree helpers (parallel task processing) ---

/**
 * Create a new git worktree at `slotPath` checked out at `ref` (detached).
 * Used to give each concurrent task its own isolated working tree.
 * Detached HEAD avoids collisions when multiple slots share the base ref.
 */
export async function createWorktree(slotPath: string, ref: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would create worktree at ${slotPath} from ${ref}`);
    return;
  }
  log("info", `Creating worktree: ${slotPath} → ${ref}`);
  await git("worktree", "add", "--detach", slotPath, ref);
}

/**
 * Remove a worktree (forcefully — discards any local changes).
 */
export async function removeWorktree(slotPath: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would remove worktree at ${slotPath}`);
    return;
  }
  try {
    await git("worktree", "remove", "--force", slotPath);
    log("info", `Removed worktree: ${slotPath}`);
  } catch (err) {
    log("debug", `Could not remove worktree ${slotPath}: ${(err as Error).message}`);
  }
}

/**
 * Prune stale worktree registrations whose directories no longer exist.
 * Called at startup to clean up after crashes.
 */
export async function pruneWorktrees(): Promise<void> {
  if (DRY_RUN) {
    log("info", "[DRY RUN] Would prune worktrees");
    return;
  }
  try {
    await git("worktree", "prune");
  } catch (err) {
    log("warn", `Failed to prune worktrees: ${(err as Error).message}`);
  }
}

/**
 * Reset a slot worktree to the latest base ref, detached.
 * Called before reusing a slot for a new task — leaves the slot at a clean
 * `origin/<base>` so the subsequent `createTaskBranch` can branch off cleanly.
 */
export async function resetSlotToBase(slotPath: string): Promise<void> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would reset slot ${slotPath} to base`);
    return;
  }
  log("info", `Resetting slot to base: ${slotPath}`);
  await ensureCleanState(slotPath);
  try {
    await gitAt(slotPath, "fetch", "origin", BASE_BRANCH);
  } catch {
    // Network hiccup — use whatever local ref we have.
  }
  await gitAt(slotPath, "checkout", "-f", "--detach", `origin/${BASE_BRANCH}`);
}
