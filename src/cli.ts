// clawdup CLI
// Usage:
//   clawdup              Start continuous polling
//   clawdup --once <id>  Process a single task by ID
//   clawdup --interactive  Run Claude in interactive mode (accepts user input)
//   clawdup --check      Validate config and exit
//   clawdup --doctor     Run preflight environment health checks
//   clawdup --statuses   Show recommended ClickUp statuses
//   clawdup --setup      Interactive setup wizard
//   clawdup --init       Create example config files in current directory

import { resolve } from "path";
import { existsSync, writeFileSync } from "fs";

const args = process.argv.slice(2);

// Set debug/json-log mode before any module imports so logger picks them up
if (args.includes("--debug")) {
  process.env.LOG_LEVEL = "debug";
}
if (args.includes("--json-log")) {
  process.env.LOG_FORMAT = "json";
}
if (args.includes("--dry-run")) {
  process.env.DRY_RUN = "true";
}

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

  if (args.includes("--doctor")) {
    const { runPreflightChecks, printPreflightResults } = await import("./preflight.js");
    const result = await runPreflightChecks();
    printPreflightResults(result);
    process.exit(result.passed ? 0 : 1);
  }

  // Everything below requires config to be loaded
  const { startRunner, runSingleTask } = await import("./runner.js");
  const { validateStatuses, getListInfo, getTask } = await import("./clickup-api.js");
  const { detectGitHubRepo } = await import("./git-ops.js");
  const { CLICKUP_PARENT_TASK_ID } = await import("./config.js");

  if (args.includes("--check")) {
    await runChecks({ validateStatuses, getListInfo, getTask, detectGitHubRepo, parentTaskId: CLICKUP_PARENT_TASK_ID });
    process.exit(0);
  }

  const interactive = args.includes("--interactive");

  if (args.includes("--once")) {
    const taskIdIndex = args.indexOf("--once") + 1;
    const taskId = args[taskIdIndex];
    if (!taskId) {
      console.error("Error: --once requires a task ID argument");
      console.error("Usage: clawdup --once <task-id>");
      process.exit(1);
    }
    await runSingleTask(taskId, { interactive });
    process.exit(0);
  }

  // Default: start the continuous polling runner with periodic relaunch.
  // When relaunch is requested, rebuild TypeScript so the restarted process
  // loads the latest compiled code (ESM module cache is per-process).
  const shouldRelaunch = await startRunner({ interactive });
  if (shouldRelaunch) {
    await rebuildBeforeRelaunch();
    // Exit with special code 75 to signal the bin wrapper to restart
    process.exit(75);
  }
}

function printUsage(): void {
  console.log(`
clawdup
===================

Continuously polls a ClickUp list for tasks, uses Claude Code to implement
them, creates GitHub PRs, and updates task statuses.

Usage:
  clawdup                     Start continuous polling
  clawdup --once <task-id>    Process a single task
  clawdup --interactive       Run Claude in interactive mode (accepts user input)
  clawdup --dry-run           Simulate the full flow without making any changes
  clawdup --debug             Enable debug-level logging with timing
  clawdup --json-log          Output logs in JSON format
  clawdup --check             Validate configuration
  clawdup --doctor            Run preflight environment health checks
  clawdup --statuses          Show recommended ClickUp statuses
  clawdup --setup             Interactive setup wizard
  clawdup --init              Create config files in current directory
  clawdup --help              Show this help

Configuration:
  Create a .clawdup.env file in your project root with:
    CLICKUP_API_TOKEN=pk_xxx
    CLICKUP_LIST_ID=xxx          # Poll tasks from a list
    # OR
    CLICKUP_PARENT_TASK_ID=xxx   # Poll subtasks of a parent task
    AUTO_APPROVE=true            # Auto-merge PRs without manual review

  Optionally create clawdup.config.mjs for custom Claude prompts.
  Run --init to generate example config files.

Debugging:
  Use --debug or set LOG_LEVEL=debug to enable verbose logging with
  timing information for each major step. You can also set DEBUG=1.
  Use --json-log or set LOG_FORMAT=json for machine-parseable JSON logs.
  Logs are written to stdout (info/debug) and stderr (warn/error).

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

  With AUTO_APPROVE=true, step 5 merges the PR immediately (skipping manual review).

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
  const envDest = resolve(cwd, ".clawdup.env");
  const configDest = resolve(cwd, "clawdup.config.mjs");

  console.log("Initializing clawdup in current directory...\n");

  if (existsSync(envDest)) {
    console.log(`  SKIP  ${envDest} (already exists)`);
  } else {
    writeFileSync(
      envDest,
      `# ClickUp Task Automation - Environment Variables
# Docs: https://github.com/your-org/clawdup

# === REQUIRED ===

# ClickUp API token (get from: ClickUp Settings > Apps > API Token)
CLICKUP_API_TOKEN=pk_xxx

# ClickUp List ID (from the list URL in ClickUp)
# Set EITHER CLICKUP_LIST_ID or CLICKUP_PARENT_TASK_ID (not both)
CLICKUP_LIST_ID=

# OR: ClickUp Parent Task ID (polls subtasks of this task instead of a list)
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

# Auto-approve mode: merge PRs immediately after Claude completes (skip manual review)
# AUTO_APPROVE=true

# Log level: debug | info | warn | error
# LOG_LEVEL=info

# Log output format: text (default) or json
# LOG_FORMAT=json
`,
    );
    console.log(`  CREATE  ${envDest}`);
  }

  if (existsSync(configDest)) {
    console.log(`  SKIP  ${configDest} (already exists)`);
  } else {
    writeFileSync(
      configDest,
      `// clawdup.config.mjs
// Optional configuration for customizing Claude Code behavior.
// This file is loaded automatically when clawdup runs.

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
  1. Edit .clawdup.env with your ClickUp API token and list ID
  2. Optionally customize clawdup.config.mjs
  3. Add .clawdup.env to your .gitignore
  4. Run: clawdup --check
  5. Run: clawdup
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
  getTask: (taskId: string) => Promise<{
    id: string;
    name: string;
    url: string;
    subtasks?: { id: string; name: string }[];
  }>;
  detectGitHubRepo: () => Promise<string>;
  parentTaskId: string;
}

async function runChecks({
  validateStatuses,
  getListInfo,
  getTask,
  detectGitHubRepo,
  parentTaskId,
}: CheckDeps): Promise<void> {
  console.log("Running configuration checks...\n");
  let allGood = true;

  // Check ClickUp API
  try {
    if (parentTaskId) {
      const task = await getTask(parentTaskId);
      console.log(`  ClickUp Parent Task: "${task.name}" (${task.id})`);
      console.log(`  URL: ${task.url}`);
      const subtaskCount = task.subtasks?.length || 0;
      console.log(`  Subtasks: ${subtaskCount}`);
      console.log(`  Mode: parent task (polling subtasks)`);
    }
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

  // Check Git CLI
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["--version"], {
      timeout: 5000,
    });
    console.log(`  Git: ${stdout.trim()}`);
  } catch {
    console.error('  Git: FAILED - "git" command not found');
    console.error('    Install: https://git-scm.com/downloads');
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
    console.error('    Install: npm install -g @anthropic-ai/claude-code');
    console.error('    Docs: https://docs.anthropic.com/en/docs/claude-code');
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
    console.error('    Install: https://cli.github.com/');
    console.error('    macOS: brew install gh');
    console.error('    Linux: sudo apt install gh (or see link above)');
    allGood = false;
  }

  // Check gh auth status
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("gh", ["auth", "status"], {
      timeout: 10000,
    });
    console.log("  GitHub CLI auth: authenticated");
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("not found") || msg.includes("ENOENT")) {
      // gh not installed — already reported above, skip duplicate
    } else {
      console.error('  GitHub CLI auth: FAILED - not authenticated');
      console.error('    Run: gh auth login');
      allGood = false;
    }
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
  const configFile = resolve(process.cwd(), "clawdup.config.mjs");
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

/**
 * Rebuild TypeScript before relaunch so the new process loads fresh code.
 * dist/ is gitignored, so after syncBaseBranch() pulls new source, the
 * compiled JS is stale until we run tsc again.
 */
async function rebuildBeforeRelaunch(): Promise<void> {
  const { execFile: execFileCb } = await import("child_process");
  const { promisify } = await import("util");
  const { dirname: dirnameFn, resolve: resolveFn } = await import("path");
  const { fileURLToPath } = await import("url");
  const { log } = await import("./logger.js");

  const execFileAsync = promisify(execFileCb);

  // Resolve clawdup's own package root from the compiled CLI location
  // (dist/cli.js -> package root)
  const clawdupRoot = resolveFn(dirnameFn(fileURLToPath(import.meta.url)), "..");

  log("info", "Rebuilding to pick up latest code changes...");
  try {
    await execFileAsync("npm", ["run", "build"], {
      cwd: clawdupRoot,
      timeout: 120000,
    });
    log("info", "Build succeeded. Relaunching...\n");
  } catch (err) {
    log("warn", `Build failed: ${(err as Error).message}. Relaunching with existing code.\n`);
  }
}

main().catch((err: Error) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
