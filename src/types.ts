export interface ClickUpUser {
  id: number;
  username?: string;
  email?: string;
}

export interface ClickUpTask {
  id: string;
  name: string;
  url: string;
  description?: string;
  text_content?: string;
  date_created?: string;
  creator?: ClickUpUser;
  priority?: { id: string; priority: string };
  tags?: { name: string }[];
  checklists?: ClickUpChecklist[];
  subtasks?: ClickUpTask[];
  status?: { status: string };
  list?: { id: string };
  dependencies?: ClickUpDependency[];
  parent?: string | null;
  orderindex?: string;
}

export interface ClickUpChecklist {
  name: string;
  items?: ClickUpChecklistItem[];
}

export interface ClickUpChecklistItem {
  name: string;
  resolved: boolean;
}

export interface ClickUpList {
  id: string;
  name: string;
  task_count: number;
  statuses: ClickUpStatus[];
}

export interface ClickUpStatus {
  status: string;
  color: string;
  type: string;
}

export interface ClickUpCommentBlock {
  text?: string;
  type?: string;
}

export interface ClickUpComment {
  comment_text?: string;
  comment?: ClickUpCommentBlock[];
  user?: { username?: string };
  date?: string;
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  needsInput: boolean;
  error?: string;
  rateLimited?: boolean;
  sessionId?: string;
}

export interface UserConfig {
  prompt?: string;
  claudeArgs?: string[];
}

export interface ClickUpDependency {
  task_id: string;
  depends_on: string;
  type: number;
  date_created?: string;
  userid?: string;
}

export interface PullRequestOptions {
  title: string;
  body: string;
  branchName: string;
  baseBranch?: string;
  draft?: boolean;
}

export type TaskOutcomeStatus =
  | "success"
  | "merged"
  | "needs_input"
  | "no_changes"
  | "error"
  | "dry_run";

export interface TaskOutcome {
  status: TaskOutcomeStatus;
  branchName?: string;
  prUrl?: string;
}

export interface StackInfo {
  /** What the stack was collected from: a parent task's subtasks or a full list. */
  sourceKind: "task" | "list";
  sourceName: string;
  /** ClickUp URL of the source; lists have no directly-addressable URL. */
  sourceUrl?: string;
  position: number;
  total: number;
  baseBranch: string;
  previousPrUrl?: string;
  completedInSeries: Array<{ name: string; branchName: string; prUrl?: string }>;
}

export interface StackContext {
  promptContext: string;
  prNote: string;
}

/**
 * What is known about an existing task branch when deciding whether a stack
 * run can build the next PR on top of it.
 */
export interface StackBaseFacts {
  /** State of the branch's most recent PR ("open" | "merged" | "closed"), or null when it has none. */
  prState: string | null;
  /** The branch exists on origin (a PR can only target a remote branch). */
  pushed: boolean;
  /** The branch is already an ancestor of the current stack base — its work is in the chain. */
  containedInBase: boolean;
  /** The branch descends from the current stack base (always true when the base is BASE_BRANCH). */
  onStack: boolean;
}

/**
 * Whether an existing branch can serve as the next stack base, and if not, why.
 * - merged: its PR has merged, so its work already lives in the chain's base
 * - contained: its commits are already in the current base
 * - unpushed: it exists only locally, so GitHub cannot target it
 * - off-stack: it does not contain the current base's work
 */
export type StackBaseVerdict =
  | { usable: true }
  | { usable: false; reason: "merged" | "contained" | "unpushed" | "off-stack" };

export interface StackRunSummary {
  total: number;
  completed: number;
  skipped: number;
  aborted: boolean;
}

/**
 * Planned native-stack operation for a bottom-up series of chained PRs,
 * given each PR's current stack membership.
 */
export type StackLinkPlan =
  | { action: "create"; prNumbers: number[] }
  | { action: "extend"; stackNumber: number; prNumbers: number[] }
  | { action: "already-linked"; stackNumber: number; prNumbers: number[] }
  | { action: "skip"; reason: string };

/**
 * Outcome of linking a stack run's open PRs into a native GitHub stack
 * through the `gh stack` extension. "created" carries a null stackNumber
 * when the new stack's number could not be read back afterwards
 * (`gh stack link` itself does not report it). "unavailable" means
 * stacked pull requests are not enabled for the repository (the feature
 * is in public preview) — the chained PRs still work, they just need
 * manual bottom-up merging.
 */
export type StackLinkResult =
  | { outcome: "created"; stackNumber: number | null; prNumbers: number[] }
  | {
      outcome: "extended" | "already-linked";
      stackNumber: number;
      prNumbers: number[];
    }
  | { outcome: "skipped"; reason: string }
  | { outcome: "unavailable"; reason: string }
  | { outcome: "failed"; reason: string };
