// Main task runner - orchestrates the full ClickUp -> Claude -> GitHub pipeline

import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { POLL_INTERVAL_MS, STATUS, BASE_BRANCH, PROJECT_ROOT, log } from "./config.js";
import {
  getTasksByStatus,
  getTaskComments,
  updateTaskStatus,
  addTaskComment,
  notifyTaskCreator,
  formatTaskForClaude,
  slugify,
  isValidTaskId,
  validateStatuses,
  findPRUrlInComments,
  createTask,
} from "./clickup-api.js";
import {
  detectGitHubRepo,
  syncBaseBranch,
  createTaskBranch,
  hasChanges,
  getChangesSummary,
  commitChanges,
  pushBranch,
  createPullRequest,
  createEmptyCommit,
  markPRReady,
  closePullRequest,
  updatePullRequest,
  findExistingPR,
  returnToBaseBranch,
  deleteLocalBranch,
  isWorkingTreeClean,
  mergePullRequest,
  getPRState,
  findBranchForTask,
  checkoutExistingBranch,
  branchHasCommitsAheadOfBase,
  branchHasBeenPushed,
} from "./git-ops.js";
import {
  runClaudeOnTask,
  extractNeedsInputReason,
  generateCommitMessage,
  generatePRBody,
} from "./claude-worker.js";
import type { ClickUpTask, ClaudeResult } from "./types.js";

let isShuttingDown = false;
let isProcessing = false;

const TODO_FILE_PATH = resolve(PROJECT_ROOT, ".clawup.todo.json");

/**
 * Process the .clawup.todo.json file if it exists.
 * Creates new ClickUp tasks for each entry and deletes the file afterward.
 */
async function processTodoFile(): Promise<void> {
  if (!existsSync(TODO_FILE_PATH)) return;

  try {
    const raw = readFileSync(TODO_FILE_PATH, "utf-8");
    const items = JSON.parse(raw) as Array<{ title?: string; description?: string }>;

    if (!Array.isArray(items)) {
      log("warn", ".clawup.todo.json does not contain an array, skipping");
      return;
    }

    for (const item of items) {
      if (!item.title) {
        log("warn", "Skipping todo entry with no title");
        continue;
      }
      try {
        const created = await createTask(item.title, item.description);
        log("info", `Created follow-up task: "${item.title}" (${created.id})`);
      } catch (err) {
        log("error", `Failed to create follow-up task "${item.title}": ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log("error", `Failed to process .clawup.todo.json: ${(err as Error).message}`);
  } finally {
    try {
      unlinkSync(TODO_FILE_PATH);
      log("debug", "Deleted .clawup.todo.json");
    } catch {
      // ignore if already gone
    }
  }
}

/**
 * Process a single ClickUp task end-to-end.
 * Always starts from the latest base branch and creates a PR immediately
 * so that work is visible from the start.
 */
async function processTask(task: ClickUpTask): Promise<void> {
  const taskId = task.id;
  const taskName = task.name;
  const slug = slugify(taskName);
  let branchName: string | null = null;
  let prUrl: string | null = null;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `Processing task: ${taskName} (${taskId})`);
  log("info", `URL: ${task.url}`);
  log("info", `${"=".repeat(60)}\n`);

  // Validate task ID format before using it in branch names and commands
  if (!isValidTaskId(taskId)) {
    log("error", `Invalid task ID format: ${taskId}. Skipping.`);
    return;
  }

  try {
    // Step 1: Move task to "In Progress"
    await updateTaskStatus(taskId, STATUS.IN_PROGRESS);

    // Step 2: Create a feature branch from the latest base branch
    branchName = await createTaskBranch(taskId, slug);
    log("info", `Working on branch: ${branchName}`);

    // Step 3: Create a PR immediately so work is visible from the start.
    // Check if a PR already exists for this branch (e.g. from a previous run).
    prUrl = await findExistingPR(branchName);

    if (!prUrl) {
      // Create an empty commit so we can push and open a draft PR
      await createEmptyCommit(
        `[CU-${taskId}] Starting work on: ${taskName}`,
      );
      await pushBranch(branchName);
      prUrl = await createPullRequest({
        title: `[CU-${taskId}] ${taskName}`,
        body:
          `🤖 Automation is working on this task.\n\n` +
          `**Task:** ${task.url}\n\n` +
          `This PR will be updated with changes once implementation is complete.`,
        branchName,
        baseBranch: BASE_BRANCH,
        draft: true,
      });
      log("info", `Draft PR created: ${prUrl}`);
    } else {
      log("info", `Existing PR found: ${prUrl}`);
    }

    await addTaskComment(
      taskId,
      `🤖 Automation picked up this task and is now working on it.\n\nPR: ${prUrl}`,
    );

    // Step 4: Fetch comments, format the task for Claude, and run it
    const comments = await getTaskComments(taskId);
    const taskPrompt = formatTaskForClaude(task, comments);
    const result = await runClaudeOnTask(taskPrompt, taskId);

    // Step 4b: Process any follow-up tasks Claude created BEFORE committing.
    // This must happen before commitChanges() because git add -A would
    // include the file, and switching branches later would remove it.
    await processTodoFile();

    // Step 5: Handle the result
    if (result.needsInput) {
      // Claude needs more information
      await handleNeedsInput(task, result, branchName, prUrl);
      return;
    }

    if (!result.success) {
      // Claude encountered an error
      await handleError(task, result, branchName, prUrl);
      return;
    }

    // Step 6: Check if Claude actually made changes
    const changed = await hasChanges();
    if (!changed) {
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
      await closePRAndCleanup(prUrl, branchName);
      return;
    }

    // Step 7: Commit, push, and update the PR
    const commitMsg = generateCommitMessage(task, result.output);
    await commitChanges(commitMsg);
    await pushBranch(branchName);

    // Update the PR body with full details and mark it as ready for review
    const { files } = await getChangesSummary();
    const prBody = generatePRBody(task, result.output, files);
    await updatePullRequest(prUrl, { body: prBody });
    await markPRReady(prUrl);

    // Step 8: Update ClickUp task
    await updateTaskStatus(taskId, STATUS.IN_REVIEW);
    await addTaskComment(
      taskId,
      `✅ Automation completed! The pull request is ready for review:\n\n` +
        `${prUrl}\n\n` +
        `Branch: \`${branchName}\`\n` +
        `Files changed: ${files.length}\n\n` +
        `Please review the PR. When ready, move this task to "${STATUS.APPROVED}" and the automation will merge it.`,
    );

    log("info", `Task ${taskId} completed successfully! PR: ${prUrl}`);
  } catch (err) {
    log("error", `Error processing task ${taskId}: ${(err as Error).message}`);

    try {
      await notifyTaskCreator(
        taskId,
        task.creator,
        `❌ Automation encountered an error:\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
          `The task has been moved to "Blocked". Please investigate and retry.` +
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
      await cleanupBranch(branchName);
    }
  } finally {
    // Always return to base branch
    try {
      await returnToBaseBranch();
    } catch {
      log("warn", "Could not return to base branch");
    }
    // Pick up any follow-up tasks Claude created
    await processTodoFile();
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
): Promise<void> {
  const reason = extractNeedsInputReason(result.output);

  log("info", `Task ${task.id} requires more input: ${reason}`);

  await notifyTaskCreator(
    task.id,
    task.creator,
    `🔍 Automation needs more information to complete this task:\n\n${reason}\n\n` +
      `Please add the requested details and move this task back to "${STATUS.TODO}" to retry.`,
  );
  await updateTaskStatus(task.id, STATUS.REQUIRE_INPUT);

  // Close the draft PR and clean up the branch since no work was done
  await closePRAndCleanup(prUrl, branchName);
}

/**
 * Handle case where Claude encountered an error.
 */
async function handleError(
  task: ClickUpTask,
  result: ClaudeResult,
  branchName: string,
  prUrl: string | null,
): Promise<void> {
  const errorMsg = result.error || "Unknown error";

  log("error", `Task ${task.id} failed: ${errorMsg}`);

  // Check if there were partial changes
  const changed = await hasChanges();

  if (changed) {
    // There are partial changes - commit them and push (PR already exists)
    try {
      await commitChanges(
        `[CU-${task.id}] WIP: ${task.name} (partial - automation error)`,
      );
      await pushBranch(branchName);
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
      await closePRAndCleanup(prUrl, branchName);
    }
  } else {
    // No partial changes - close the draft PR and clean up
    await closePRAndCleanup(prUrl, branchName);
  }

  await updateTaskStatus(task.id, STATUS.BLOCKED);
}

/**
 * Clean up a branch that won't be used.
 */
async function cleanupBranch(branchName: string): Promise<void> {
  try {
    await returnToBaseBranch();
    await deleteLocalBranch(branchName);
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
): Promise<void> {
  if (prUrl) {
    try {
      await closePullRequest(prUrl);
    } catch {
      log("debug", "Could not close PR during cleanup (non-critical)");
    }
  }
  await cleanupBranch(branchName);
}

/**
 * Process an approved task: find its PR and merge it.
 */
async function processApprovedTask(task: ClickUpTask): Promise<void> {
  const taskId = task.id;
  const taskName = task.name;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `Merging approved task: ${taskName} (${taskId})`);
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

    // Merge the PR
    await mergePullRequest(prUrl);

    // Move task to complete
    await updateTaskStatus(taskId, STATUS.COMPLETED);
    await addTaskComment(
      taskId,
      `🎉 PR merged successfully!\n\n${prUrl}\n\nTask is now complete.`,
    );

    log("info", `Task ${taskId} approved and merged: ${prUrl}`);
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
 * Recover tasks that were left "in progress" from a previous crash.
 * For each orphaned task, checks for an existing branch and resumes
 * from the appropriate point in the pipeline.
 */
async function recoverOrphanedTasks(): Promise<void> {
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

  log("info", "Orphaned task recovery complete.");
}

/**
 * Main polling loop.
 */
async function pollForTasks(): Promise<void> {
  if (isShuttingDown || isProcessing) return;

  try {
    isProcessing = true;

    // First, check for approved tasks that need their PRs merged
    const approvedTasks = await getTasksByStatus(STATUS.APPROVED);
    for (const task of approvedTasks) {
      if (isShuttingDown) break;
      await processApprovedTask(task);
    }

    if (isShuttingDown) return;

    // Then, check for new tasks to implement
    const tasks = await getTasksByStatus(STATUS.TODO);

    if (tasks.length === 0) {
      log("debug", "No tasks found. Waiting...");
      return;
    }

    // Process the highest-priority task
    const task = tasks[0]!;
    await processTask(task);
  } catch (err) {
    log("error", `Polling error: ${(err as Error).message}`);
  } finally {
    isProcessing = false;
  }
}

/**
 * Run a single task by ID (skip polling, process one task).
 */
export async function runSingleTask(taskId: string): Promise<void> {
  const { getTask } = await import("./clickup-api.js");
  const task = await getTask(taskId);
  await processTask(task);
}

/**
 * Start the continuous polling loop.
 */
export async function startRunner(): Promise<void> {
  log("info", "=== ClickUp Task Automation Runner ===");
  log("info", `Polling interval: ${POLL_INTERVAL_MS / 1000}s`);
  log("info", `Base branch: ${BASE_BRANCH}`);

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

  // Ensure we start from a clean state
  if (!(await isWorkingTreeClean())) {
    log(
      "error",
      "Working tree is not clean. Please commit or stash changes before running.",
    );
    process.exit(1);
  }

  // Recover any tasks left "in progress" from a previous crash
  await recoverOrphanedTasks();

  // Set up graceful shutdown
  process.on("SIGINT", () => {
    log("info", "\nReceived SIGINT. Shutting down gracefully...");
    isShuttingDown = true;
    if (!isProcessing) process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("info", "\nReceived SIGTERM. Shutting down gracefully...");
    isShuttingDown = true;
    if (!isProcessing) process.exit(0);
  });

  log("info", "Runner started. Polling for tasks...\n");

  // Initial poll
  await pollForTasks();

  // Start polling loop
  const interval = setInterval(async () => {
    if (isShuttingDown) {
      clearInterval(interval);
      return;
    }
    await pollForTasks();
  }, POLL_INTERVAL_MS);
}
