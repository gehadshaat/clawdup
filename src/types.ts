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
}

export interface UserConfig {
  prompt?: string;
  claudeArgs?: string[];
}

export interface PullRequestOptions {
  title: string;
  body: string;
  branchName: string;
  baseBranch?: string;
  draft?: boolean;
}

// --- Metrics / Telemetry ---

export type RunOutcome = "success" | "partial" | "failure" | "needs_input";

export interface RunRecord {
  id: string;
  taskId: string;
  taskName: string;
  timestamp: string;
  outcome: RunOutcome;
  errorCategory?: string;
  durationMs: number;
}

export interface MetricsSummary {
  totalRuns: number;
  success: number;
  partial: number;
  failure: number;
  needsInput: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCategory: string | null;
  periodStart: string;
  periodEnd: string;
}
