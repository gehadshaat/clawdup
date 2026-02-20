export interface ClickUpTask {
  id: string;
  name: string;
  url: string;
  description?: string;
  text_content?: string;
  date_created?: string;
  priority?: { id: string; priority: string };
  tags?: { name: string }[];
  checklists?: ClickUpChecklist[];
  subtasks?: ClickUpTask[];
  status?: { status: string };
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

export interface ClickUpComment {
  comment_text?: string;
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
}
