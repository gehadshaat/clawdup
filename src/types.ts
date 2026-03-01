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
  rateLimited?: boolean;
}

export interface UserConfig {
  prompt?: string;
  claudeArgs?: string[];
  toolProfile?: ToolProfileName;
  allowedTools?: string[];
}

/**
 * Named tool profiles that control which Claude Code tools are available.
 * - minimal: Basic file editing and shell (current default, safest)
 * - standard: Adds sub-agents (Task) and web access for research-heavy tasks
 * - full: All Claude Code tools enabled
 * - custom: User-defined tool set via allowedTools in config
 */
export type ToolProfileName = "minimal" | "standard" | "full" | "custom";

/**
 * Describes a detected capability hint from project or task analysis.
 * Used to recommend tools or agents that would be useful.
 */
export interface CapabilityHint {
  tool: string;
  reason: string;
}

/**
 * Result of analyzing a project and task for needed capabilities.
 */
export interface CapabilityAnalysis {
  detectedHints: CapabilityHint[];
  recommendedTools: string[];
  recommendedProfile: ToolProfileName;
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
