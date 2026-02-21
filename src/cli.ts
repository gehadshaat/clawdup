// clawup CLI
// Usage:
//   clawup              Start continuous polling
//   clawup --once <id>  Process a single task by ID
//   clawup --check      Validate config and exit
//   clawup --statuses   Show recommended ClickUp statuses
//   clawup --setup      Interactive setup wizard
//   clawup --init       Create example config files in current directory

import { resolve } from "path";
import { existsSync, writeFileSync } from "fs";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  // --init and --statuses don't need config loaded
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.includes("--statuses")) {
    printRecommendedStatuses();
    process.exit(0);
  }

  if (args.includes("--init")) {
    await initProject();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    process.exit(0);
  }

  // Everything below requires config to be loaded
  const { startRunner, runSingleTask } = await import("./runner.js");
  const { validateStatuses, getListInfo, getEffectiveListId } = await import(
    "./clickup-api.js"
  );
  const { detectGitHubRepo } = await import("./git-ops.js");
  const { CLICKUP_PARENT_TASK_ID } = await import("./config.js");

  if (args.includes("--check")) {
    await runChecks({
      validateStatuses,
      getListInfo,
      detectGitHubRepo,
      parentTaskId: CLICKUP_PARENT_TASK_ID,
    });
    process.exit(0);
  }

  if (args.includes("--once")) {
    const taskIdIndex = args.indexOf("--once") + 1;
    const taskId = args[taskIdIndex];
    if (!taskId) {
      console.error("Error: --once requires a task ID argument");
      console.error("Usage: clawup --once <task-id>");
      process.exit(1);
    }
    await runSingleTask(taskId);
    process.exit(0);
  }

  // Default: start the continuous polling runner
  await startRunner();
}

function printUsage(): void {
  console.log(`
clawup
===================

Continuously polls a ClickUp list for tasks, uses Claude Code to implement
them, creates GitHub PRs, and updates task statuses.

Usage:
  clawup                     Start continuous polling
  clawup --once <task-id>    Process a single task
  clawup --check             Validate configuration
  clawup --statuses          Show recommended ClickUp statuses
  clawup --setup             Interactive setup wizard
  clawup --init              Create config files in current directory
  clawup --help              Show this help

Configuration:
  Create a .clawup.env file in your project root with:
    CLICKUP_API_TOKEN=pk_xxx
    CLICKUP_LIST_ID=xxx          (poll an entire list)
    -- OR --
    CLICKUP_PARENT_TASK_ID=xxx   (poll subtasks of a parent task)

  Optionally create clawup.config.mjs for custom Claude prompts.
  Run --init to generate example config files.

Flow:
  1. Polls ClickUp list (or parent task subtasks) for tasks with "to do" status
  2. Picks highest-priority task
  3. Creates a git branch: clickup/CU-{task-id}-{slug} (auto-links to ClickUp)
  4. Runs Claude Code to implement the task (reads your CLAUDE.md for context)
  5. If successful: commits, pushes, creates PR, moves to "in review"
  6. If approved: merges the PR, moves to "complete"
  7. If needs input: comments on task, moves to "require input"
  8. If error: comments on task, moves to "blocked"
  9. Repeats

Signals:
  SIGINT/SIGTERM: Graceful shutdown (finishes current task, then exits)
`);
}

function printRecommendedStatuses(): void {
  console.log(`
Recommended ClickUp List Statuses
===================================

Set up these statuses in your ClickUp list for the automation to work:

  Status           Type       Color     Description
  ─────────────    ─────      ──────    ───────────────────────────────────────
  to do            open       #d3d3d3   Task is ready to be picked up
  in progress      active     #4194f6   Automation is currently working on it
  in review        active     #a875ff   PR created, awaiting human review
  approved         active     #2ecd6f   Approved — automation will merge the PR
  require input    active     #f9d900   Task needs clarification (comment added)
  blocked          active     #f44336   Automation hit an error
  complete         closed     #6bc950   Task is done (PR merged)

How to set up:
  1. Open your ClickUp list
  2. Click the "..." menu > "List Settings" > "Statuses"
  3. Add/rename statuses to match the above
  4. The names must match exactly (case-insensitive)

Status names can be customized via environment variables (STATUS_TODO, etc).
`);
}

async function initProject(): Promise<void> {
  const cwd = process.cwd();
  const envDest = resolve(cwd, ".clawup.env");
  const configDest = resolve(cwd, "clawup.config.mjs");

  console.log("Initializing clawup in current directory...\n");

  if (existsSync(envDest)) {
    console.log(`  SKIP  ${envDest} (already exists)`);
  } else {
    writeFileSync(
      envDest,
      `# ClickUp Task Automation - Environment Variables
# Docs: https://github.com/your-org/clawup

# === REQUIRED ===

# ClickUp API token (get from: ClickUp Settings > Apps > API Token)
CLICKUP_API_TOKEN=pk_xxx

# ClickUp List ID (from the list URL in ClickUp)
# Use EITHER CLICKUP_LIST_ID or CLICKUP_PARENT_TASK_ID (not both)
CLICKUP_LIST_ID=

# OR: ClickUp Parent Task ID (polls subtasks of this task instead of a whole list)
# CLICKUP_PARENT_TASK_ID=

# === OPTIONAL ===

# GitHub repo in "owner/repo" format (auto-detected from git remote if empty)
# GITHUB_REPO=your-org/your-repo

# Base branch to create feature branches from
# BASE_BRANCH=main

# ClickUp status names (must match your list's statuses, case-insensitive)
# STATUS_TODO=to do
# STATUS_IN_PROGRESS=in progress
# STATUS_IN_REVIEW=in review
# STATUS_APPROVED=approved
# STATUS_REQUIRE_INPUT=require input
# STATUS_COMPLETED=complete
# STATUS_BLOCKED=blocked

# How often to poll ClickUp for new tasks (milliseconds)
# POLL_INTERVAL_MS=30000

# Claude Code CLI command name
# CLAUDE_COMMAND=claude

# Timeout for Claude Code per task (milliseconds)
# CLAUDE_TIMEOUT_MS=600000

# Max agentic turns for Claude Code per task
# CLAUDE_MAX_TURNS=50

# Git branch prefix
# BRANCH_PREFIX=clickup

# Log level: debug | info | warn | error
# LOG_LEVEL=info
`,
    );
    console.log(`  CREATE  ${envDest}`);
  }

  if (existsSync(configDest)) {
    console.log(`  SKIP  ${configDest} (already exists)`);
  } else {
    writeFileSync(
      configDest,
      `// clawup.config.mjs
// Optional configuration for customizing Claude Code behavior.
// This file is loaded automatically when clawup runs.

export default {
  // Additional instructions appended to the Claude system prompt.
  // Use this for project-specific coding standards, formatting rules, etc.
  // Your CLAUDE.md is already loaded automatically — this is for extra context.
  prompt: \`
Run the formatter/linter after making changes to ensure code style is correct.
\`.trim(),

  // Extra CLI args to pass to the 'claude' command.
  // claudeArgs: ["--allowedTools", "Bash,Read,Write,Edit,Glob,Grep"],
};
`,
    );
    console.log(`  CREATE  ${configDest}`);
  }

  console.log(`
Done! Next steps:
  1. Edit .clawup.env with your ClickUp API token and list ID
  2. Optionally customize clawup.config.mjs
  3. Add .clawup.env to your .gitignore
  4. Run: clawup --check
  5. Run: clawup
`);
}

interface CheckDeps {
  validateStatuses: () => Promise<boolean>;
  getListInfo: () => Promise<{
    name: string;
    id: string;
    task_count: number;
    statuses: { status: string }[];
  }>;
  detectGitHubRepo: () => Promise<string>;
  parentTaskId: string;
}

async function runChecks({
  validateStatuses,
  getListInfo,
  detectGitHubRepo,
  parentTaskId,
}: CheckDeps): Promise<void> {
  console.log("Running configuration checks...\n");
  let allGood = true;

  // Show mode
  if (parentTaskId) {
    console.log(`  Mode: Parent task (${parentTaskId})`);
  } else {
    console.log("  Mode: List");
  }

  // Check ClickUp API
  try {
    const listInfo = await getListInfo();
    console.log(`  ClickUp List: "${listInfo.name}" (${listInfo.id})`);
    console.log(`  Task count: ${listInfo.task_count}`);
    console.log(
      `  Statuses: ${listInfo.statuses.map((s) => s.status).join(", ")}`,
    );
  } catch (err) {
    console.error(`  ClickUp API: FAILED - ${(err as Error).message}`);
    allGood = false;
  }

  // Validate statuses
  try {
    const valid = await validateStatuses();
    if (!valid) allGood = false;
  } catch (err) {
    console.error(`  Status validation: FAILED - ${(err as Error).message}`);
    allGood = false;
  }

  // Check GitHub
  try {
    const repo = await detectGitHubRepo();
    console.log(`  GitHub repo: ${repo}`);
  } catch (err) {
    console.error(`  GitHub: FAILED - ${(err as Error).message}`);
    allGood = false;
  }

  // Check Claude CLI
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 5000,
    });
    console.log(`  Claude Code: ${stdout.trim()}`);
  } catch {
    console.error(
      '  Claude Code: FAILED - "claude" command not found or not working',
    );
    allGood = false;
  }

  // Check gh CLI
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("gh", ["--version"], {
      timeout: 5000,
    });
    console.log(`  GitHub CLI: ${stdout.trim().split("\n")[0]}`);
  } catch {
    console.error('  GitHub CLI: FAILED - "gh" command not found');
    allGood = false;
  }

  // Check for CLAUDE.md
  const claudeMd = resolve(process.cwd(), "CLAUDE.md");
  if (existsSync(claudeMd)) {
    console.log("  CLAUDE.md: found (will be used for project context)");
  } else {
    console.log(
      "  CLAUDE.md: not found (optional — add one for better task context)",
    );
  }

  // Check for config file
  const configFile = resolve(process.cwd(), "clawup.config.mjs");
  if (existsSync(configFile)) {
    console.log("  Config file: found");
  } else {
    console.log("  Config file: not found (optional)");
  }

  console.log("");
  if (allGood) {
    console.log("All checks passed! Ready to run.");
  } else {
    console.log("Some checks failed. Please fix the issues above.");
    process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
