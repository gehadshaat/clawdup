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
  getTaskDependencies,
  getUnresolvedDependencies,
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
  getPRCheckStatus,
} from "./git-ops.js";
export { runClaudeOnTask, runClaudeOnReviewFeedback, generateWorkSummary, scanOutputForSafetyIssues } from "./claude-worker.js";
export { runPreflightChecks, runPreflightOrAbort, printPreflightResults } from "./preflight.js";
export { STATUS, PROJECT_ROOT, GIT_ROOT, DRY_RUN, EXTERNAL_TOOLS_ENABLED, EXTERNAL_TOOL_PROVIDERS } from "./config.js";
export {
  hasExternalTools,
  getAvailableToolsSummary,
  processToolRequests,
  detectExternalToolNeeds,
} from "./external-tools.js";
export { log, setLogLevel, setJsonOutput, isDebug, startTimer } from "./logger.js";
export type { LogLevel, LogContext } from "./logger.js";
export type {
  ClickUpTask,
  ClickUpUser,
  ClickUpList,
  ClickUpComment,
  ClickUpCommentBlock,
  ClickUpDependency,
  ClaudeResult,
  UserConfig,
  PullRequestOptions,
  ExternalToolResult,
  ExternalToolRequest,
  ExternalToolProviderConfig,
  ExternalToolCapability,
} from "./types.js";
export type { PreflightCheckResult, PreflightResult } from "./preflight.js";
export { detectPackageManager, globalInstallCommand, installCommand, runScriptCommand, initCommand } from "./package-manager.js";
export type { PackageManager } from "./package-manager.js";
