// Programmatic API - import this to use clawdup from code.
export { startRunner, runSingleTask } from "./runner.js";
export {
  getTasksByStatus,
  getTask,
  updateTaskStatus,
  addTaskComment,
  addTaskCommentForUser,
  notifyTaskCreator,
  getTaskComments,
  findPRUrlInComments,
  getNewReviewFeedback,
  getCommentText,
  formatTaskForClaude,
  slugify,
  isValidTaskId,
  detectInjectionPatterns,
  getListInfo,
  validateStatuses,
} from "./clickup-api.js";
export {
  detectGitHubRepo,
  createTaskBranch,
  commitChanges,
  pushBranch,
  createPullRequest,
  createEmptyCommit,
  markPRReady,
  closePullRequest,
  updatePullRequest,
  findExistingPR,
  mergePullRequest,
  getPRState,
  getPRReviewDecision,
  getPRReviewComments,
  getPRInlineComments,
} from "./git-ops.js";
export { runClaudeOnTask, runClaudeOnReviewFeedback, generateWorkSummary, scanOutputForSafetyIssues } from "./claude-worker.js";
export { STATUS, PROJECT_ROOT, GIT_ROOT, DRY_RUN } from "./config.js";
export { log, setLogLevel, setJsonOutput, isDebug, startTimer } from "./logger.js";
export type { LogLevel, LogContext } from "./logger.js";
export { recordRun, getMetricsSummary, getRunRecords, formatMetricsSummary } from "./metrics.js";
export type {
  ClickUpTask,
  ClickUpUser,
  ClickUpList,
  ClickUpComment,
  ClickUpCommentBlock,
  ClaudeResult,
  UserConfig,
  PullRequestOptions,
  RunOutcome,
  RunRecord,
  MetricsSummary,
} from "./types.js";
