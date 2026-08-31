// clawdup CLI
// Usage:
//   clawdup              Start continuous polling
//   clawdup --once <id>  Process a single task by ID
//   clawdup --stack <id> Implement all leaf subtasks of a task as sequential stacked PRs
//   clawdup --stack      Same, for the full configured source (list or parent task)
//   clawdup --interactive  Run Claude in interactive mode (accepts user input)
//   clawdup --check      Validate config and exit
//   clawdup --doctor     Run preflight environment health checks
//   clawdup --statuses   Show recommended ClickUp statuses
//   clawdup --setup      Interactive setup wizard
//   clawdup --init       Create example config files at the repo root
//
// clawdup is installed globally (npm install -g clawdup) and configured
// per-repository via an untracked .env.local at the repo root.

import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { detectPackageManager, globalInstallCommand } from "./package-manager.js";
import { detectRepoRoot, ensureGitignoreEntries } from "./repo-root.js";
import { hasClawdupConfig } from "./env-file.js";

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

  if (args.includes("--upgrade")) {
    await upgradeClawdup();
    process.exit(0);
  }

  if (args.includes("--doctor")) {
    const { runPreflightChecks, printPreflightResults } = await import("./preflight.js");
    const result = await runPreflightChecks();
    printPreflightResults(result);
    process.exit(result.passed ? 0 : 1);
  }

  // Everything below requires config to be loaded
  const { startRunner, runSingleTask, runTaskStack } = await import("./runner.js");
  const { validateStatuses, getListInfo, getTask } = await import("./clickup-api.js");
  const { detectGitHubRepo } = await import("./git-ops.js");
  const { CLICKUP_PARENT_TASK_ID } = await import("./config.js");

  if (args.includes("--check")) {
    await runChecks({ validateStatuses, getListInfo, getTask, detectGitHubRepo, parentTaskId: CLICKUP_PARENT_TASK_ID });
    process.exit(0);
  }

  const interactive = args.includes("--interactive");

  if (args.includes("--once") && args.includes("--stack")) {
    console.error("Error: --once and --stack cannot be used together");
    process.exit(1);
  }

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

  if (args.includes("--stack")) {
    // With a task ID, stack that task's leaf subtasks. Without one, stack
    // the full configured source (the list, or the configured parent task).
    const next = args[args.indexOf("--stack") + 1];
    const taskId = next && !next.startsWith("--") ? next : undefined;
    const summary = await runTaskStack(taskId, { interactive });
    process.exit(summary.aborted ? 1 : 0);
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
  const pm = detectPackageManager(process.cwd());
  console.log(`
clawdup
===================

Continuously polls a ClickUp list for tasks, uses Claude Code to implement
them, creates GitHub PRs, and updates task statuses.

Usage:
  clawdup                     Start continuous polling
  clawdup --once <task-id>    Process a single task
  clawdup --stack <task-id>   Implement all leaf subtasks of a task, one at a
                              time, as stacked PRs (each branch/PR based on
                              the previous one; dependencies decide the order)
  clawdup --stack             Same, but for the full configured source: every
                              open task in the list (or every subtask of the
                              configured parent task)
  clawdup --interactive       Run Claude in interactive mode (accepts user input)
  clawdup --dry-run           Simulate the full flow without making any changes
  clawdup --debug             Enable debug-level logging with timing
  clawdup --json-log          Output logs in JSON format
  clawdup --upgrade           Upgrade clawdup to the latest version
  clawdup --check             Validate configuration
  clawdup --doctor            Run preflight environment health checks
  clawdup --statuses          Show recommended ClickUp statuses
  clawdup --setup             Interactive setup wizard
  clawdup --init              Create config files at the repo root
  clawdup --help              Show this help

Quick Start:
  ${globalInstallCommand(pm, "clawdup")}     Install once, globally
  clawdup --setup                Interactive setup (writes .env.local at the
                                 repo root and gitignores it)
  clawdup --init                 Non-interactive: create example config files
  clawdup                        Run from anywhere inside the repo

Configuration:
  clawdup is configured per-repository via a .env.local file at the repo
  root. The file holds secrets and is never committed (--setup / --init add
  it to .gitignore automatically):
    CLICKUP_API_TOKEN=pk_xxx
    CLICKUP_LIST_ID=xxx          # Poll tasks from a list
    # OR
    CLICKUP_PARENT_TASK_ID=xxx   # Poll subtasks of a parent task
    AUTO_APPROVE=true            # Auto-merge PRs without manual review

  Optionally create clawdup.config.mjs (also at the repo root) for custom
  Claude prompts. Run --init to generate example config files.

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

Stack mode (--stack [task-id]):
  Collects all leaf subtasks of the given task (nested subtasks are traversed;
  subtasks with children are treated as grouping only), orders them by their
  ClickUp dependencies, and implements them strictly one after another:
  the first branch is created from the base branch, each next branch from the
  previous one, and each PR targets its branch's base (base > b1 (PR1) > b2 (PR2)).
  Merge the PRs bottom-up. AUTO_APPROVE is ignored in this mode. If a task
  fails, the remaining ones are not attempted — re-run --stack to resume.

  Without a task ID, the full configured source is stacked the same way:
  every open task in CLICKUP_LIST_ID (tasks with subtasks contribute their
  leaf subtasks instead), or the subtasks of CLICKUP_PARENT_TASK_ID when
  that is configured.

  The series' open PRs are linked into a native GitHub stack via the gh
  stack extension (gh extension install github/gh-stack). The extension is
  required: when it's missing, --stack offers to install it on an
  interactive terminal and aborts otherwise. Set NATIVE_STACKS=false to
  skip native linking (plain chained PRs — no extension needed).

Signals:
  SIGINT/SIGTERM: Graceful shutdown (finishes current task, then exits)
`);
}

function printRecommendedStatuses(): void {
  console.log(`
Recommended ClickUp List Statuses
===================================

Full recommended setup (finest-grained workflow):

  Status           Type       Color     Description
  ─────────────    ─────      ──────    ───────────────────────────────────────
  to do            open       #d3d3d3   Task is ready to be picked up
  in progress      active     #4194f6   Automation is currently working on it
  in review        active     #a875ff   PR created, awaiting human review
  approved         active     #2ecd6f   Approved — automation will merge the PR
  require input    active     #f9d900   Task needs clarification (comment added)
  blocked          active     #f44336   Automation hit an error
  complete         closed     #6bc950   Task is done (PR merged)

Only three statuses are REQUIRED — a minimal default ClickUp list works too:

  to do, in progress, and a done/closed status (e.g. DONE or COMPLETE)

When the optional statuses don't exist in your list, clawdup falls back:
  in review      → in progress   (PR link is posted as a task comment)
  require input  → in progress   (a comment explains what's needed; move the
                                  task back to "to do" after answering)
  blocked        → in progress   (a comment explains the error)
  approved       → disabled      (merge PRs yourself, or set AUTO_APPROVE=true;
                                  move the task to done after merging)
  complete       → your list's done/closed-type status (e.g. "done")

How to set up:
  1. Open your ClickUp list
  2. Click the "..." menu > "List Settings" > "Statuses"
  3. Add/rename statuses to match the above
  4. The names must match exactly (case-insensitive)

Status names can be customized via environment variables (STATUS_TODO, etc).
`);
}

async function initProject(): Promise<void> {
  const repoRoot = detectRepoRoot();
  const envDest = resolve(repoRoot, ".env.local");
  const configDest = resolve(repoRoot, "clawdup.config.mjs");

  console.log(`Initializing clawdup at the repo root: ${repoRoot}\n`);

  const envTemplate = `# ClickUp Task Automation - Environment Variables
# This file holds secrets — it is gitignored and must never be committed.
# Docs: https://github.com/gehadshaat/clawdup

# === REQUIRED ===

# ClickUp API token (get from: ClickUp Settings > Apps > API Token)
CLICKUP_API_TOKEN=pk_xxx

# ClickUp List ID (from the list URL in ClickUp)
# Set EITHER CLICKUP_LIST_ID or CLICKUP_PARENT_TASK_ID (not both)
CLICKUP_LIST_ID=

# OR: ClickUp Parent Task ID (polls subtasks of this task instead of a list)
# CLICKUP_PARENT_TASK_ID=

# === OPTIONAL ===

# ClickUp API base URL (override to route through a proxy or use a mock
# server; include the API path prefix)
# CLICKUP_API_BASE_URL=https://api.clickup.com/api/v2

# GitHub repo in "owner/repo" format (auto-detected from git remote if empty)
# GITHUB_REPO=your-org/your-repo

# Base branch to create feature branches from
# BASE_BRANCH=main

# ClickUp status names (must match your list's statuses, case-insensitive).
# Only "to do", "in progress", and a done/closed status are required — a
# minimal TO DO / IN PROGRESS / DONE list works; missing optional statuses
# fall back automatically (run "clawdup --statuses" for details).
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
# CLAUDE_TIMEOUT_MS=1800000

# Max agentic turns for Claude Code per task
# CLAUDE_MAX_TURNS=100

# How many ClickUp tasks the runner works on in parallel.
# Each concurrent task gets its own git worktree under .clawdup-worktrees/.
# Set to 1 to disable parallelism. Range: 1-10.
# MAX_CONCURRENT_TASKS=2

# Git branch prefix
# BRANCH_PREFIX=clickup

# Auto-approve mode: merge PRs immediately after Claude completes (skip manual review)
# AUTO_APPROVE=true

# Link --stack runs' PRs into a native GitHub stack (public preview) via the
# gh stack extension (gh extension install github/gh-stack) so merging a lower
# PR automatically retargets the ones above. --stack offers to install the
# extension when it's missing and aborts otherwise; set to false to disable
# native linking (plain chained PRs — no extension needed).
# NATIVE_STACKS=true

# Log level: debug | info | warn | error
# LOG_LEVEL=info

# Log output format: text (default) or json
# LOG_FORMAT=json
`;

  if (!existsSync(envDest)) {
    writeFileSync(envDest, envTemplate);
    console.log(`  CREATE  ${envDest}`);
  } else {
    const existing = readFileSync(envDest, "utf-8");
    if (hasClawdupConfig(existing)) {
      console.log(`  SKIP  ${envDest} (clawdup already configured)`);
    } else {
      // .env.local may belong to other tooling — append the clawdup template
      // rather than rewriting the file.
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      writeFileSync(envDest, existing + separator + envTemplate);
      console.log(`  APPEND  ${envDest} (clawdup template added to existing file)`);
    }
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

  // The env file holds secrets — make sure it (and clawdup's runtime state
  // files) can never be committed.
  const added = ensureGitignoreEntries(repoRoot);
  if (added.length > 0) {
    console.log(`  UPDATE  .gitignore (added: ${added.join(", ")})`);
  } else {
    console.log("  SKIP  .gitignore (already covers clawdup files)");
  }

  console.log(`
Done! Next steps:
  1. Edit .env.local with your ClickUp API token and list ID
  2. Optionally customize clawdup.config.mjs
  3. Run: clawdup --check   (validate config)
  4. Run: clawdup           (start automation)
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
    console.error(`    Install: ${globalInstallCommand(detectPackageManager(process.cwd()), "@anthropic-ai/claude-code")}`);
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

  // Check the gh stack extension (informational — only --stack needs it,
  // and --stack itself offers to install it before running)
  try {
    const { isGhStackInstalled, GH_STACK_INSTALL_COMMAND } = await import("./git-ops.js");
    if (await isGhStackInstalled()) {
      console.log("  gh stack extension: installed");
    } else {
      console.log(
        "  gh stack extension: not installed (only needed for --stack, which " +
          `offers to install it; or run: ${GH_STACK_INSTALL_COMMAND})`,
      );
    }
  } catch {
    // gh missing — already reported above
  }

  // Check for CLAUDE.md / config file at the repo root (where clawdup
  // resolves them from, regardless of the invocation directory)
  const { GIT_ROOT } = await import("./config.js");

  const claudeMd = resolve(GIT_ROOT, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    console.log("  CLAUDE.md: found (will be used for project context)");
  } else {
    console.log(
      "  CLAUDE.md: not found (optional — add one at the repo root for better task context)",
    );
  }

  const configFile = resolve(GIT_ROOT, "clawdup.config.mjs");
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
 * Upgrade clawdup to the latest published version.
 * Detects whether clawdup is installed globally or as a local dependency,
 * checks if an update is available, and runs the appropriate upgrade command.
 */
async function upgradeClawdup(): Promise<void> {
  const { execFile: execFileCb } = await import("child_process");
  const { promisify } = await import("util");
  const { dirname: dirnameFn, resolve: resolveFn } = await import("path");
  const { fileURLToPath } = await import("url");
  const { readFileSync: readFileSyncFn } = await import("fs");

  const execFileAsync = promisify(execFileCb);
  const PACKAGE_NAME = "clawdup";

  // Read current version from our own package.json
  const clawdupRoot = resolveFn(dirnameFn(fileURLToPath(import.meta.url)), "..");
  let currentVersion = "unknown";
  try {
    const pkg = JSON.parse(readFileSyncFn(resolveFn(clawdupRoot, "package.json"), "utf-8")) as { version?: string };
    currentVersion = pkg.version ?? "unknown";
  } catch {
    // ignore
  }
  console.log(`Current version: ${currentVersion}`);

  // Fetch latest version from npm registry
  let latestVersion: string;
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`);
    if (!response.ok) {
      console.error(`Failed to check latest version: HTTP ${response.status}`);
      console.log("You can upgrade manually:");
      printManualUpgradeInstructions();
      return;
    }
    const data = (await response.json()) as { version: string };
    latestVersion = data.version;
  } catch (err) {
    console.error(`Failed to check latest version: ${(err as Error).message}`);
    console.log("\nYou can upgrade manually:");
    printManualUpgradeInstructions();
    return;
  }

  console.log(`Latest version:  ${latestVersion}`);

  if (currentVersion === latestVersion) {
    console.log("\nYou are already on the latest version!");
    return;
  }

  console.log(`\nUpgrading ${currentVersion} → ${latestVersion}...\n`);

  // clawdup is a global-only install: always upgrade the global package.
  const pm = detectPackageManager(process.cwd());
  let cmd: string;
  let cmdArgs: string[];
  if (pm === "pnpm") {
    cmd = "pnpm";
    cmdArgs = ["add", "-g", `${PACKAGE_NAME}@latest`];
  } else {
    cmd = "npm";
    cmdArgs = ["install", "-g", `${PACKAGE_NAME}@latest`];
  }

  console.log(`Running: ${cmd} ${cmdArgs.join(" ")}\n`);

  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout: 120000,
      env: { ...process.env },
    });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log(`Successfully upgraded clawdup to ${latestVersion}!`);
  } catch (err) {
    console.error(`Upgrade failed: ${(err as Error).message}`);
    console.log("\nYou can upgrade manually:");
    printManualUpgradeInstructions();
  }
}

function printManualUpgradeInstructions(): void {
  const pm = detectPackageManager(process.cwd());
  console.log(`  ${globalInstallCommand(pm, "clawdup@latest")}`);
}

/**
 * Rebuild TypeScript before relaunch so the new process loads fresh code.
 *
 * Only applies when clawdup runs from a source checkout (git clone +
 * npm link) that is also the repo being automated: dist/ is gitignored
 * there, so after syncBaseBranch() pulls new source the compiled JS is
 * stale until tsc runs again. A regular global install ships pre-built
 * dist/ with no sources, so the rebuild is skipped.
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

  const isSourceCheckout =
    existsSync(resolve(clawdupRoot, "tsconfig.json")) &&
    existsSync(resolve(clawdupRoot, "src"));
  if (!isSourceCheckout) {
    log("debug", "Global install detected — skipping rebuild before relaunch.");
    return;
  }

  const pm = detectPackageManager(clawdupRoot);

  log("info", "Rebuilding to pick up latest code changes...");
  try {
    await execFileAsync(pm, ["run", "build"], {
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
