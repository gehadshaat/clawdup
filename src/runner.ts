// Main task runner - orchestrates the full ClickUp -> Claude -> GitHub pipeline

import { POLL_INTERVAL_MS, STATUS, BASE_BRANCH, log } from "./config.js";
import {
  getTasksByStatus,
  updateTaskStatus,
  addTaskComment,
  formatTaskForClaude,
  slugify,
  validateStatuses,
  findPRUrlInComments,
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
  returnToBaseBranch,
  deleteLocalBranch,
  isWorkingTreeClean,
  mergePullRequest,
  getPRState,
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

/**
 * Process a single ClickUp task end-to-end.
 */
async function processTask(task: ClickUpTask): Promise<void> {
  const taskId = task.id;
  const taskName = task.name;
  const slug = slugify(taskName);
  let branchName: string | null = null;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `Processing task: ${taskName} (${taskId})`);
  log("info", `URL: ${task.url}`);
  log("info", `${"=".repeat(60)}\n`);

  try {
    // Step 1: Move task to "In Progress"
    await updateTaskStatus(taskId, STATUS.IN_PROGRESS);
    await addTaskComment(
      taskId,
      `🤖 Automation picked up this task and is now working on it.`,
    );

    // Step 2: Create a feature branch
    branchName = await createTaskBranch(taskId, slug);
    log("info", `Working on branch: ${branchName}`);

    // Step 3: Format the task for Claude and run it
    const taskPrompt = formatTaskForClaude(task);
    const result = await runClaudeOnTask(taskPrompt, taskId);

    // Step 4: Handle the result
    if (result.needsInput) {
      // Claude needs more information
      await handleNeedsInput(task, result, branchName);
      return;
    }

    if (!result.success) {
      // Claude encountered an error
      await handleError(task, result, branchName);
      return;
    }

    // Step 5: Check if Claude actually made changes
    const changed = await hasChanges();
    if (!changed) {
      log(
        "warn",
        `Claude completed but made no file changes for task ${taskId}`,
      );
      await addTaskComment(
        taskId,
        `⚠️ Automation completed but no code changes were produced. This may mean:\n` +
          `- The task was already done\n` +
          `- The task description wasn't actionable\n` +
          `- Claude couldn't determine what changes to make\n\n` +
          `Please review and provide more specific instructions if needed.`,
      );
      await updateTaskStatus(taskId, STATUS.REQUIRE_INPUT);
      await cleanupBranch(branchName);
      return;
    }

    // Step 6: Commit, push, and create PR
    const commitMsg = generateCommitMessage(task, result.output);
    await commitChanges(commitMsg);

    await pushBranch(branchName);

    const { files } = await getChangesSummary();
    const prBody = generatePRBody(task, result.output, files);
    const prUrl = await createPullRequest({
      title: `[CU-${taskId}] ${taskName}`,
      body: prBody,
      branchName,
      baseBranch: BASE_BRANCH,
    });

    // Step 7: Update ClickUp task
    await updateTaskStatus(taskId, STATUS.IN_REVIEW);
    await addTaskComment(
      taskId,
      `✅ Automation completed! A pull request has been created:\n\n` +
        `${prUrl}\n\n` +
        `Branch: \`${branchName}\`\n` +
        `Files changed: ${files.length}\n\n` +
        `Please review the PR. When ready, move this task to "${STATUS.APPROVED}" and the automation will merge it.`,
    );

    log("info", `Task ${taskId} completed successfully! PR: ${prUrl}`);
  } catch (err) {
    log("error", `Error processing task ${taskId}: ${(err as Error).message}`);

    try {
      await addTaskComment(
        taskId,
        `❌ Automation encountered an error:\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n\n` +
          `The task has been moved to "Blocked". Please investigate and retry.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
    } catch (commentErr) {
      log(
        "error",
        `Failed to update task status: ${(commentErr as Error).message}`,
      );
    }

    if (branchName) {
      await cleanupBranch(branchName);
    }
  } finally {
    // Always return to base branch
    try {
      await returnToBaseBranch();
    } catch {
      log("warn", "Could not return to base branch");
    }
  }
}

/**
 * Handle case where Claude needs more input.
 */
async function handleNeedsInput(
  task: ClickUpTask,
  result: ClaudeResult,
  branchName: string,
): Promise<void> {
  const reason = extractNeedsInputReason(result.output);

  log("info", `Task ${task.id} requires more input: ${reason}`);

  await addTaskComment(
    task.id,
    `🔍 Automation needs more information to complete this task:\n\n${reason}\n\n` +
      `Please add the requested details and move this task back to "${STATUS.TODO}" to retry.`,
  );
  await updateTaskStatus(task.id, STATUS.REQUIRE_INPUT);

  // Clean up the branch since no work was done
  await cleanupBranch(branchName);
}

/**
 * Handle case where Claude encountered an error.
 */
async function handleError(
  task: ClickUpTask,
  result: ClaudeResult,
  branchName: string,
): Promise<void> {
  const errorMsg = result.error || "Unknown error";

  log("error", `Task ${task.id} failed: ${errorMsg}`);

  // Check if there were partial changes
  const changed = await hasChanges();

  if (changed) {
    // There are partial changes - commit them to a branch for review
    try {
      await commitChanges(
        `[CU-${task.id}] WIP: ${task.name} (partial - automation error)`,
      );
      await pushBranch(branchName);
      await addTaskComment(
        task.id,
        `⚠️ Automation encountered an error but made partial changes.\n\n` +
          `Error: \`${errorMsg}\`\n\n` +
          `Partial changes have been pushed to branch \`${branchName}\` for manual review.\n` +
          `Please complete the work manually or provide more details and retry.`,
      );
    } catch (pushErr) {
      log(
        "error",
        `Failed to push partial changes: ${(pushErr as Error).message}`,
      );
      await cleanupBranch(branchName);
    }
  } else {
    await cleanupBranch(branchName);
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
 * Process an approved task: find its PR and merge it.
 */
async function processApprovedTask(task: ClickUpTask): Promise<void> {
  const taskId = task.id;
  const taskName = task.name;

  log("info", `\n${"=".repeat(60)}`);
  log("info", `Merging approved task: ${taskName} (${taskId})`);
  log("info", `${"=".repeat(60)}\n`);

  try {
    // Find the PR URL from the task's comments
    const prUrl = await findPRUrlInComments(taskId);

    if (!prUrl) {
      log("warn", `No PR URL found in comments for task ${taskId}`);
      await addTaskComment(
        taskId,
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
        `✅ PR was already merged: ${prUrl}\n\nMoving task to completed.`,
      );
      await updateTaskStatus(taskId, STATUS.COMPLETED);
      return;
    }

    if (prState !== "open") {
      log("warn", `PR is ${prState} for task ${taskId}: ${prUrl}`);
      await addTaskComment(
        taskId,
        `⚠️ The associated PR is "${prState}" (expected "open"):\n${prUrl}\n\n` +
          `Cannot merge a ${prState} PR. Please investigate.`,
      );
      await updateTaskStatus(taskId, STATUS.BLOCKED);
      return;
    }

    // Merge the PR
    await mergePullRequest(prUrl);

    // Move task to completed
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
      await addTaskComment(
        taskId,
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
