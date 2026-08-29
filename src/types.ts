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
  parentTaskName: string;
  parentTaskUrl: string;
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

export interface StackRunSummary {
  total: number;
  completed: number;
  skipped: number;
  aborted: boolean;
}
