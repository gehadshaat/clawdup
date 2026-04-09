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

// --- External Tool Provider Types ---

/** Result from an external tool execution. */
export interface ExternalToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** Provider name that produced this result (e.g., "gemini"). */
  provider: string;
  /** Optional metadata (model used, cost, etc.). */
  metadata?: Record<string, unknown>;
}

/** Configuration for an external tool provider. */
export interface ExternalToolProviderConfig {
  /** Provider name (e.g., "gemini", "openai"). */
  name: string;
  /** API key for the provider. */
  apiKey: string;
  /** Model to use (provider-specific). */
  model?: string;
  /** Whether this provider is enabled. */
  enabled: boolean;
}

/** A request from Claude to invoke an external tool. */
export interface ExternalToolRequest {
  /** Which provider to use (e.g., "gemini"). */
  provider: string;
  /** The capability needed (e.g., "image_generation", "vision", "web_search"). */
  capability: string;
  /** The prompt/instruction for the external tool. */
  prompt: string;
  /** Optional parameters specific to the capability. */
  params?: Record<string, unknown>;
}

/** Capabilities that external tools can provide. */
export type ExternalToolCapability =
  | "image_generation"
  | "vision"
  | "web_search"
  | "code_execution"
  | "general";
