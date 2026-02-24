# Clawdup Configuration Reference

Complete reference for all CLI options, environment variables, and configuration files.

> For a step-by-step setup guide, see [GUIDE.md](GUIDE.md). For a quick overview, see [README.md](README.md).

---

## Table of Contents

1. [CLI Flags](#cli-flags)
2. [Task Source: List vs Parent Task](#task-source-list-vs-parent-task)
3. [Configuration Files](#configuration-files)
4. [Environment Variables](#environment-variables)
5. [Relaunch Behavior](#relaunch-behavior)
6. [Config Cascade (Priority Order)](#config-cascade-priority-order)
7. [Validation](#validation)
8. [Monorepo Configuration](#monorepo-configuration)

---

## CLI Flags

| Flag | Description |
| --- | --- |
| *(no flags)* | Start the continuous polling loop. Polls ClickUp for tasks and processes them automatically. |
| `--once <task-id>` | Process a single ClickUp task by its ID, then exit. Useful for testing or manual runs. |
| `--interactive` | Run Claude Code in interactive mode. Instead of running autonomously, Claude accepts user input via the terminal. Can be combined with `--once` or continuous mode. |
| `--check` | Validate all configuration (API keys, statuses, CLI tools) and exit. Non-zero exit code on failure. |
| `--statuses` | Print the recommended ClickUp list statuses and exit. Does not require configuration. |
| `--setup` | Run the interactive setup wizard that guides you through creating a `.clawdup.env` file. |
| `--init` | Create example `.clawdup.env` and `clawdup.config.mjs` files in the current directory. |
| `--help`, `-h` | Print usage information and exit. |

### Examples

```bash
# Start continuous polling (default)
clawdup

# Process one specific task
clawdup --once abc123

# Interactive mode with a specific task (for debugging/testing)
clawdup --interactive --once abc123

# Interactive continuous mode (you interact with Claude for each task)
clawdup --interactive

# Validate config before starting
clawdup --check

# Bootstrap a new project
clawdup --init
```

---

## Task Source: List vs Parent Task

Clawdup can poll tasks from two different sources. You must configure **exactly one**.

### Option 1: ClickUp List (`CLICKUP_LIST_ID`)

Polls all tasks in a specific ClickUp list. Best for dedicated automation lists.

```env
CLICKUP_LIST_ID=901234567890
```

**How to find the List ID:** Open the list in ClickUp, click the "..." menu, then "Copy Link". The list ID is the number at the end of the URL.

### Option 2: Parent Task Subtasks (`CLICKUP_PARENT_TASK_ID`)

Polls subtasks of a specific parent task. Best when you want to group automation tasks under an existing task without creating a separate list.

```env
CLICKUP_PARENT_TASK_ID=abc123xyz
```

**How to find the Parent Task ID:** Open the task in ClickUp. The task ID is in the URL: `https://app.clickup.com/t/abc123xyz` → ID is `abc123xyz`.

### Which should I use?

| Scenario | Recommendation |
| --- | --- |
| Dedicated list for automation | `CLICKUP_LIST_ID` |
| Tasks mixed with non-automated tasks | `CLICKUP_PARENT_TASK_ID` |
| Monorepo with per-package lists | `CLICKUP_LIST_ID` per package |
| Quick trial / single parent task | `CLICKUP_PARENT_TASK_ID` |

### Validation

- At least one of `CLICKUP_LIST_ID` or `CLICKUP_PARENT_TASK_ID` must be set.
- If neither is set, clawdup exits immediately with an error.
- Both can be set simultaneously — `CLICKUP_PARENT_TASK_ID` is used for fetching tasks while `CLICKUP_LIST_ID` is used for creating follow-up tasks.

---

## Configuration Files

### `.clawdup.env`

Primary configuration file. Contains API tokens and settings as `KEY=VALUE` pairs.

- Searched in the current working directory.
- Alternative filename: `.env.clickup` (first found wins).
- Values do **not** override existing environment variables.
- **Must be added to `.gitignore`** (contains secrets).

Run `clawdup --init` to generate an example file.

### `clawdup.config.mjs`

Optional JavaScript configuration file for customizing Claude Code behavior.

```js
// clawdup.config.mjs
export default {
  // Extra instructions appended to Claude's system prompt
  prompt: `
Run "npm run lint" after making changes.
Always write tests for new functions.
  `.trim(),

  // Extra CLI args passed to the 'claude' command
  claudeArgs: ["--allowedTools", "Bash,Read,Write,Edit,Glob,Grep"],
};
```

| Property | Type | Description |
| --- | --- | --- |
| `prompt` | `string` | Additional instructions appended to every Claude invocation. Your `CLAUDE.md` is already included automatically. |
| `claudeArgs` | `string[]` | Extra CLI arguments for the `claude` command. Dangerous flags (`--dangerously*`, `--no-verify`, `--skip-permissions`) are blocked. |

### `CLAUDE.md`

Project context file used by Claude Code. Automatically included in every task prompt. In a monorepo, clawdup checks the package directory first, then falls back to the repository root.

---

## Environment Variables

### Required

| Variable | Description |
| --- | --- |
| `CLICKUP_API_TOKEN` | ClickUp API token. Get from: ClickUp Settings > Apps > API Token. |
| `CLICKUP_LIST_ID` | ClickUp list ID to poll. **Required unless `CLICKUP_PARENT_TASK_ID` is set.** |
| `CLICKUP_PARENT_TASK_ID` | ClickUp parent task ID to poll subtasks from. **Required unless `CLICKUP_LIST_ID` is set.** |

### Git & GitHub

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_REPO` | *(auto-detected)* | GitHub repo in `owner/repo` format. Auto-detected from git remote if empty. |
| `BASE_BRANCH` | `main` | Base branch for creating feature branches. |
| `BRANCH_PREFIX` | `clickup` | Prefix for task branch names. Branches are named `{prefix}/CU-{task-id}-{slug}`. Must be alphanumeric, hyphens, or underscores only. |

### Polling & Relaunch

| Variable | Default | Description |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | `30000` (30s) | How often to poll ClickUp for new tasks. Minimum: 5000ms (5s). |
| `RELAUNCH_INTERVAL_MS` | `600000` (10min) | How often to restart the runner process. Set to `0` to disable. Minimum when enabled: 60000ms (1min). See [Relaunch Behavior](#relaunch-behavior). |

### Claude Code

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_COMMAND` | `claude` | CLI command to invoke Claude Code. |
| `CLAUDE_TIMEOUT_MS` | `600000` (10min) | Maximum time Claude Code can run per task. Minimum: 30000ms (30s). |
| `CLAUDE_MAX_TURNS` | `50` | Maximum agentic turns (tool calls) per task. Range: 1–500. |

### ClickUp Statuses

Customize status names to match your ClickUp list configuration. Names are case-insensitive.

| Variable | Default | Description |
| --- | --- | --- |
| `STATUS_TODO` | `to do` | Task ready to be picked up. |
| `STATUS_IN_PROGRESS` | `in progress` | Automation is currently working. |
| `STATUS_IN_REVIEW` | `in review` | PR created, awaiting review. |
| `STATUS_APPROVED` | `approved` | Approved — automation will merge the PR. |
| `STATUS_REQUIRE_INPUT` | `require input` | Task needs clarification. |
| `STATUS_COMPLETED` | `complete` | Task done, PR merged. |
| `STATUS_BLOCKED` | `blocked` | Automation hit an error. |

### Logging

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Logging verbosity. One of: `debug`, `info`, `warn`, `error`. |

---

## Relaunch Behavior

The runner periodically restarts itself to pick up fresh code and avoid long-running process issues.

**How it works:**

1. The runner starts and records a timestamp.
2. After each polling cycle, it checks if `RELAUNCH_INTERVAL_MS` has elapsed.
3. If the interval has passed **and no task is currently being processed** (idle), the runner:
   - Pulls the latest base branch (`git pull`).
   - Exits with a signal to restart.
4. The CLI's outer loop starts a fresh runner instance.

**Key details:**

- The runner only relaunches when idle — it never interrupts an in-progress task.
- Before restarting, it syncs the base branch so the new instance has the latest code.
- Set `RELAUNCH_INTERVAL_MS=0` to disable relaunch entirely (the runner will run indefinitely).
- Default: 10 minutes (`600000`ms).

---

## Config Cascade (Priority Order)

Settings are resolved in this order (highest priority first):

1. **Environment variables** — `export POLL_INTERVAL_MS=60000`
2. **`.clawdup.env`** (or `.env.clickup`) — loaded from the current working directory
3. **`clawdup.config.mjs`** — JavaScript config file for `prompt` and `claudeArgs`
4. **Defaults** — built-in fallback values

Environment variables set before running clawdup always take precedence. The `.clawdup.env` file only sets values that are not already in the environment.

---

## Validation

Clawdup validates configuration at startup and fails fast with clear error messages.

### Automatic checks (on every run)

- `CLICKUP_API_TOKEN` must be set.
- At least one of `CLICKUP_LIST_ID` or `CLICKUP_PARENT_TASK_ID` must be set.
- `POLL_INTERVAL_MS` must be a non-negative integer >= 5000 (5s).
- `RELAUNCH_INTERVAL_MS` must be 0 (disabled) or >= 60000 (1min).
- `CLAUDE_TIMEOUT_MS` must be >= 30000 (30s).
- `CLAUDE_MAX_TURNS` must be between 1 and 500.
- `BRANCH_PREFIX` must contain only alphanumeric characters, hyphens, and underscores.
- `LOG_LEVEL` must be one of: `debug`, `info`, `warn`, `error`.

### Extended checks (`--check` flag)

In addition to the above, `clawdup --check` validates:

- ClickUp API connectivity (fetches list or parent task info).
- ClickUp list statuses match the expected set.
- GitHub CLI (`gh`) is installed and authenticated.
- Claude Code CLI (`claude`) is installed and responsive.
- Git repository detection.
- Presence of `CLAUDE.md` and `clawdup.config.mjs` (informational).

---

## Monorepo Configuration

In a monorepo, each workspace package can have its own clawdup configuration:

```
my-monorepo/
├── packages/
│   ├── frontend/
│   │   ├── .clawdup.env          # CLICKUP_LIST_ID=frontend-list
│   │   └── clawdup.config.mjs    # Frontend-specific Claude instructions
│   └── backend/
│       ├── .clawdup.env          # CLICKUP_LIST_ID=backend-list
│       └── clawdup.config.mjs    # Backend-specific Claude instructions
├── CLAUDE.md                    # Shared project context
└── pnpm-workspace.yaml
```

**How it works:**

- `PROJECT_ROOT` = the directory where `clawdup` is run (e.g., `packages/frontend/`).
- `GIT_ROOT` = the repository root (e.g., `my-monorepo/`).
- Config files (`.clawdup.env`, `clawdup.config.mjs`) are resolved from `PROJECT_ROOT`.
- Git operations (branch, commit, push) run from `GIT_ROOT`.
- `CLAUDE.md` is checked in `PROJECT_ROOT` first, then falls back to `GIT_ROOT`.

Run clawdup from each package directory to use that package's configuration:

```bash
cd packages/frontend && clawdup
cd packages/backend && clawdup
```
