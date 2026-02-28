// CI failure diagnostics — surfaces GitHub Actions failures into ClickUp comments.
// Provides structured failure summaries with workflow/job/step details,
// deduplication to avoid comment spam, and branch-to-task mapping.

import { BRANCH_PREFIX, DRY_RUN } from "./config.js";
import { log } from "./logger.js";
import {
  getPRHeadBranch,
  getPRNumber,
  getFailedWorkflowRuns,
  getWorkflowRunJobs,
} from "./git-ops.js";
import {
  addTaskComment,
  getTaskComments,
  getCommentText,
} from "./clickup-api.js";

/** Marker prefix for CI failure comments (used for deduplication). */
const CI_FAILURE_COMMENT_MARKER = "🔴 CI failed for PR";

/** Structured CI failure details for a pull request. */
export interface CIFailureInfo {
  prNumber: number;
  prUrl: string;
  workflowName: string;
  runUrl: string;
  failingJobs: Array<{
    name: string;
    conclusion: string;
    failingSteps: string[];
  }>;
}

/**
 * Extract a ClickUp task ID from a Clawup-managed branch name.
 * Branch format: {prefix}/CU-{taskId}-{slug}
 */
export function extractTaskIdFromBranch(branchName: string): string | null {
  const pattern = new RegExp(`^${BRANCH_PREFIX}/CU-([a-zA-Z0-9]+)-`);
  const match = branchName.match(pattern);
  return match ? match[1]! : null;
}

/**
 * Check if a branch is managed by Clawup.
 */
export function isClawupBranch(branchName: string): boolean {
  return branchName.startsWith(`${BRANCH_PREFIX}/CU-`);
}

/**
 * Get detailed CI failure information for a pull request.
 * Fetches the most recent failed workflow run and its failing jobs/steps.
 * Returns null if no failures are found or details cannot be retrieved.
 */
export async function getCIFailureDetails(prUrl: string): Promise<CIFailureInfo | null> {
  try {
    const [branchName, prNumber] = await Promise.all([
      getPRHeadBranch(prUrl),
      getPRNumber(prUrl),
    ]);
    if (!branchName || !prNumber) return null;

    // Get the most recent failed workflow run for this branch
    const failedRuns = await getFailedWorkflowRuns(branchName, 1);
    if (failedRuns.length === 0) return null;

    const run = failedRuns[0]!;

    // Get detailed job information for the failed run
    const jobs = await getWorkflowRunJobs(run.databaseId);
    const failingJobs = jobs.map((j) => ({
      name: j.name,
      conclusion: j.conclusion,
      failingSteps: j.steps
        .filter((s) => s.conclusion === "failure")
        .map((s) => s.name),
    }));

    return {
      prNumber,
      prUrl,
      workflowName: run.name,
      runUrl: run.url,
      failingJobs,
    };
  } catch (err) {
    log("warn", `Could not retrieve CI failure details: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Format a structured CI failure comment for posting to ClickUp.
 * Includes PR link, workflow/job/step details, and troubleshooting pointers.
 */
export function formatCIFailureComment(details: CIFailureInfo): string {
  const lines: string[] = [];

  lines.push(`${CI_FAILURE_COMMENT_MARKER} #${details.prNumber}\n`);
  lines.push(`PR: ${details.prUrl}`);
  lines.push(`Workflow: ${details.workflowName}`);
  lines.push(`Run: ${details.runUrl}\n`);

  if (details.failingJobs.length > 0) {
    lines.push("Failing jobs:");
    for (const job of details.failingJobs) {
      lines.push(`  - ${job.name}`);
      for (const step of job.failingSteps) {
        lines.push(`    - Step: ${step}`);
      }
    }
    lines.push("");
  }

  lines.push("See TROUBLESHOOTING.md for common CI failure recovery steps.");

  return lines.join("\n");
}

/**
 * Check if a CI failure comment for a specific workflow run already exists
 * on the ClickUp task. Prevents duplicate comments for the same failure.
 */
async function isDuplicateCIComment(taskId: string, runUrl: string): Promise<boolean> {
  try {
    const comments = await getTaskComments(taskId);
    for (const comment of comments) {
      const text = getCommentText(comment);
      if (text.includes(CI_FAILURE_COMMENT_MARKER) && text.includes(runUrl)) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // If we can't check, allow the comment
  }
}

/**
 * Post CI failure diagnostics as a comment on the associated ClickUp task.
 * Automatically retrieves detailed failure info and deduplicates comments.
 * Returns true if a comment was posted, false if skipped (no failures, duplicate, or dry run).
 */
export async function postCIFailureDiagnostics(
  taskId: string,
  prUrl: string,
): Promise<boolean> {
  if (DRY_RUN) {
    log("info", `[DRY RUN] Would post CI failure diagnostics to task ${taskId}`);
    return false;
  }

  const details = await getCIFailureDetails(prUrl);
  if (!details) {
    log("debug", `No detailed CI failure info available for task ${taskId}`);
    return false;
  }

  // Check for duplicate comment
  if (await isDuplicateCIComment(taskId, details.runUrl)) {
    log("debug", `CI failure comment already exists for run ${details.runUrl} on task ${taskId}`);
    return false;
  }

  const comment = formatCIFailureComment(details);
  await addTaskComment(taskId, comment);
  log("info", `Posted CI failure diagnostics to task ${taskId}`, { taskId });
  return true;
}
