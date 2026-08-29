// Main task runner - orchestrates the full ClickUp -> Claude -> GitHub pipeline

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";
import { POLL_INTERVAL_MS, RELAUNCH_INTERVAL_MS, STATUS, BASE_BRANCH, PROJECT_ROOT, GIT_ROOT, CLICKUP_LIST_ID, CLICKUP_PARENT_TASK_ID, AUTO_APPROVE, ADDRESS_PR_COMMENTS, DRY_RUN, BRANCH_PREFIX, MAX_CONCURRENT_TASKS } from "./config.js";
import { log, startTimer } from "./logger.js";
import {
  getTasksByStatus,
  getTask,
  getTaskComments,
  updateTaskStatus,
  addTaskComment,
  notifyTaskCreator,
  formatTaskForClaude,
  slugify,
  isValidTaskId,
  validateStatuses,
  findPRUrlInComments,
  findPRUrlInCommentList,
  getLastAutomationCommentDate,
  createTask,
  getExistingTaskNames,
  getNewReviewFeedback,
  getCommentText,
  getUnresolvedDependencies,
  getAllTasksSummary,
  getRelatedTasksContext,
  getLeafSubtasks,
  orderTasksByDependencies,
} from "./clickup-api.js";
import {
  detectGitHubRepo,
  ensureCleanState,
  syncBaseBranch,
  pruneLocalBranches,
  createTaskBranch,
  hasChanges,
  getHeadHash,
  getChangesSummary,
  commitChanges,
  pushBranch,
  createPullRequest,
  markPRReady,
  closePullRequest,
  updatePullRequest,
  findExistingPR,
  returnToBaseBranch,
  deleteLocalBranch,
  mergePullRequest,
  getPRState,
  getPRMergeability,
  mergeBaseBranch,
  getConflictedFiles,
  abortMerge,
  commitMergeResolution,
  findBranchForTask,
  checkoutExistingBranch,
  branchHasCommitsAheadOfBase,
  branchHasBeenPushed,
  getPRReviewDecision,
  getPRReviewComments,
  getPRInlineComments,
  filterCommentsSince,
  getPRCheckStatus,
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  resetSlotToBase,
  isAncestor,
} from "./git-ops.js";
import {
  runClaudeOnTask,
  runClaudeOnConflictResolution,
  runClaudeOnReviewFeedback,
  extractNeedsInputReason,
  generateCommitMessage,
  generatePRBody,
  generateWorkSummary,
  generateStackPRNote,
  generateStackPromptContext,
} from "./claude-worker.js";
import { runPreflightOrAbort } from "./preflight.js";
import type {
  ClickUpTask,
  ClaudeResult,
  TaskOutcome,
  StackContext,
  StackInfo,
  StackRunSummary,
} from "./types.js";

let isShuttingDown = false;
// True while pollForTasks is mid-cycle. Guards against re-entrant polling,
// NOT against concurrent task processing — tasks themselves run in parallel
// slots (see slotPool below) and `pollForTasks` returns as soon as it has
// dispatched the new batch.
let isPolling = false;
let signalHandlersRegistered = false;
let interactiveMode = false;
let shouldRelaunchAfterMerge = false;

const TODO_FILE_PATH = resolve(PROJECT_ROOT, ".clawdup.todo.json");
const LOCK_FILE_PATH = resolve(PROJECT_ROOT, ".clawdup.lock");

// Tracks task IDs that have been processed in this runner session.
// Prevents the same task from being picked up again if a status update
// fails and the task remains in TODO after processing.
const processedTaskIds = new Set<string>();

// Tasks currently being worked on by some slot. Added synchronously at pick
// time (before any await) so the same poll cycle can't double-pick a task.
const inFlightTaskIds = new Set<string>();
const inFlightPromises = new Map<string, Promise<void>>();

// --- Slot pool (parallel mode) ---

interface Slot {
  index: number;
  path: string;
  initialized: boolean;
}

const freeSlots: Slot[] = [];
let slotPoolInitialized = false;

/**
 * Set up the slot pool. In single-task mode (MAX_CONCURRENT_TASKS === 1) we
 * use the main GIT_ROOT checkout directly and skip all worktree machinery.
 */
function initSlotPool(): void {
  if (slotPoolInitialized) return;
  slotPoolInitialized = true;
  if (MAX_CONCURRENT_TASKS <= 1) return;
  for (let i = 0; i < MAX_CONCURRENT_TASKS; i++) {
    freeSlots.push({
      index: i,
      path: resolve(GIT_ROOT, ".clawdup-worktrees", `slot-${i}`),
      initialized: false,
    });
  }
}

/**
 * Take a free slot from the pool, lazily creating its worktree on first use.
 * Returns null if no slot is currently free.
 */
async function acquireSlot(): Promise<Slot | null> {
  if (MAX_CONCURRENT_TASKS <= 1) return null;
  const slot = freeSlots.shift();
  if (!slot) return null;
  if (!slot.initialized) {
    try {
      await createWorktree(slot.path, `origin/${BASE_BRANCH}`);
      slot.initialized = true;
    } catch (err) {
      log("error", `Failed to create worktree for slot ${slot.index}: ${(err as Error).message}`);
      freeSlots.push(slot);
      return null;
    }
  } else {
    try {
      await resetSlotToBase(slot.path);
    } catch (err) {
      log("warn", `Failed to reset slot ${slot.index} to base; recreating. ${(err as Error).message}`);
      try { await removeWorktree(slot.path); } catch { /* ignore */ }
      try {
        await createWorktree(slot.path, `origin/${BASE_BRANCH}`);
      } catch (err2) {
        log("error", `Failed to recreate worktree for slot ${slot.index}: ${(err2 as Error).message}`);
        freeSlots.push(slot);
        return null;
      }
    }
  }
  return slot;
}

/**
 * Return a slot to the pool. The worktree is left on disk for reuse —
 * the next acquireSlot will reset it to base.
 */
function releaseSlot(slot: Slot): void {
  freeSlots.push(slot);
}

/**
 * Build the 3-tiered project context for Claude.
 * Tier 1: compact overview of all tasks grouped by status.
 * Tier 2: related tasks (dependencies, in-progress, recently completed).
 * Tier 3 is the current task itself, handled separately.
 */
async function buildProjectContext(task: ClickUpTask): Promise<string> {
  const parts: string[] = [];

  try {
    const overview = await getAllTasksSummary();
    parts.push(`## Project Overview (all tasks in the backlog)\n\n${overview}`);
  } catch (err) {
    log("warn", `Could not fetch project overview for context: ${(err as Error).message}`);
  }

  try {
    const related = await getRelatedTasksContext(task);
    parts.push(`## Related Tasks (dependencies, in-progress, recently completed)\n\n${related}`);
  } catch (err) {
    log("warn", `Could not fetch related tasks context: ${(err as Error).message}`);
  }

  return parts.join("\n\n");
}

interface LockFileData {
  pid: number;
  startedAt: string;
}

/**
 * Check if a process with the given PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // signal 0 doesn't kill, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive lock to prevent concurrent Clawdup instances.
 * Throws if another instance is already running.
 */
function acquireLock(): void {
  if (existsSync(LOCK_FILE_PATH)) {
    try {
      const raw = readFileSync(LOCK_FILE_PATH, "utf-8");
      const data = JSON.parse(raw) as LockFileData;

      if (data.pid && isProcessRunning(data.pid)) {
        log(
          "error",
          `Another Clawdup instance is already running (PID ${data.pid}, started ${data.startedAt}).`,
        );
        log(
          "error",
          `If this is a stale lock, delete ${LOCK_FILE_PATH} and try again.`,
        );
        process.exit(1);
      }

      // Stale lock — previous process is no longer running
      log("warn", `Removing stale lock file (PID ${data.pid} is no longer running).`);
    } catch {
      // Corrupted lock file — remove it
      log("warn", "Removing corrupted lock file.");
    }

    try {
      unlinkSync(LOCK_FILE_PATH);
    } catch {
      // ignore
    }
  }

  const lockData: LockFileData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  writeFileSync(LOCK_FILE_PATH, JSON.stringify(lockData, null, 2));
  log("debug", `Lock acquired (PID ${process.pid}).`);
}

/**
 * Release the lock file if it belongs to this process.
 */
function releaseLock(): void {
  try {
    if (!existsSync(LOCK_FILE_PATH)) return;

    const raw = readFileSync(LOCK_FILE_PATH, "utf-8");
    const data = JSON.parse(raw) as LockFileData;

    // Only remove if we own it
    if (data.pid === process.pid) {
      unlinkSync(LOCK_FILE_PATH);
      log("debug", "Lock released.");
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Process the .clawdup.todo.json file if it exists.
 * Creates new ClickUp tasks for each entry, skipping duplicates.
 * The file is deleted immediately after reading to prevent double-processing
 * if this function is called multiple times (e.g. in both success and finally paths).
 */
async function processTodoFile(cwd?: string): Promise<void> {
  // Claude writes the todo file in its working directory. In parallel mode
  // that's the slot worktree, not PROJECT_ROOT — read from the same place.
  const todoPath = cwd ? resolve(cwd, ".clawdup.todo.json") : TODO_FILE_PATH;
  if (!existsSync(todoPath)) return;

  // Step 1: Read and delete the file atomically to prevent double-processing.
  // If the process crashes after deletion but before creating tasks,
  // the items are lost — but this is safer than creating duplicates.
  let items: Array<{ title?: string; description?: string }>;
  try {
    const raw = readFileSync(todoPath, "utf-8");
    items = JSON.parse(raw) as Array<{ title?: string; description?: string }>;
  } catch (err) {
    log("error", `Failed to read .clawdup.todo.json: ${(err as Error).message}`);
    return;
  } finally {
    try {
      unlinkSync(todoPath);
      log("debug", "Deleted .clawdup.todo.json");
    } catch {
      // ignore if already gone
    }
  }

  if (!Array.isArray(items)) {
    log("warn", ".clawdup.todo.json does not contain an array, skipping");
    return;
  }

  // Step 2: Fetch existing task names for deduplication.
  let existingNames: Set<string>;
  try {
    existingNames = await getExistingTaskNames();
    log("debug", `Found ${existingNames.size} existing task(s) for deduplication check`);
  } catch (err) {
    log("warn", `Failed to fetch existing tasks for deduplication: ${(err as Error).message}. Proceeding without dedup check.`);
    existingNames = new Set();
  }

  // Step 3: Create tasks, skipping duplicates.
  for (const item of items) {
    if (!item.title) {
      log("warn", "Skipping todo entry with no title");
      continue;
    }

    const normalizedName = item.title.toLowerCase().trim();
    if (existingNames.has(normalizedName)) {
      log("info", `Skipping duplicate follow-up task: "${item.title}"`);
      continue;
    }

    try {
      const created = await createTask(item.title, item.description);
      log("info", `Created follow-up task: "${item.title}" (${created.id})`);
      // Track the newly created task to prevent duplicates within the same batch
      existingNames.add(normalizedName);
    } catch (err) {
      log("error", `Failed to create follow-up task "${item.title}": ${(err as Error).message}`);
    }
  }
}

/**
 * Simulate processing a task in dry-run mode.
 * Logs all actions that would be taken without performing any mutations.
 */
async function dryRunProcessTask(task: ClickUpTask): Promise<void> {
  const taskId = task.id;
  const slug = slugify(task.name);
  const branchName = `${BRANCH_PREFIX}/CU-${taskId}-${slug}`;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `[DRY RUN] Processing task: ${task.name} (${taskId})`);
  log("info", `[DRY RUN] URL: ${task.url}`);
  log("info", `${"=".repeat(60)}\n`);

  if (!isValidTaskId(taskId)) {
    log("error", `[DRY RUN] Invalid task ID format: ${taskId}. Would skip.`);
    return;
  }

  const actions: string[] = [];

  actions.push(`ClickUp: Update task ${taskId} status → "${STATUS.IN_PROGRESS}"`);

  // Check for existing branch/PR (read-only operations)
  const existingBranch = await findBranchForTask(taskId);
  if (existingBranch) {
    actions.push(`Git: Checkout existing branch "${existingBranch}"`);
  } else {
    actions.push(`Git: Create branch "${branchName}" from "${BASE_BRANCH}"`);
  }

  const existingPrUrl = await findPRUrlInComments(taskId);
  if (existingPrUrl) {
    actions.push(`GitHub: Use existing PR: ${existingPrUrl}`);
  } else {
    actions.push(`Git: Create empty commit and push branch`);
    actions.push(`GitHub: Create draft PR "[CU-${taskId}] ${task.name}"`);
  }

  actions.push(`ClickUp: Add comment to task with PR link`);

  // Fetch comments to show prompt stats
  const comments = await getTaskComments(taskId);
  const taskPrompt = formatTaskForClaude(task, comments);
  actions.push(`Claude: Run Claude Code on task (prompt: ${taskPrompt.length} chars)`);

  actions.push(`Git: Commit changes and push to branch`);
  actions.push(`GitHub: Update PR body, mark as ready for review`);

  if (AUTO_APPROVE) {
    actions.push(`GitHub: Check CI/test status (block merge if failing)`);
    actions.push(`GitHub: Auto-merge PR (squash)`);
    actions.push(`ClickUp: Update task status → "${STATUS.COMPLETED}"`);
    actions.push(`ClickUp: Add comment confirming auto-merge`);
  } else {
    actions.push(`ClickUp: Update task status → "${STATUS.IN_REVIEW}"`);
    actions.push(`ClickUp: Add comment with work summary`);
  }

  log("info", `[DRY RUN] Planned actions:`);
  for (let i = 0; i < actions.length; i++) {
    log("info", `[DRY RUN]   ${i + 1}. ${actions[i]}`);
  }
  log("info", `\n[DRY RUN] Task simulation complete.\n`);
}

/**
 * Simulate processing an approved task in dry-run mode.
 */
async function dryRunProcessApprovedTask(task: ClickUpTask): Promise<void> {
  const taskId = task.id;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `[DRY RUN] Merging approved task: ${task.name} (${taskId})`);
  log("info", `${"=".repeat(60)}\n`);

  if (!isValidTaskId(taskId)) {
    log("error", `[DRY RUN] Invalid task ID format: ${taskId}. Would skip.`);
    return;
  }

  const actions: string[] = [];

  const prUrl = await findPRUrlInComments(taskId);
  if (!prUrl) {
    log("warn", `[DRY RUN] No PR URL found in comments for task ${taskId}. Would block task.`);
    return;
  }

  actions.push(`GitHub: Found PR from task comments: ${prUrl}`);
  actions.push(`GitHub: Check PR state and mergeability`);
  actions.push(`GitHub: Check CI/test status (block merge if failing)`);
  actions.push(`GitHub: Merge PR (squash)`);
  actions.push(`ClickUp: Update task status → "${STATUS.COMPLETED}"`);
  actions.push(`ClickUp: Add comment confirming merge`);

  log("info", `[DRY RUN] Planned actions:`);
  for (let i = 0; i < actions.length; i++) {
    log("info", `[DRY RUN]   ${i + 1}. ${actions[i]}`);
  }
  log("info", `\n[DRY RUN] Approved task simulation complete.\n`);
}

/**
 * Simulate processing a returning task in dry-run mode.
 */
async function dryRunProcessReturningTask(task: ClickUpTask, prUrl: string): Promise<void> {
  const taskId = task.id;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `[DRY RUN] Processing returning task: ${task.name} (${taskId})`);
  log("info", `[DRY RUN] Existing PR: ${prUrl}`);
  log("info", `${"=".repeat(60)}\n`);

  if (!isValidTaskId(taskId)) {
    log("error", `[DRY RUN] Invalid task ID format: ${taskId}. Would skip.`);
    return;
  }

  const actions: string[] = [];

  actions.push(`ClickUp: Update task status → "${STATUS.IN_PROGRESS}"`);
  actions.push(`ClickUp: Add comment about continuing work`);

  const branchName = await findBranchForTask(taskId);
  if (branchName) {
    actions.push(`Git: Checkout existing branch "${branchName}"`);
    actions.push(`Git: Merge ${BASE_BRANCH} into branch`);
  } else {
    log("warn", `[DRY RUN] No branch found for returning task ${taskId}. Would block task.`);
    return;
  }

  const comments = await getTaskComments(taskId);
  const taskPrompt = formatTaskForClaude(task, comments);
  actions.push(`Claude: Run Claude Code with review context (prompt: ${taskPrompt.length} chars)`);

  actions.push(`Git: Commit changes and push to branch`);
  actions.push(`GitHub: Update PR body, mark as ready for review`);

  if (AUTO_APPROVE) {
    actions.push(`GitHub: Check CI/test status (block merge if failing)`);
    actions.push(`GitHub: Auto-merge PR (squash)`);
    actions.push(`ClickUp: Update task status → "${STATUS.COMPLETED}"`);
  } else {
    actions.push(`ClickUp: Update task status → "${STATUS.IN_REVIEW}"`);
    actions.push(`ClickUp: Add comment with work summary`);
  }

  log("info", `[DRY RUN] Planned actions:`);
  for (let i = 0; i < actions.length; i++) {
    log("info", `[DRY RUN]   ${i + 1}. ${actions[i]}`);
  }
  log("info", `\n[DRY RUN] Returning task simulation complete.\n`);
}

interface ProcessTaskOptions {
  /** Working directory (worktree slot); defaults to the main checkout. */
  cwd?: string;
  /** Branch to base the task branch and PR on; defaults to BASE_BRANCH. */
  baseBranch?: string;
  /** Stacked-PR context. Presence also suppresses AUTO_APPROVE. */
  stack?: StackContext;
}

/**
 * Process a single ClickUp task end-to-end.
 * Always starts from the latest base branch and creates a PR immediately
 * so that work is visible from the start.
 * Returns an outcome describing how processing ended; existing callers may
 * ignore it, stack mode uses it to decide whether to continue the series.
 */
async function processTask(
  task: ClickUpTask,
  options?: ProcessTaskOptions,
): Promise<TaskOutcome> {
  const cwd = options?.cwd;
  if (DRY_RUN) {
    await dryRunProcessTask(task);
    return { status: "dry_run" };
  }

  const taskId = task.id;
  const taskName = task.name;
  const slug = slugify(taskName);
  let branchName: string | null = null;
  let prUrl: string | null = null;
  const timer = startTimer();

  log("info", `\n${"=".repeat(60)}`);
  log("info", `Processing task: ${taskName} (${taskId})`, { taskId });
  log("info", `URL: ${task.url}`);
  log("info", `${"=".repeat(60)}\n`);

  // Validate task ID format before using it in branch names and commands
  if (!isValidTaskId(taskId)) {
    log("error", `Invalid task ID format: ${taskId}. Skipping.`);
    return { status: "error" };
  }

  try {
    // Step 1: Move task to "In Progress"
    await updateTaskStatus(taskId, STATUS.IN_PROGRESS);

    // Step 2: Create a feature branch from the latest base branch
    // (or from the previous branch in the stack, in stacked mode)
    branchName = await createTaskBranch(taskId, slug, cwd, options?.baseBranch);
    log("info", `Working on branch: ${branchName}`);

    // Step 3: Check if a PR already exists for this branch (e.g. from a previous run).
    prUrl = await findExistingPR(branchName);

    if (prUrl) {
      log("info", `Existing PR found: ${prUrl}`);

      // Check if the existing PR is already merged
      const prState = await getPRState(prUrl);
      if (prState === "merged") {
        log("info", `PR already merged for task ${taskId}. Marking complete.`);
        await addTaskComment(
          taskId,
          `✅ The associated PR was already merged: ${prUrl}\n\nMoving task to complete.`,
        );
        await updateTaskStatus(taskId, STATUS.COMPLETED);
        return { status: "merged", branchName, prUrl };
      }
    }

    await addTaskComment(
      taskId,
      `🤖 Automation picked up this task and is now working on it.`,
    );

    // Step 4: Build 3-tiered context, format the task for Claude, and run it
    // Save HEAD hash before Claude runs so we can detect if Claude commits via Bash
    const headBefore = await getHeadHash(cwd);
    const [comments, baseProjectContext] = await Promise.all([
      getTaskComments(taskId),
      buildProjectContext(task),
    ]);
    const projectContext = options?.stack
      ? `${baseProjectContext}\n\n${options.stack.promptContext}`
      : baseProjectContext;
    const taskPrompt = formatTaskForClaude(task, comments);
    const result = await runClaudeOnTask(taskPrompt, taskId, { interactive: interactiveMode, projectContext, cwd });
    const headAfter = await getHeadHash(cwd);
    const claudeCommitted = headBefore !== headAfter;

    // Step 4b: Process any follow-up tasks Claude created BEFORE committing.
    // This must happen before commitChanges() because git add -A would
    // include the file, and switching branches later would remove it.
    await processTodoFile(cwd);

    // Step 5: Handle the result
    if (result.needsInput) {
      // Claude needs more information
      await handleNeedsInput(task, result, branchName, prUrl, cwd);
      return { status: "needs_input", branchName };
    }

    if (!result.success) {
      // Claude encountered an error
      await handleError(task, result, branchName, prUrl, claudeCommitted, cwd);
      return { status: "error", branchName };
    }

    // Step 6: Check if Claude actually made changes
    const uncommittedChanges = await hasChanges(cwd);
    if (!uncommittedChanges && !claudeCommitted) {
      log(
        "warn",
        `Claude completed but made no file changes for task ${taskId}`,
      );
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⚠️ Automation completed but no code changes were produced. This may mean:\n` +
          `- The task was already done\n` +
          `- The task description wasn't actionable\n` +
          `- Claude couldn't determine what changes to make\n\n` +
          `Please review and provide more specific instructions if needed.`,
      );
      await updateTaskStatus(taskId, STATUS.REQUIRE_INPUT);
      if (prUrl) {
        await closePRAndCleanup(prUrl, branchName, cwd);
      }
      return { status: "no_changes", branchName };
    }

    // Step 7: Commit (fallback if Claude didn't), push, and create/update the PR
    if (uncommittedChanges) {
      log("warn", "Claude left uncommitted changes — committing as fallback");
      const commitMsg = generateCommitMessage(task, result.output);
      await commitChanges(commitMsg, cwd);
    }
    await pushBranch(branchName, cwd);

    // Build PR body with full details
    const { stat, files } = await getChangesSummary(cwd, options?.baseBranch);
    let prBody = generatePRBody(task, result.output, files);
    if (options?.stack) {
      prBody += `\n\n${options.stack.prNote}`;
    }

    if (!prUrl) {
      // Create the PR now that we have actual changes pushed
      prUrl = await createPullRequest({
        title: `[CU-${taskId}] ${taskName}`,
        body: prBody,
        branchName,
        baseBranch: options?.baseBranch ?? BASE_BRANCH,
      });
      log("info", `PR created: ${prUrl}`);
    } else {
      // Update existing PR with full details and mark it as ready for review
      await updatePullRequest(prUrl, { body: prBody });
      await markPRReady(prUrl);
    }

    // Step 8: Update ClickUp task with a summary of the work done
    const workSummary = generateWorkSummary(result.output, stat, files);

    // Stacked PRs must be merged bottom-up in order, so auto-merge is
    // suppressed in stack mode (merging would also delete the branch the
    // next task in the stack builds on).
    if (AUTO_APPROVE && !options?.stack) {
      // Auto-approve mode: merge immediately without waiting for manual review
      await autoApproveAndMerge(task, prUrl, branchName, workSummary, cwd);
    } else {
      await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      await addTaskComment(
        taskId,
        `✅ Automation completed! The pull request is ready for review:\n\n` +
          `${prUrl}\n\n` +
          `Branch: \`${branchName}\`\n\n` +
          `${workSummary}\n\n` +
          `Please review the PR. When ready, move this task to "${STATUS.APPROVED}" and the automation will merge it.`,
      );
    }

    log("info", `Task ${taskId} completed successfully! PR: ${prUrl}`, { taskId, elapsed: timer() });
    return { status: "success", branchName, prUrl: prUrl ?? undefined };
  } catch (err) {
    log("error", `Error processing task ${taskId}: ${(err as Error).message}`, { taskId, elapsed: timer() });

    try {
      await notifyTaskCreator(
        taskId,
        task.creator,
        `❌ Automation encountered an error:\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
          `The task has been moved to "Blocked". Please investigate and retry.\n\n` +
          `See the [Troubleshooting Guide](https://github.com/gehadshaat/clawdup/blob/main/TROUBLESHOOTING.md#blocked-tasks-automation-error) for recovery steps.` +
          (prUrl ? `\n\nPR: ${prUrl}` : ""),
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
    } catch (commentErr) {
      log(
        "error",
        `Failed to update task status: ${(commentErr as Error).message}`,
      );
    }

    if (branchName) {
      // If there's a PR but no useful work, close it and cleanup
      if (prUrl) {
        try {
          await closePullRequest(prUrl);
        } catch {
          log("debug", "Could not close PR during error cleanup");
        }
      }
      await cleanupBranch(branchName, cwd);
    }
    return { status: "error", branchName: branchName ?? undefined };
  } finally {
    // Always return to base branch
    try {
      await returnToBaseBranch(cwd);
    } catch {
      log("warn", "Could not return to base branch");
    }
    // Pick up any follow-up tasks Claude created
    await processTodoFile(cwd);
  }
}

/**
 * Handle case where Claude needs more input.
 */
async function handleNeedsInput(
  task: ClickUpTask,
  result: ClaudeResult,
  branchName: string,
  prUrl: string | null,
  cwd?: string,
): Promise<void> {
  const reason = extractNeedsInputReason(result.output);

  log("info", `Task ${task.id} requires more input: ${reason}`);

  await notifyTaskCreator(
    task.id,
    task.creator,
    `🔍 Automation needs more information to complete this task:\n\n${reason}\n\n` +
      `Please add the requested details and move this task back to "${STATUS.TODO}" to retry.\n\n` +
      `See the [Troubleshooting Guide](https://github.com/gehadshaat/clawdup/blob/main/TROUBLESHOOTING.md#claude-needs-more-input) for tips on writing better task descriptions.`,
  );
  await updateTaskStatus(task.id, STATUS.REQUIRE_INPUT);

  // Close the draft PR and clean up the branch since no work was done
  await closePRAndCleanup(prUrl, branchName, cwd);
}

/**
 * Handle case where Claude encountered an error.
 */
async function handleError(
  task: ClickUpTask,
  result: ClaudeResult,
  branchName: string,
  prUrl: string | null,
  claudeCommitted: boolean = false,
  cwd?: string,
): Promise<void> {
  const errorMsg = result.error || "Unknown error";

  log("error", `Task ${task.id} failed: ${errorMsg}`);

  // Check if there were partial changes
  const uncommittedChanges = await hasChanges(cwd);

  if (uncommittedChanges) {
    // There are uncommitted partial changes - commit them and push
    try {
      await commitChanges(
        `[CU-${task.id}] WIP: ${task.name} (partial - automation error)`,
        cwd,
      );
      await pushBranch(branchName, cwd);
      await notifyTaskCreator(
        task.id,
        task.creator,
        `⚠️ Automation encountered an error but made partial changes.\n\n` +
          `Error: \`${errorMsg}\`\n\n` +
          `Partial changes have been pushed to the PR for manual review.\n` +
          (prUrl ? `PR: ${prUrl}\n` : `Branch: \`${branchName}\`\n`) +
          `Please complete the work manually or provide more details and retry.`,
      );
    } catch (pushErr) {
      log(
        "error",
        `Failed to push partial changes: ${(pushErr as Error).message}`,
      );
      await closePRAndCleanup(prUrl, branchName, cwd);
    }
  } else if (claudeCommitted) {
    // Claude committed before erroring — push what's there
    try {
      await pushBranch(branchName, cwd);
      await notifyTaskCreator(
        task.id,
        task.creator,
        `⚠️ Automation encountered an error but Claude made partial commits.\n\n` +
          `Error: \`${errorMsg}\`\n\n` +
          `Partial commits have been pushed to the PR for manual review.\n` +
          (prUrl ? `PR: ${prUrl}\n` : `Branch: \`${branchName}\`\n`) +
          `Please complete the work manually or provide more details and retry.`,
      );
    } catch (pushErr) {
      log(
        "error",
        `Failed to push partial commits: ${(pushErr as Error).message}`,
      );
      await closePRAndCleanup(prUrl, branchName, cwd);
    }
  } else {
    // No partial changes - close the draft PR and clean up
    await closePRAndCleanup(prUrl, branchName, cwd);
  }

  await updateTaskStatus(task.id, STATUS.BLOCKED);
}

/**
 * Clean up a branch that won't be used.
 */
async function cleanupBranch(branchName: string, cwd?: string): Promise<void> {
  try {
    await returnToBaseBranch(cwd);
    // The local branch ref is shared across all worktrees — deleting it
    // from any cwd removes it for everyone. Skip when in a worktree slot
    // since the branch may still be needed by a parallel re-run.
    if (!cwd || cwd === GIT_ROOT) {
      await deleteLocalBranch(branchName);
    }
  } catch {
    log("debug", `Cleanup of branch ${branchName} failed (non-critical)`);
  }
}

/**
 * Close a PR and clean up the associated branch.
 */
async function closePRAndCleanup(
  prUrl: string | null,
  branchName: string,
  cwd?: string,
): Promise<void> {
  if (prUrl) {
    try {
      await closePullRequest(prUrl);
    } catch {
      log("debug", "Could not close PR during cleanup (non-critical)");
    }
  }
  await cleanupBranch(branchName, cwd);
}

/**
 * Resolve merge conflicts by merging the base branch into the feature branch
 * and using Claude to fix any conflicted files.
 *
 * Returns true if conflicts were resolved, false if resolution failed.
 */
async function resolveConflictsWithMerge(
  task: ClickUpTask,
  prUrl: string,
  cwd?: string,
): Promise<boolean> {
  const taskId = task.id;
  const branchName = await findBranchForTask(taskId);
  const isWorktree = cwd !== undefined && cwd !== GIT_ROOT;

  if (!branchName) {
    log("error", `No branch found for task ${taskId} — cannot resolve conflicts`);
    await notifyTaskCreator(
      taskId,
      task.creator,
      `⚠️ PR has merge conflicts but no branch was found to resolve them.\n\nPR: ${prUrl}\n\nPlease resolve the conflicts manually.`,
    );
    await updateTaskStatus(taskId, STATUS.BLOCKED);
    return false;
  }

  try {
    // Checkout the feature branch. In worktree mode the slot has already been
    // reset to base by the dispatcher, so the syncBaseBranch step is skipped.
    if (!isWorktree) {
      await syncBaseBranch(cwd);
    }
    await checkoutExistingBranch(branchName, cwd);

    // Try merging the base branch into the feature branch
    const mergedCleanly = await mergeBaseBranch(cwd);

    if (mergedCleanly) {
      // No conflicts after all — just push the updated branch
      log("info", `Base branch merged cleanly into ${branchName}`);
      await pushBranch(branchName, cwd);
      return true;
    }

    // There are conflicts — get the list of conflicted files
    const conflictedFiles = await getConflictedFiles(cwd);
    log("info", `Conflicted files: ${conflictedFiles.join(", ")}`);

    await addTaskComment(
      taskId,
      `🔀 PR has merge conflicts with \`${BASE_BRANCH}\`. Attempting automatic resolution using Claude.\n\n` +
        `Conflicted files:\n${conflictedFiles.map((f) => `- \`${f}\``).join("\n")}`,
    );

    // Use Claude to resolve the conflicts
    const headBeforeMerge = await getHeadHash(cwd);
    const result = await runClaudeOnConflictResolution(conflictedFiles, branchName, cwd);
    const headAfterMerge = await getHeadHash(cwd);
    const claudeCommittedMerge = headBeforeMerge !== headAfterMerge;

    if (!result.success) {
      log("error", `Claude failed to resolve conflicts for task ${taskId}`);
      if (!claudeCommittedMerge) {
        await abortMerge(cwd);
      }
      await notifyTaskCreator(
        taskId,
        task.creator,
        `❌ Automation could not resolve merge conflicts automatically.\n\n` +
          `Conflicted files:\n${conflictedFiles.map((f) => `- \`${f}\``).join("\n")}\n\n` +
          `Error: ${result.error || "Claude could not resolve the conflicts"}\n\n` +
          `Please resolve the conflicts manually.\nPR: ${prUrl}\n\n` +
          `See the [Troubleshooting Guide](https://github.com/gehadshaat/clawdup/blob/main/TROUBLESHOOTING.md#merge-conflicts) for recovery steps.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      await returnToBaseBranch(cwd);
      return false;
    }

    // Check if there are still conflict markers in the files
    const remainingConflicts = await getConflictedFiles(cwd);
    if (remainingConflicts.length > 0) {
      log("warn", `Still ${remainingConflicts.length} conflicted file(s) after Claude resolution`);
      if (!claudeCommittedMerge) {
        await abortMerge(cwd);
      }
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⚠️ Claude attempted to resolve merge conflicts but some files still have conflicts:\n\n` +
          `${remainingConflicts.map((f) => `- \`${f}\``).join("\n")}\n\n` +
          `Please resolve the remaining conflicts manually.\nPR: ${prUrl}`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      await returnToBaseBranch(cwd);
      return false;
    }

    // Commit the merge resolution (fallback if Claude didn't) and push
    if (claudeCommittedMerge) {
      log("info", "Claude already committed the merge resolution");
    } else {
      log("warn", "Claude did not commit the merge resolution — committing as fallback");
      await commitMergeResolution(cwd);
    }
    await pushBranch(branchName, cwd);

    log("info", `Conflicts resolved and pushed for task ${taskId}`);
    await addTaskComment(
      taskId,
      `✅ Merge conflicts resolved automatically. The PR is now ready to merge.`,
    );

    await returnToBaseBranch(cwd);
    return true;
  } catch (err) {
    log("error", `Error resolving conflicts for task ${taskId}: ${(err as Error).message}`);

    // Best-effort abort merge and return to base
    try {
      await abortMerge(cwd);
    } catch {
      log("debug", "Could not abort merge (may not be in merge state)");
    }
    try {
      await returnToBaseBranch(cwd);
    } catch {
      log("debug", "Could not return to base branch after conflict resolution failure");
    }

    await notifyTaskCreator(
      taskId,
      task.creator,
      `❌ Automation encountered an error while trying to resolve merge conflicts:\n\n` +
        `\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
        `Please resolve the conflicts manually.\nPR: ${prUrl}`,
    );
    await updateTaskStatus(taskId, STATUS.BLOCKED);
    return false;
  }
}

/**
 * Auto-approve and merge a PR immediately after Claude completes work.
 * Used when AUTO_APPROVE is enabled to skip the manual review step.
 * Returns true if merge succeeded, false otherwise.
 */
async function autoApproveAndMerge(
  task: ClickUpTask,
  prUrl: string,
  branchName: string,
  workSummary: string,
  cwd?: string,
): Promise<boolean> {
  const taskId = task.id;

  try {
    log("info", `Auto-approve enabled — merging PR immediately: ${prUrl}`, { taskId });

    // Check mergeability (conflicts could exist if base changed during Claude's work)
    const mergeability = await getPRMergeability(prUrl);
    log("info", `PR mergeability: ${mergeability}`, { taskId });

    if (mergeability === "CONFLICTING") {
      log("info", `PR has conflicts. Attempting to resolve before auto-merge.`, { taskId });
      const resolved = await resolveConflictsWithMerge(task, prUrl, cwd);
      if (!resolved) {
        return false; // resolveConflictsWithMerge handles status updates
      }
    }

    // Check CI/check status before merging
    const checkStatus = await getPRCheckStatus(prUrl);
    log("info", `PR check status — passing: ${checkStatus.passing}, pending: ${checkStatus.pending}, failing: [${checkStatus.failing.join(", ")}]`, { taskId });

    if (checkStatus.failing.length > 0) {
      log("warn", `PR checks failed for task ${taskId}. Skipping auto-merge.`, { taskId });
      await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      await addTaskComment(
        taskId,
        `⚠️ Auto-merge skipped — CI checks failed:\n\n` +
          checkStatus.failing.map((name) => `- \`${name}\``).join("\n") +
          `\n\nPR: ${prUrl}\n\n` +
          `Please investigate the failing checks. Move this task to "${STATUS.APPROVED}" to retry merge after fixes.`,
      );
      return false;
    }

    if (checkStatus.pending) {
      log("warn", `PR checks still pending for task ${taskId}. Skipping auto-merge.`, { taskId });
      await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      await addTaskComment(
        taskId,
        `⏳ Auto-merge deferred — CI checks are still running.\n\n` +
          `PR: ${prUrl}\n\n` +
          `Move this task to "${STATUS.APPROVED}" to retry merge once checks complete.`,
      );
      return false;
    }

    await mergePullRequest(prUrl);
    await updateTaskStatus(taskId, STATUS.COMPLETED);
    await addTaskComment(
      taskId,
      `🤖 Auto-approved and merged!\n\n` +
        `${prUrl}\n\n` +
        `Branch: \`${branchName}\`\n\n` +
        `${workSummary}\n\n` +
        `Task is now complete.`,
    );

    log("info", `Task ${taskId} auto-approved and merged: ${prUrl}`, { taskId });

    shouldRelaunchAfterMerge = true;
    log("info", "Merge detected — will rebuild and relaunch after this polling cycle.");
    return true;
  } catch (err) {
    log("error", `Auto-merge failed for task ${taskId}: ${(err as Error).message}`, { taskId });

    // Fall back to normal review flow
    try {
      await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      await addTaskComment(
        taskId,
        `⚠️ Auto-merge failed:\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
          `PR: ${prUrl}\n\n` +
          `Falling back to manual review. Move this task to "${STATUS.APPROVED}" to retry merge.`,
      );
    } catch (commentErr) {
      log("error", `Failed to update task after auto-merge failure: ${(commentErr as Error).message}`);
    }
    return false;
  }
}

/**
 * Process an approved task: find its PR and merge it.
 */
async function processApprovedTask(task: ClickUpTask): Promise<void> {
  if (DRY_RUN) {
    await dryRunProcessApprovedTask(task);
    return;
  }

  const taskId = task.id;
  const taskName = task.name;
  const timer = startTimer();

  log("info", `\n${"=".repeat(60)}`);
  log("info", `Merging approved task: ${taskName} (${taskId})`, { taskId });
  log("info", `${"=".repeat(60)}\n`);

  if (!isValidTaskId(taskId)) {
    log("error", `Invalid task ID format: ${taskId}. Skipping.`);
    return;
  }

  try {
    // Find the PR URL from the task's comments
    const prUrl = await findPRUrlInComments(taskId);

    if (!prUrl) {
      log("warn", `No PR URL found in comments for task ${taskId}`);
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⚠️ Could not find a pull request URL in this task's comments.\n\n` +
          `This task was moved to "${STATUS.APPROVED}" but no associated PR was found. ` +
          `Please add the PR URL in a comment and move back to "${STATUS.APPROVED}", ` +
          `or merge the PR manually.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      return;
    }

    // Check if the PR is still open
    const prState = await getPRState(prUrl);
    if (prState === "merged") {
      log("info", `PR already merged for task ${taskId}: ${prUrl}`);
      await addTaskComment(
        taskId,
        `✅ PR was already merged: ${prUrl}\n\nMoving task to complete.`,
      );
      await updateTaskStatus(taskId, STATUS.COMPLETED);
      return;
    }

    if (prState !== "open") {
      log("warn", `PR is ${prState} for task ${taskId}: ${prUrl}`);
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⚠️ The associated PR is "${prState}" (expected "open"):\n${prUrl}\n\n` +
          `Cannot merge a ${prState} PR. Please investigate.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      return;
    }

    // Check if the PR has merge conflicts and resolve them if needed
    const mergeability = await getPRMergeability(prUrl);
    log("info", `PR mergeability for task ${taskId}: ${mergeability}`);

    if (mergeability === "CONFLICTING") {
      log("info", `PR has conflicts. Attempting to resolve for task ${taskId}`);
      const resolved = await resolveConflictsWithMerge(task, prUrl);
      if (!resolved) {
        return; // resolveConflictsWithMerge handles status updates
      }
    }

    // Check CI/check status before merging
    const checkStatus = await getPRCheckStatus(prUrl);
    log("info", `PR check status for task ${taskId} — passing: ${checkStatus.passing}, pending: ${checkStatus.pending}, failing: [${checkStatus.failing.join(", ")}]`);

    if (checkStatus.failing.length > 0) {
      log("warn", `PR checks failed for task ${taskId}. Cannot merge.`);
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⚠️ Cannot merge — CI checks failed:\n\n` +
          checkStatus.failing.map((name) => `- \`${name}\``).join("\n") +
          `\n\nPR: ${prUrl}\n\n` +
          `Please investigate the failing checks. Move this task back to "${STATUS.APPROVED}" to retry merge after fixes.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      return;
    }

    if (checkStatus.pending) {
      log("warn", `PR checks still pending for task ${taskId}. Deferring merge.`);
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⏳ Merge deferred — CI checks are still running.\n\n` +
          `PR: ${prUrl}\n\n` +
          `Move this task back to "${STATUS.APPROVED}" to retry merge once checks complete.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      return;
    }

    // Merge the PR
    await mergePullRequest(prUrl);

    // Move task to complete
    await updateTaskStatus(taskId, STATUS.COMPLETED);
    await addTaskComment(
      taskId,
      `🎉 PR merged successfully!\n\n${prUrl}\n\nTask is now complete.`,
    );

    log("info", `Task ${taskId} approved and merged: ${prUrl}`, { taskId, elapsed: timer() });

    // Signal that we should rebuild and relaunch to pick up the merged code
    shouldRelaunchAfterMerge = true;
    log("info", "Merge detected — will rebuild and relaunch after this polling cycle.");
  } catch (err) {
    log(
      "error",
      `Error merging approved task ${taskId}: ${(err as Error).message}`,
    );

    try {
      await notifyTaskCreator(
        taskId,
        task.creator,
        `❌ Automation failed to merge the PR:\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
          `Please merge manually or investigate the error.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
    } catch (commentErr) {
      log(
        "error",
        `Failed to comment on task: ${(commentErr as Error).message}`,
      );
    }
  }
}

/**
 * Collect all review feedback for a task from both GitHub PR and ClickUp comments.
 * Returns a formatted string of all feedback, or null if there's nothing actionable.
 */
async function collectReviewFeedback(
  task: ClickUpTask,
  prUrl: string,
): Promise<string | null> {
  const feedbackParts: string[] = [];

  // Check GitHub PR review decision
  const reviewDecision = await getPRReviewDecision(prUrl);
  const changesRequested = reviewDecision === "CHANGES_REQUESTED";

  // Get GitHub PR review comments (top-level review bodies)
  const prReviewComments = await getPRReviewComments(prUrl);
  if (prReviewComments.length > 0) {
    feedbackParts.push("### GitHub PR Reviews");
    for (const comment of prReviewComments) {
      const date = comment.createdAt
        ? new Date(comment.createdAt).toISOString().split("T")[0]
        : "";
      feedbackParts.push(`**${comment.author}** (${date}):\n${comment.body}\n`);
    }
  }

  // Get GitHub inline (code-level) review comments
  const inlineComments = await getPRInlineComments(prUrl);
  if (inlineComments.length > 0) {
    feedbackParts.push("### GitHub Inline Code Comments");
    for (const comment of inlineComments) {
      const location = comment.line ? `${comment.path}:${comment.line}` : comment.path;
      feedbackParts.push(`**${comment.author}** on \`${location}\`:\n${comment.body}\n`);
    }
  }

  // Get new ClickUp comments (posted after automation's last comment)
  const clickupFeedback = await getNewReviewFeedback(task.id);
  if (clickupFeedback.length > 0) {
    feedbackParts.push("### ClickUp Review Comments");
    for (const comment of clickupFeedback) {
      const text = getCommentText(comment);
      const user = comment.user?.username || "Unknown";
      const date = comment.date
        ? new Date(parseInt(comment.date)).toISOString().split("T")[0]
        : "";
      feedbackParts.push(`**${user}** (${date}):\n${text}\n`);
    }
  }

  // Determine if there's actionable feedback
  const hasGitHubFeedback = prReviewComments.length > 0 || inlineComments.length > 0;
  const hasClickUpFeedback = clickupFeedback.length > 0;

  if (!hasGitHubFeedback && !hasClickUpFeedback) {
    // No feedback from either source
    if (changesRequested) {
      // Changes requested but no comments — reviewer may have only used the status
      return "Changes were requested on the PR but no specific comments were provided. Please review the code and address any issues.";
    }
    return null;
  }

  return feedbackParts.join("\n\n");
}

/** What caused a task with an existing PR to be re-processed. */
type ReturningTaskTrigger = "todo" | "pr_feedback";

/**
 * Process a task that already has an existing PR and needs another round of
 * work — either because it was moved back to TO DO, or because new review
 * comments appeared on its PR (`trigger: "pr_feedback"`).
 * Instead of starting from scratch, checks out the existing branch,
 * gathers new comments for context, and runs Claude to continue/fix the work.
 */
async function processReturningTask(
  task: ClickUpTask,
  prUrl: string,
  cwd?: string,
  trigger: ReturningTaskTrigger = "todo",
): Promise<void> {
  if (DRY_RUN) {
    await dryRunProcessReturningTask(task, prUrl);
    return;
  }

  const taskId = task.id;
  const taskName = task.name;
  const timer = startTimer();
  const isWorktree = cwd !== undefined && cwd !== GIT_ROOT;

  log("info", `\n${"=".repeat(60)}`);
  log(
    "info",
    `Processing returning task (${trigger === "pr_feedback" ? "new PR review comments" : "moved back to TODO"}): ${taskName} (${taskId})`,
    { taskId },
  );
  log("info", `Existing PR: ${prUrl}`);
  log("info", `${"=".repeat(60)}\n`);

  if (!isValidTaskId(taskId)) {
    log("error", `Invalid task ID format: ${taskId}. Skipping.`);
    return;
  }

  // Check the state of the existing PR
  const prState = await getPRState(prUrl);

  if (prState === "merged") {
    log("info", `PR already merged for returning task ${taskId}. Marking complete.`);
    await addTaskComment(
      taskId,
      `✅ The associated PR was already merged: ${prUrl}\n\nMoving task to complete.`,
    );
    await updateTaskStatus(taskId, STATUS.COMPLETED);
    return;
  }

  if (prState === "closed") {
    // PR was closed without merging — treat as a fresh task
    log("info", `PR was closed for task ${taskId}. Processing as new task.`);
    await processTask(task, { cwd });
    return;
  }

  // PR is open — find the existing branch and continue work
  const branchName = await findBranchForTask(taskId);
  if (!branchName) {
    log("error", `No branch found for returning task ${taskId} despite open PR ${prUrl}`);
    await notifyTaskCreator(
      taskId,
      task.creator,
      `⚠️ This task was moved back to TODO and has an open PR, but no local branch was found.\n\n` +
        `PR: ${prUrl}\n\n` +
        `Please investigate or close the PR and retry.`,
    );
    await updateTaskStatus(taskId, STATUS.BLOCKED);
    return;
  }

  try {
    // Move task to "In Progress"
    await updateTaskStatus(taskId, STATUS.IN_PROGRESS);

    // NOTE: this comment starts with an automation marker, which advances the
    // PR-feedback boundary — so the comments that triggered this round won't
    // trigger another one (see dispatchTasksWithNewPRFeedback).
    await addTaskComment(
      taskId,
      trigger === "pr_feedback"
        ? `🤖 Automation noticed new review comments on the PR and is addressing them.\n\nPR: ${prUrl}`
        : `🤖 Automation detected this task was moved back to TODO with an existing PR. Continuing work on it.\n\nPR: ${prUrl}`,
    );

    // Checkout the existing branch. In worktree mode the slot has already been
    // reset to base by the dispatcher, so we skip syncBaseBranch here.
    if (!isWorktree) {
      await syncBaseBranch(cwd);
    }
    await checkoutExistingBranch(branchName, cwd);

    // Merge base branch to get latest changes
    const mergedCleanly = await mergeBaseBranch(cwd);
    if (!mergedCleanly) {
      const conflictedFiles = await getConflictedFiles(cwd);
      log("info", `Branch has conflicts with base: ${conflictedFiles.join(", ")}`);

      const conflictResult = await runClaudeOnConflictResolution(conflictedFiles, branchName, cwd);
      if (!conflictResult.success) {
        await abortMerge(cwd);
        await notifyTaskCreator(
          taskId,
          task.creator,
          `⚠️ This task was moved back to TODO but the branch has merge conflicts that could not be resolved automatically.\n\n` +
            `Conflicted files:\n${conflictedFiles.map((f) => `- \`${f}\``).join("\n")}\n\n` +
            `Please resolve conflicts manually.\nPR: ${prUrl}`,
        );
        await updateTaskStatus(taskId, STATUS.BLOCKED);
        await returnToBaseBranch(cwd);
        return;
      }

      const remaining = await getConflictedFiles(cwd);
      if (remaining.length > 0) {
        await abortMerge(cwd);
        await notifyTaskCreator(
          taskId,
          task.creator,
          `⚠️ Some merge conflicts remain after automatic resolution:\n${remaining.map((f) => `- \`${f}\``).join("\n")}\n\nPlease resolve manually.\nPR: ${prUrl}`,
        );
        await updateTaskStatus(taskId, STATUS.BLOCKED);
        await returnToBaseBranch(cwd);
        return;
      }

      if (await hasChanges(cwd)) {
        await commitMergeResolution(cwd);
      }
    }

    // Gather new comments as context for why the task was moved back
    const feedback = await collectReviewFeedback(task, prUrl);
    const headBefore = await getHeadHash(cwd);
    const [comments, projectContext] = await Promise.all([
      getTaskComments(taskId),
      buildProjectContext(task),
    ]);
    const taskPrompt = formatTaskForClaude(task, comments);

    let result: ClaudeResult;
    if (feedback) {
      // There's review feedback — use review feedback mode
      log("info", `Found feedback for returning task ${taskId}. Running Claude with review context.`);
      result = await runClaudeOnReviewFeedback(
        taskPrompt,
        taskId,
        feedback,
        { interactive: interactiveMode, projectContext, cwd },
      );
    } else {
      // No specific feedback — re-run Claude on the task with existing code context
      log("info", `No specific feedback found for returning task ${taskId}. Re-running Claude on the task.`);
      result = await runClaudeOnTask(taskPrompt, taskId, { interactive: interactiveMode, projectContext, cwd });
    }

    const headAfter = await getHeadHash(cwd);
    const claudeCommitted = headBefore !== headAfter;

    // Process any follow-up tasks
    await processTodoFile(cwd);

    // Handle needs-input case
    if (result.needsInput) {
      const reason = extractNeedsInputReason(result.output);
      log("info", `Returning task ${taskId} requires more input: ${reason}`);
      await notifyTaskCreator(
        taskId,
        task.creator,
        `🔍 Automation needs more information to continue this task:\n\n${reason}\n\n` +
          `Please provide the requested details.\nPR: ${prUrl}`,
      );
      await updateTaskStatus(taskId, STATUS.REQUIRE_INPUT);
      await returnToBaseBranch(cwd);
      return;
    }

    if (!result.success) {
      log("error", `Returning task ${taskId} failed: ${result.error}`);
      const uncommittedChanges = await hasChanges(cwd);
      if (uncommittedChanges || claudeCommitted) {
        if (uncommittedChanges) {
          await commitChanges(`[CU-${taskId}] WIP: ${taskName} (partial - automation error)`, cwd);
        }
        await pushBranch(branchName, cwd);
        await notifyTaskCreator(
          taskId,
          task.creator,
          `⚠️ Automation encountered an error but made partial changes.\n\n` +
            `Error: \`${result.error}\`\n\n` +
            `Partial changes have been pushed to the PR.\nPR: ${prUrl}`,
        );
      } else {
        await notifyTaskCreator(
          taskId,
          task.creator,
          `❌ Automation failed to continue work on this task:\n\n\`${result.error}\`\n\n` +
            `Please investigate or provide more details.\nPR: ${prUrl}`,
        );
      }
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      await returnToBaseBranch(cwd);
      return;
    }

    // Check if Claude actually made changes
    const uncommittedChanges = await hasChanges(cwd);
    if (!uncommittedChanges && !claudeCommitted) {
      log("warn", `Claude completed but made no changes for returning task ${taskId}`);
      await notifyTaskCreator(
        taskId,
        task.creator,
        `⚠️ Automation processed this task but no new code changes were produced.\n\n` +
          `This may mean the existing work already addresses the requirements.\n\n` +
          `PR: ${prUrl}\n\nPlease review the PR.`,
      );
      await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      await returnToBaseBranch(cwd);
      return;
    }

    // Commit (fallback if Claude didn't), push, and update the PR
    if (uncommittedChanges) {
      log("warn", "Claude left uncommitted changes — committing as fallback");
      const commitMsg = generateCommitMessage(task, result.output);
      await commitChanges(commitMsg, cwd);
    }
    await pushBranch(branchName, cwd);

    // Update the PR body and mark it as ready for review
    const { stat, files } = await getChangesSummary(cwd);
    const prBody = generatePRBody(task, result.output, files);
    await updatePullRequest(prUrl, { body: prBody });
    await markPRReady(prUrl);

    // Update ClickUp task
    const workSummary = generateWorkSummary(result.output, stat, files);

    if (AUTO_APPROVE) {
      // Auto-approve mode: merge immediately without waiting for manual review
      await autoApproveAndMerge(task, prUrl, branchName, workSummary, cwd);
    } else {
      await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      await addTaskComment(
        taskId,
        `✅ Automation completed the updates! The pull request is ready for review:\n\n` +
          `${prUrl}\n\n` +
          `Branch: \`${branchName}\`\n\n` +
          `${workSummary}\n\n` +
          `Please review the PR. When ready, move this task to "${STATUS.APPROVED}" and the automation will merge it.`,
      );
    }

    log("info", `Returning task ${taskId} completed successfully! PR: ${prUrl}`, { taskId, elapsed: timer() });
  } catch (err) {
    log("error", `Error processing returning task ${taskId}: ${(err as Error).message}`);

    try {
      await notifyTaskCreator(
        taskId,
        task.creator,
        `❌ Automation encountered an error while continuing work on this task:\n\n` +
          `\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
          `The task has been moved to "Blocked". Please investigate.\nPR: ${prUrl}`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
    } catch (commentErr) {
      log("error", `Failed to update task status: ${(commentErr as Error).message}`);
    }
  } finally {
    try {
      await returnToBaseBranch(cwd);
    } catch {
      log("warn", "Could not return to base branch");
    }
    await processTodoFile(cwd);
  }
}

/**
 * Recover tasks that were left "in progress" from a previous crash.
 * For each orphaned task, checks for an existing branch and resumes
 * from the appropriate point in the pipeline.
 */
async function recoverOrphanedTasks(): Promise<void> {
  const recoveryTimer = startTimer();
  const inProgressTasks = await getTasksByStatus(STATUS.IN_PROGRESS);

  if (inProgressTasks.length === 0) {
    log("debug", "No orphaned in-progress tasks found.");
    return;
  }

  log(
    "info",
    `Found ${inProgressTasks.length} orphaned in-progress task(s). Recovering...`,
  );

  for (const task of inProgressTasks) {
    const taskId = task.id;
    const taskName = task.name;

    log("info", `Recovering task: ${taskName} (${taskId})`);

    try {
      const branchName = await findBranchForTask(taskId);

      if (!branchName) {
        // No branch exists — reset task so it gets picked up fresh
        log("info", `No branch found for task ${taskId}. Resetting to TODO.`);
        await updateTaskStatus(taskId, STATUS.TODO);
        await addTaskComment(
          taskId,
          `🔄 Automation restarted — no prior work found. Retrying task.`,
        );
        continue;
      }

      log("info", `Found existing branch for task ${taskId}: ${branchName}`);

      // Ensure base is up to date before checking out the task branch
      await syncBaseBranch();
      await checkoutExistingBranch(branchName);

      const hasCommits = await branchHasCommitsAheadOfBase();
      const wasPushed = await branchHasBeenPushed(branchName);

      if (hasCommits) {
        // Branch has work — finalize it (push + PR if needed)
        if (!wasPushed) {
          log("info", `Pushing unpushed branch ${branchName}`);
          await pushBranch(branchName);
        }

        // Check if a PR already exists
        const existingPrUrl = await findPRUrlInComments(taskId);

        if (existingPrUrl) {
          // Check if the PR is already merged
          const prState = await getPRState(existingPrUrl);
          if (prState === "merged") {
            log("info", `PR already merged for task ${taskId}: ${existingPrUrl}. Marking complete.`);
            await addTaskComment(
              taskId,
              `✅ The associated PR was already merged: ${existingPrUrl}\n\nMoving task to complete.`,
            );
            await updateTaskStatus(taskId, STATUS.COMPLETED);
            await returnToBaseBranch();
            continue;
          }
          log(
            "info",
            `PR already exists for task ${taskId}: ${existingPrUrl}. Moving to in review.`,
          );
        } else {
          // Create a PR
          const { files } = await getChangesSummary();
          const prUrl = await createPullRequest({
            title: `[CU-${taskId}] ${taskName}`,
            body:
              `Recovered from interrupted automation run.\n\n` +
              `Files changed: ${files.length}\n\n` +
              `Branch: \`${branchName}\``,
            branchName,
            baseBranch: BASE_BRANCH,
          });

          await addTaskComment(
            taskId,
            `🔄 Automation restarted and recovered prior work.\n\n` +
              `PR created: ${prUrl}\n` +
              `Branch: \`${branchName}\`\n\n` +
              `Please review the PR.`,
          );
          log("info", `Created recovery PR for task ${taskId}: ${prUrl}`);
        }

        await updateTaskStatus(taskId, STATUS.IN_REVIEW);
      } else {
        // Branch exists but has no commits — re-run Claude on it
        log(
          "info",
          `Branch ${branchName} has no commits ahead of base. Re-processing task ${taskId}.`,
        );
        await addTaskComment(
          taskId,
          `🔄 Automation restarted — found empty branch from prior run. Re-processing task.`,
        );
        // Return to base and clean up the empty branch, then process fresh
        await returnToBaseBranch();
        await deleteLocalBranch(branchName);
        await processTask(task);
        continue; // processTask handles its own return-to-base
      }

      // Return to base branch for the next task
      await returnToBaseBranch();
    } catch (err) {
      log(
        "error",
        `Failed to recover task ${taskId}: ${(err as Error).message}`,
      );
      try {
        await notifyTaskCreator(
          taskId,
          task.creator,
          `⚠️ Automation restarted but failed to recover this task:\n\n` +
            `\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
            `Moving to blocked.`,
        );
        await updateTaskStatus(taskId, STATUS.BLOCKED);
      } catch {
        log("error", `Could not update task ${taskId} after recovery failure`);
      }

      // Best-effort return to base
      try {
        await returnToBaseBranch();
      } catch {
        log("warn", "Could not return to base branch during recovery");
      }
    }
  }

  log("info", "Orphaned task recovery complete.", { elapsed: recoveryTimer() });
}

/**
 * Dispatch a single task into a worktree slot (or the main checkout in
 * single-task mode). Returns the promise tracking the task; the caller is
 * responsible for registering it in `inFlightPromises` and the in-flight set.
 *
 * IMPORTANT: callers must add the task ID to `inFlightTaskIds` BEFORE
 * awaiting this function so that the same poll cycle can't double-pick it.
 */
async function dispatchTask(
  task: ClickUpTask,
  existingPrUrl: string | null,
  trigger: ReturningTaskTrigger = "todo",
): Promise<void> {
  let slot: Slot | null = null;
  let cwd: string | undefined = undefined;

  if (MAX_CONCURRENT_TASKS > 1) {
    slot = await acquireSlot();
    if (!slot) {
      // No slot available — should never hit this since pollForTasks checks
      // capacity first, but be defensive.
      log("warn", `No worktree slot available for task ${task.id}; processing in main tree`);
    } else {
      cwd = slot.path;
      log("info", `Task ${task.id} dispatched to slot ${slot.index} (${slot.path})`);
    }
  }

  try {
    if (existingPrUrl) {
      await processReturningTask(task, existingPrUrl, cwd, trigger);
    } else {
      await processTask(task, { cwd });
    }
  } finally {
    if (slot) releaseSlot(slot);
  }
}

// How many automatic PR-feedback rounds a task may consume per runner
// session. Guards against ping-pong with auto-review bots that re-review
// every push: when the cap is hit, a ClickUp comment is posted (advancing
// the feedback boundary, which stops re-detection) and the task waits for
// a human. The counter resets on relaunch/restart.
const MAX_FEEDBACK_ROUNDS_PER_SESSION = 3;
const feedbackRoundCounts = new Map<string, number>();

// Review states whose top-level body should NOT trigger a feedback round:
// an approval ("LGTM!") or a dismissed/pending review is not a request for
// changes. Inline code comments still trigger regardless of review state.
const NON_ACTIONABLE_REVIEW_STATES = new Set(["APPROVED", "DISMISSED", "PENDING"]);

/**
 * Poll tasks sitting in IN PROGRESS / IN REVIEW for new review comments on
 * their PRs, and dispatch any that have some through the returning-task flow
 * (which collects the feedback, runs Claude on it, and pushes the updates).
 *
 * "New" means a GitHub PR review or inline code comment created after the
 * automation's last ClickUp comment on the task — that comment marks the
 * last time the automation acted, so anything older was already seen or
 * addressed. This boundary is what prevents an infinite loop: once the
 * feedback round completes, the automation's summary comment moves the
 * boundary past the comments it just addressed.
 *
 * Tasks without any automation comment are skipped (nothing to anchor the
 * boundary to — those PRs are managed manually, so leave them alone).
 *
 * Returns the number of tasks dispatched; they consume concurrency capacity
 * just like TODO dispatches.
 */
async function dispatchTasksWithNewPRFeedback(capacity: number): Promise<number> {
  if (!ADDRESS_PR_COMMENTS || capacity <= 0) return 0;

  let candidates: ClickUpTask[] = [];
  try {
    // In-review tasks first — those are the ones reviewers are commenting on.
    const [inReview, inProgress] = await Promise.all([
      getTasksByStatus(STATUS.IN_REVIEW),
      getTasksByStatus(STATUS.IN_PROGRESS),
    ]);
    candidates = [...inReview, ...inProgress];
  } catch (err) {
    log("warn", `Could not fetch tasks for PR feedback check: ${(err as Error).message}`);
    return 0;
  }

  let dispatched = 0;
  for (const task of candidates) {
    if (isShuttingDown || dispatched >= capacity) break;
    if (inFlightTaskIds.has(task.id) || !isValidTaskId(task.id)) continue;

    try {
      // One comments fetch serves both the PR URL lookup and the boundary.
      const comments = await getTaskComments(task.id);
      const prUrl = findPRUrlInCommentList(comments);
      if (!prUrl) continue;

      const sinceMs = getLastAutomationCommentDate(comments);
      if (sinceMs === null) continue;

      if ((await getPRState(prUrl)) !== "open") continue;

      const [reviews, inlineComments] = await Promise.all([
        getPRReviewComments(prUrl),
        getPRInlineComments(prUrl),
      ]);
      const newFeedbackCount =
        filterCommentsSince(reviews, sinceMs).filter(
          (r) => !NON_ACTIONABLE_REVIEW_STATES.has((r.state ?? "").toUpperCase()),
        ).length + filterCommentsSince(inlineComments, sinceMs).length;
      if (newFeedbackCount === 0) continue;

      const rounds = feedbackRoundCounts.get(task.id) ?? 0;
      if (rounds >= MAX_FEEDBACK_ROUNDS_PER_SESSION) {
        log(
          "warn",
          `Task ${task.id} hit the automatic PR feedback round limit (${MAX_FEEDBACK_ROUNDS_PER_SESSION}). Leaving it for a human.`,
          { taskId: task.id },
        );
        // This comment carries an automation marker, so it advances the
        // feedback boundary and stops this task from being re-detected
        // every poll cycle.
        await addTaskComment(
          task.id,
          `⚠️ Automation reached the limit of ${MAX_FEEDBACK_ROUNDS_PER_SESSION} automatic PR feedback rounds for this task.\n\n` +
            `PR: ${prUrl}\n\n` +
            `There are still unaddressed review comments. Move this task back to "${STATUS.TODO}" to run another round, or address them manually.`,
        );
        continue;
      }

      log(
        "info",
        `Task "${task.name}" (${task.id}, status "${task.status?.status ?? "unknown"}") has ${newFeedbackCount} new PR review comment(s). Dispatching to address them: ${prUrl}`,
        { taskId: task.id },
      );
      feedbackRoundCounts.set(task.id, rounds + 1);

      // Same in-flight bookkeeping as the TODO dispatch below, but NOT
      // processedTaskIds — feedback rounds must stay repeatable so the next
      // batch of review comments triggers another round.
      inFlightTaskIds.add(task.id);
      const promise = dispatchTask(task, prUrl, "pr_feedback")
        .catch((err) => {
          log("error", `Unhandled error addressing PR feedback for task ${task.id}: ${(err as Error).message}`);
        })
        .finally(() => {
          inFlightTaskIds.delete(task.id);
          inFlightPromises.delete(task.id);
        });
      inFlightPromises.set(task.id, promise);
      dispatched++;
    } catch (err) {
      log("warn", `PR feedback check failed for task ${task.id}: ${(err as Error).message}`);
    }
  }

  return dispatched;
}

/**
 * Main polling loop. In parallel mode, dispatches up to (MAX_CONCURRENT_TASKS
 * - inFlight) tasks per cycle without waiting for them to finish — the loop
 * keeps polling at POLL_INTERVAL_MS so tasks run truly in parallel.
 */
async function pollForTasks(): Promise<void> {
  if (isShuttingDown || isPolling) return;

  // In MAX=1 (single-tree) mode, the in-flight task is using the main
  // checkout that approved-task processing also touches. Skip the whole
  // cycle to preserve the previous serial behavior. In parallel mode
  // tasks live in worktree slots so approved-task processing is safe to
  // run alongside them.
  if (MAX_CONCURRENT_TASKS === 1 && inFlightTaskIds.size > 0) {
    return;
  }

  const pollTimer = startTimer();
  try {
    isPolling = true;

    // First, check for approved tasks that need their PRs merged.
    // Approved merges run sequentially in the main checkout — they're fast
    // and we'd rather not consume a slot for a `gh pr merge` call.
    const approvedTasks = await getTasksByStatus(STATUS.APPROVED);
    for (const task of approvedTasks) {
      if (isShuttingDown) break;
      await processApprovedTask(task);
    }

    if (isShuttingDown) return;

    // If a merge happened, skip TODO processing — we'll rebuild and relaunch first
    // so that subsequent tasks run against the freshly merged code.
    if (shouldRelaunchAfterMerge) {
      log("info", "Skipping TODO processing — relaunch pending after merge.");
      return;
    }

    // Compute remaining capacity: how many more tasks we can start this cycle.
    let capacity = Math.max(0, MAX_CONCURRENT_TASKS - inFlightTaskIds.size);
    if (capacity === 0) {
      log("debug", `All ${MAX_CONCURRENT_TASKS} slot(s) busy. Waiting for in-flight tasks.`);
      return;
    }

    // Next, check in-progress / in-review tasks for new PR review comments
    // and dispatch feedback rounds. These run before fresh TODO pickups —
    // unblocking a waiting reviewer beats starting new work.
    capacity -= await dispatchTasksWithNewPRFeedback(capacity);
    if (capacity === 0) {
      log("debug", "All slots consumed by PR feedback rounds. Waiting for next cycle.");
      return;
    }

    if (isShuttingDown) return;

    // Then, check for TODO tasks to implement
    const tasks = await getTasksByStatus(STATUS.TODO);

    // Filter out tasks already processed this session AND tasks already
    // being worked on by some slot right now.
    const eligibleTasks = tasks.filter(
      (t) => !processedTaskIds.has(t.id) && !inFlightTaskIds.has(t.id),
    );

    if (eligibleTasks.length === 0) {
      if (tasks.length > 0) {
        log("debug", `${tasks.length} TODO task(s) found but all already processed or in flight. Waiting...`);
      } else {
        log("debug", "No tasks found. Waiting...");
      }
      return;
    }

    // Walk the eligible list and pick up to `capacity` tasks whose
    // dependencies are all resolved.
    const picked: ClickUpTask[] = [];
    let blockedCount = 0;
    for (const candidate of eligibleTasks) {
      if (isShuttingDown) return;
      if (picked.length >= capacity) break;

      try {
        const unresolved = await getUnresolvedDependencies(candidate.id);
        if (unresolved.length > 0) {
          blockedCount++;
          const depList = unresolved
            .map((d) => `"${d.name}" (${d.id}, status: ${d.status})`)
            .join(", ");
          log(
            "info",
            `Task "${candidate.name}" (${candidate.id}) will NOT be worked on — it has ${unresolved.length} unresolved dependency/ies that must be completed first: ${depList}`,
          );
          continue;
        }
      } catch (err) {
        log(
          "warn",
          `Failed to check dependencies for task ${candidate.id}: ${(err as Error).message}. Processing anyway.`,
        );
      }

      picked.push(candidate);
    }

    if (picked.length === 0) {
      if (blockedCount > 0) {
        log(
          "info",
          `${eligibleTasks.length} TODO task(s) found but all ${blockedCount} are blocked by unresolved dependencies — none will be worked on until their dependencies are completed. Waiting for next poll cycle...`,
        );
      }
      return;
    }

    if (blockedCount > 0) {
      log("info", `Skipped ${blockedCount} task(s) due to unresolved dependencies.`);
    }

    log(
      "info",
      `Dispatching ${picked.length} task(s) to ${picked.length === 1 ? "slot" : "slots"} (in-flight: ${inFlightTaskIds.size}/${MAX_CONCURRENT_TASKS})`,
    );

    // Look up existing PR URLs in parallel so dispatch isn't bottlenecked
    // on serial API calls.
    const dispatchEntries = await Promise.all(
      picked.map(async (task) => {
        const existingPrUrl = await findPRUrlInComments(task.id);
        return { task, existingPrUrl };
      }),
    );

    for (const { task, existingPrUrl } of dispatchEntries) {
      // CRITICAL: mark in-flight synchronously before the await chain in
      // dispatchTask, otherwise the next poll could double-pick this task.
      processedTaskIds.add(task.id);
      inFlightTaskIds.add(task.id);

      const promise = dispatchTask(task, existingPrUrl)
        .catch((err) => {
          log("error", `Unhandled error in dispatched task ${task.id}: ${(err as Error).message}`);
        })
        .finally(() => {
          inFlightTaskIds.delete(task.id);
          inFlightPromises.delete(task.id);
        });

      inFlightPromises.set(task.id, promise);
    }
  } catch (err) {
    log("error", `Polling error: ${(err as Error).message}`);
  } finally {
    isPolling = false;
    log("debug", "Poll cycle completed", { elapsed: pollTimer() });
  }
}

/**
 * Run a single task by ID (skip polling, process one task).
 */
export async function runSingleTask(taskId: string, options?: { interactive?: boolean }): Promise<void> {
  interactiveMode = options?.interactive ?? false;

  if (DRY_RUN) {
    log("info", "\n=== DRY RUN MODE — no changes will be made ===\n");
  }

  // Prevent concurrent instances (skip in dry-run since we're read-only)
  if (!DRY_RUN) acquireLock();

  try {
    // Run preflight checks before processing the task
    await runPreflightOrAbort();

    const task = await getTask(taskId);

    // Warn about unresolved dependencies (but still proceed since this is an explicit single-task run)
    try {
      const unresolved = await getUnresolvedDependencies(taskId);
      if (unresolved.length > 0) {
        const depList = unresolved
          .map((d) => `"${d.name}" (${d.id}, status: ${d.status})`)
          .join(", ");
        log(
          "warn",
          `Task has ${unresolved.length} unresolved dependency/ies: ${depList}. Proceeding anyway since this is a direct task run.`,
        );
      }
    } catch (err) {
      log("warn", `Could not check dependencies: ${(err as Error).message}`);
    }

    await processTask(task);
  } finally {
    if (!DRY_RUN) releaseLock();
  }
}

interface StackLeafRecord {
  leaf: ClickUpTask;
  disposition: "completed" | "adopted" | "skipped" | "failed" | "not_attempted";
  detail?: string;
  branchName?: string;
  prUrl?: string;
}

/**
 * Build the summary comment posted on the parent task after a stack run.
 */
function buildStackSummaryComment(
  records: StackLeafRecord[],
  abortReason: string | null,
): string {
  const lines: string[] = [];
  const completed = records.filter((r) => r.disposition === "completed").length;

  lines.push(
    abortReason
      ? `⚠️ Automation stack run aborted after ${completed} new PR(s).`
      : `✅ Automation stack run finished: ${completed} new PR(s) created.`,
  );
  lines.push("");

  records.forEach((r, i) => {
    const label = `${i + 1}. ${r.leaf.name} (CU-${r.leaf.id})`;
    switch (r.disposition) {
      case "completed":
        lines.push(`${label} — ✅ PR: ${r.prUrl ?? "(unknown)"}`);
        break;
      case "adopted":
        lines.push(`${label} — 🔁 already in review${r.prUrl ? `: ${r.prUrl}` : ""}`);
        break;
      case "skipped":
        lines.push(`${label} — ⏭️ skipped (${r.detail ?? "already done"})`);
        break;
      case "failed":
        lines.push(`${label} — ❌ ${r.detail ?? "failed"}`);
        break;
      case "not_attempted":
        lines.push(`${label} — ⏸️ not attempted (stack aborted earlier)`);
        break;
    }
  });

  lines.push("");
  lines.push(
    `The PRs are stacked: each one targets the branch of the PR before it. ` +
      `Merge them bottom-up, in the order listed above.`,
  );
  if (abortReason) {
    lines.push("");
    lines.push(`Resolve the failure and re-run \`--stack\` to resume — finished PRs are picked up where they left off.`);
  }

  return lines.join("\n");
}

/**
 * Implement all leaf subtasks of a parent task sequentially as stacked PRs.
 * Leaf subtasks are collected recursively (subtasks that have their own
 * subtasks are treated as grouping only), ordered by their ClickUp
 * dependencies, and processed one at a time in the main checkout: the first
 * branch is created from BASE_BRANCH, each following branch from the previous
 * one, and each PR targets its branch's base.
 * Aborts the remaining series when a subtask fails; re-running resumes.
 */
export async function runTaskStack(
  parentTaskId: string,
  options?: { interactive?: boolean },
): Promise<StackRunSummary> {
  interactiveMode = options?.interactive ?? false;

  if (DRY_RUN) {
    log("info", "\n=== DRY RUN MODE — no changes will be made ===\n");
  }

  if (!isValidTaskId(parentTaskId)) {
    throw new Error(`Invalid task ID format: ${parentTaskId}`);
  }

  // Prevent concurrent instances (skip in dry-run since we're read-only)
  if (!DRY_RUN) acquireLock();

  try {
    await runPreflightOrAbort();

    const parent = await getTask(parentTaskId);
    log("info", `Collecting leaf subtasks of "${parent.name}" (${parentTaskId})...`);
    const leaves = await getLeafSubtasks(parentTaskId);
    if (leaves.length === 0) {
      throw new Error(
        `Task "${parent.name}" (${parentTaskId}) has no subtasks — use --once ${parentTaskId} to process it directly.`,
      );
    }

    // Order by in-stack dependencies; throws on a dependency cycle
    const ordered = orderTasksByDependencies(leaves);
    const stackIds = new Set(ordered.map((t) => t.id));

    // Warn about unresolved dependencies OUTSIDE the stack (in-stack ones are
    // satisfied by the ordering). Warn-only, matching --once behavior.
    for (const leaf of ordered) {
      try {
        const external = (await getUnresolvedDependencies(leaf.id)).filter(
          (d) => !stackIds.has(d.id),
        );
        if (external.length > 0) {
          const depList = external
            .map((d) => `"${d.name}" (${d.id}, status: ${d.status})`)
            .join(", ");
          log(
            "warn",
            `Subtask "${leaf.name}" (${leaf.id}) has unresolved dependencies outside the stack: ${depList}. Proceeding anyway.`,
          );
        }
      } catch (err) {
        log("warn", `Could not check dependencies for ${leaf.id}: ${(err as Error).message}`);
      }
    }

    // Print the planned stack topology
    log("info", `\nPlanned stack (${ordered.length} task(s), base: ${BASE_BRANCH}):`);
    let plannedBase = BASE_BRANCH;
    for (let i = 0; i < ordered.length; i++) {
      const leaf = ordered[i]!;
      const branch = `${BRANCH_PREFIX}/CU-${leaf.id}-${slugify(leaf.name)}`;
      log("info", `  ${i + 1}. ${leaf.name} (${leaf.id}) — ${branch} → PR into ${plannedBase}`);
      plannedBase = branch;
    }

    if (AUTO_APPROVE) {
      log(
        "warn",
        "AUTO_APPROVE is suppressed in stack mode — stacked PRs must be merged bottom-up, in order.",
      );
    }

    if (DRY_RUN) {
      // Annotate the plan with existing branches/PRs (read-only), then stop.
      for (const leaf of ordered) {
        const existing = await findBranchForTask(leaf.id);
        const prUrl = await findPRUrlInComments(leaf.id);
        if (existing || prUrl) {
          log(
            "info",
            `[DRY RUN] ${leaf.id}: existing branch: ${existing ?? "none"}, PR: ${prUrl ?? "none"}`,
          );
        }
      }
      return { total: ordered.length, completed: 0, skipped: 0, aborted: false };
    }

    // One up-front fetch/sync; each processTask re-syncs its own base
    await syncBaseBranch();

    let currentBase = BASE_BRANCH;
    let previousPrUrl: string | undefined;
    const completedInSeries: StackInfo["completedInSeries"] = [];
    const records: StackLeafRecord[] = [];
    let completed = 0;
    let skipped = 0;
    let abortReason: string | null = null;

    // Whether an existing branch can serve as (or extend) the stack head.
    // The ancestry requirement only applies when the current base is itself a
    // stack branch — a branch must contain its predecessor's work. When the
    // current base is BASE_BRANCH there is no predecessor, and requiring
    // descent from the latest base would falsely reject resumes after the
    // base branch has advanced.
    const isOnStack = async (branch: string): Promise<boolean> =>
      currentBase === BASE_BRANCH || isAncestor(currentBase, branch);

    for (let i = 0; i < ordered.length; i++) {
      const leaf = ordered[i]!;

      if (abortReason) {
        records.push({ leaf, disposition: "not_attempted" });
        continue;
      }

      log("info", `\n>>> Stack ${i + 1}/${ordered.length}: ${leaf.name} (${leaf.id}) — base: ${currentBase}`);

      // Re-fetch for a fresh status (statuses may change during a long run)
      let fresh: ClickUpTask;
      try {
        fresh = await getTask(leaf.id);
      } catch (err) {
        abortReason = `Could not fetch subtask ${leaf.id}: ${(err as Error).message}`;
        records.push({ leaf, disposition: "failed", detail: abortReason });
        continue;
      }
      const status = fresh.status?.status?.toLowerCase() ?? "";
      const existing = await findBranchForTask(leaf.id);

      if (status === STATUS.COMPLETED.toLowerCase()) {
        // Already done. If it left an unmerged stack branch behind, keep
        // stacking on it; otherwise its work is already in the chain's base.
        if (existing && (await isOnStack(existing))) {
          currentBase = existing;
        }
        skipped++;
        records.push({
          leaf,
          disposition: "skipped",
          detail: "already completed",
          branchName: existing ?? undefined,
        });
        continue;
      }

      if (
        status === STATUS.IN_REVIEW.toLowerCase() ||
        status === STATUS.APPROVED.toLowerCase()
      ) {
        // Typically a PR from a previous stack run awaiting review — adopt
        // its branch as the stack head and continue with the next subtask.
        if (existing && (await isOnStack(existing))) {
          currentBase = existing;
          const prUrl = (await findExistingPR(existing)) ?? undefined;
          previousPrUrl = prUrl;
          completedInSeries.push({ name: fresh.name, branchName: existing, prUrl });
          skipped++;
          records.push({
            leaf,
            disposition: "adopted",
            detail: `status "${status}" — reusing its branch as the stack base`,
            branchName: existing,
            prUrl,
          });
          continue;
        }
        abortReason =
          `Subtask "${fresh.name}" (${leaf.id}) is "${status}" but its branch is ` +
          (existing
            ? `not based on the stack (${existing} does not contain ${currentBase}).`
            : `missing.`) +
          ` Merge or complete it first, then re-run --stack.`;
        records.push({ leaf, disposition: "failed", detail: abortReason });
        continue;
      }

      if (
        status !== STATUS.TODO.toLowerCase() &&
        status !== STATUS.IN_PROGRESS.toLowerCase()
      ) {
        // blocked / require input / unknown — unsafe to build on ambiguity
        abortReason =
          `Subtask "${fresh.name}" (${leaf.id}) has unresolved status "${status}". ` +
          `Resolve it in ClickUp (move it to "${STATUS.TODO}") and re-run --stack.`;
        records.push({ leaf, disposition: "failed", detail: abortReason });
        continue;
      }

      // TODO / IN_PROGRESS: a leftover branch must be based on the stack,
      // since createTaskBranch will reuse it instead of branching fresh.
      if (existing && !(await isOnStack(existing))) {
        abortReason =
          `Subtask "${fresh.name}" (${leaf.id}) has a stale branch ${existing} that is not ` +
          `based on ${currentBase}. Delete the branch or finish that task via --once, then re-run --stack.`;
        records.push({ leaf, disposition: "failed", detail: abortReason });
        continue;
      }

      const info: StackInfo = {
        parentTaskName: parent.name,
        parentTaskUrl: parent.url,
        position: i + 1,
        total: ordered.length,
        baseBranch: currentBase,
        previousPrUrl,
        completedInSeries: [...completedInSeries],
      };
      const stack: StackContext = {
        promptContext: generateStackPromptContext(info),
        prNote: generateStackPRNote(info),
      };

      const outcome = await processTask(fresh, { baseBranch: currentBase, stack });

      if (outcome.status === "success" && outcome.branchName) {
        completed++;
        currentBase = outcome.branchName;
        previousPrUrl = outcome.prUrl;
        completedInSeries.push({
          name: fresh.name,
          branchName: outcome.branchName,
          prUrl: outcome.prUrl,
        });
        records.push({
          leaf,
          disposition: "completed",
          branchName: outcome.branchName,
          prUrl: outcome.prUrl,
        });
      } else if (outcome.status === "merged") {
        // PR already merged into its base — its work is already in the chain
        skipped++;
        records.push({
          leaf,
          disposition: "skipped",
          detail: "PR already merged",
          prUrl: outcome.prUrl,
        });
      } else {
        abortReason =
          `Subtask "${fresh.name}" (${leaf.id}) ended with "${outcome.status}". ` +
          `See the task's comments for details.`;
        records.push({
          leaf,
          disposition: "failed",
          detail: abortReason,
          branchName: outcome.branchName,
          prUrl: outcome.prUrl,
        });
      }
    }

    if (abortReason) {
      log("error", `Stack run aborted: ${abortReason}`);
    }
    log(
      "info",
      `\nStack run finished: ${completed} completed, ${skipped} skipped, ${ordered.length} total.`,
    );

    try {
      await addTaskComment(parentTaskId, buildStackSummaryComment(records, abortReason));
    } catch (err) {
      log("warn", `Could not post stack summary on parent task: ${(err as Error).message}`);
    }

    return {
      total: ordered.length,
      completed,
      skipped,
      aborted: abortReason !== null,
    };
  } finally {
    if (!DRY_RUN) releaseLock();
  }
}

/**
 * Start the continuous polling loop.
 * Returns true if the runner should be relaunched, false on normal shutdown.
 */
export async function startRunner(options?: { interactive?: boolean }): Promise<boolean> {
  // Reset state for fresh run (supports relaunch loop)
  isShuttingDown = false;
  isPolling = false;
  shouldRelaunchAfterMerge = false;
  processedTaskIds.clear();
  inFlightTaskIds.clear();
  inFlightPromises.clear();
  feedbackRoundCounts.clear();
  interactiveMode = options?.interactive ?? false;

  if (DRY_RUN) {
    log("info", "\n=== DRY RUN MODE — no changes will be made ===\n");
  }

  // Prevent concurrent instances (skip in dry-run since we're read-only)
  if (!DRY_RUN) acquireLock();

  log("info", "=== ClickUp Task Automation Runner ===");
  log("info", `Task source: ${CLICKUP_PARENT_TASK_ID ? `parent task ${CLICKUP_PARENT_TASK_ID} (subtasks)` : `list ${CLICKUP_LIST_ID}`}`);
  log("info", `Polling interval: ${POLL_INTERVAL_MS / 1000}s`);
  log("info", `Base branch: ${BASE_BRANCH}`);
  log("info", `Max concurrent tasks: ${MAX_CONCURRENT_TASKS}${MAX_CONCURRENT_TASKS > 1 ? " (parallel mode — worktrees under .clawdup-worktrees/)" : ""}`);
  if (AUTO_APPROVE) {
    log("info", "Auto-approve mode: ENABLED — PRs will be merged immediately after completion");
  }

  const relaunchEnabled = RELAUNCH_INTERVAL_MS > 0;
  if (relaunchEnabled) {
    log("info", `Relaunch interval: ${RELAUNCH_INTERVAL_MS / 1000 / 60}min`);
  }

  // Validate configuration
  const repo = await detectGitHubRepo();
  log("info", `GitHub repo: ${repo}`);

  // Validate ClickUp statuses
  const statusesValid = await validateStatuses();
  if (!statusesValid) {
    log(
      "warn",
      "Status validation failed. The runner will continue but may encounter errors.",
    );
  }

  // In dry-run mode, skip state management and recovery — just poll once and exit
  if (DRY_RUN) {
    log("info", "Runner started in dry-run mode. Performing a single poll cycle...\n");
    await pollForTasks();
    log("info", "\n=== DRY RUN complete — no changes were made ===");
    return false;
  }

  // Run preflight environment checks before proceeding.
  // This validates git state, remote, lock file, and ClickUp connectivity.
  await runPreflightOrAbort();

  // Ensure we start from a clean state — forcefully clean up any
  // leftover dirty state (unresolved merges, uncommitted changes, etc.)
  // so the runner can always start fresh.
  await ensureCleanState();
  await syncBaseBranch();

  // Clean up stale local branches from previous runs so they don't
  // interfere with fresh branch creation or cause checkout issues.
  await pruneLocalBranches();

  // Set up the worktree slot pool (parallel mode) and clear out any
  // stale worktree registrations left over from a crashed prior run.
  await pruneWorktrees();
  initSlotPool();

  // Recover any tasks left "in progress" from a previous crash
  await recoverOrphanedTasks();

  // Set up graceful shutdown (only register once to avoid duplicate listeners)
  if (!signalHandlersRegistered) {
    const shutdown = (signalName: string) => {
      log("info", `\nReceived ${signalName}. Shutting down gracefully...`);
      isShuttingDown = true;
      // If nothing is in flight and we're not mid-poll, exit immediately.
      // Otherwise allow the polling-interval / in-flight-task code paths
      // to finish — they observe isShuttingDown.
      if (!isPolling && inFlightTaskIds.size === 0) {
        releaseLock();
        process.exit(0);
      }
      log(
        "info",
        `Waiting for ${inFlightTaskIds.size} in-flight task(s) to finish...`,
      );
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    process.on("exit", () => {
      releaseLock();
    });

    signalHandlersRegistered = true;
  }

  log("info", "Runner started. Polling for tasks...\n");

  const runnerStartTime = Date.now();

  // Initial poll
  await pollForTasks();

  // Wait for any in-flight tasks before relaunching or shutting down,
  // so the next runner instance doesn't race with this one's slots.
  const drainInFlight = async (): Promise<void> => {
    if (inFlightTaskIds.size === 0) return;
    log("info", `Waiting for ${inFlightTaskIds.size} in-flight task(s) before relaunch/shutdown...`);
    await Promise.all(Array.from(inFlightPromises.values()));
  };

  // Check if relaunch is needed — either after a merge or when the timer expires
  const shouldRelaunchNow = shouldRelaunchAfterMerge
    || (relaunchEnabled && Date.now() - runnerStartTime >= RELAUNCH_INTERVAL_MS);
  if (shouldRelaunchNow && !isPolling && !isShuttingDown) {
    await drainInFlight();
    log("info", shouldRelaunchAfterMerge
      ? "Merge completed — rebuilding and relaunching to pick up latest code..."
      : "Relaunch interval reached. Pulling base branch before relaunch...");
    try {
      await syncBaseBranch();
    } catch (err) {
      log("error", `Failed to sync base branch before relaunch: ${(err as Error).message}`);
    }
    shouldRelaunchAfterMerge = false;
    releaseLock();
    return true;
  }

  // Start polling loop
  return new Promise<boolean>((resolve) => {
    const interval = setInterval(async () => {
      if (isShuttingDown) {
        clearInterval(interval);
        await drainInFlight();
        releaseLock();
        resolve(false);
        return;
      }

      await pollForTasks();

      // Check if relaunch is needed — either after a merge or when the timer expires
      const shouldRelaunch = shouldRelaunchAfterMerge
        || (relaunchEnabled && Date.now() - runnerStartTime >= RELAUNCH_INTERVAL_MS);
      if (shouldRelaunch && !isPolling && !isShuttingDown) {
        clearInterval(interval);
        await drainInFlight();
        log("info", shouldRelaunchAfterMerge
          ? "Merge completed — rebuilding and relaunching to pick up latest code..."
          : "Relaunch interval reached. Pulling base branch before relaunch...");
        try {
          await syncBaseBranch();
        } catch (err) {
          log("error", `Failed to sync base branch before relaunch: ${(err as Error).message}`);
        }
        shouldRelaunchAfterMerge = false;
        releaseLock();
        resolve(true);
        return;
      }
    }, POLL_INTERVAL_MS);
  });
}
