# Clawdup Configuration Reference

Complete reference for all CLI options, environment variables, and configuration files.

> For a step-by-step setup guide, see [GUIDE.md](GUIDE.md). For a quick overview, see [README.md](README.md). For how the pipeline works internally, see the [Architecture & State Flow](ARCHITECTURE.md).

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
| `--stack [task-id]` | Implement a series of tasks sequentially as **stacked PRs**. With a task ID, **all leaf subtasks** of that task are stacked: subtasks are collected recursively (subtasks with children are treated as grouping only). Without a task ID, the **full configured source** is stacked the same way — every open task in `CLICKUP_LIST_ID` (tasks with subtasks contribute their leaf subtasks instead), or the subtasks of `CLICKUP_PARENT_TASK_ID` when that is configured. Collected tasks are ordered by their ClickUp dependencies and processed one at a time — the first branch is created from the base branch, each next branch from the previous one, and each PR targets its branch's base (`base > b1 (PR1) > b2 (PR2)`). Runs in the main checkout only (`MAX_CONCURRENT_TASKS` is ignored) and `AUTO_APPROVE` is suppressed — merge the PRs bottom-up. If a task fails, the remaining ones are not attempted; re-running `--stack` resumes where it left off. After the run, the series' open PRs are linked into a **native GitHub stack** (public preview) through the official `gh stack` extension — merging a lower PR then automatically rebases and retargets the ones above it (see `NATIVE_STACKS`). The extension is required: when it's missing, `--stack` offers to install it (`gh extension install github/gh-stack`) on an interactive terminal and aborts otherwise. Without native linking (`NATIVE_STACKS=false`), delete each merged branch so GitHub retargets the next PR. Exits non-zero when the stack aborted. |
| `--interactive` | Run Claude Code in interactive mode. Instead of running autonomously, Claude accepts user input via the terminal. Can be combined with `--once` or continuous mode. |
| `--check` | Validate all configuration (API keys, statuses, CLI tools) and exit. Non-zero exit code on failure. |
| `--statuses` | Print the recommended ClickUp list statuses and exit. Does not require configuration. |
| `--setup` | Run the interactive setup wizard that guides you through creating a `.clawdup.env` file at the repository root (and gitignoring it). |
| `--init` | Create example `.clawdup.env` and `clawdup.config.mjs` files at the repository root, and add them to `.gitignore`. |
| `--help`, `-h` | Print usage information and exit. |

### Examples

```bash
# Start continuous polling (default)
clawdup

# Process one specific task
clawdup --once abc123

# Implement all leaf subtasks of a parent task as stacked PRs, in dependency order
clawdup --stack abc123

# Stack the full configured source instead: every open task in the list
# (or the configured parent task's subtasks)
clawdup --stack

# Preview the planned stack (order, branches, PR targets) without changing anything
clawdup --dry-run --stack abc123

# Interactive mode with a specific task (for debugging/testing)
clawdup --interactive --once abc123

# Interactive continuous mode (you interact with Claude for each task)
clawdup --interactive

# Validate config before starting
clawdup --check

# Bootstrap a repository (writes config files at the repo root)
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
| Quick trial / single parent task | `CLICKUP_PARENT_TASK_ID` |

### Validation

- At least one of `CLICKUP_LIST_ID` or `CLICKUP_PARENT_TASK_ID` must be set.
- If neither is set, clawdup exits immediately with an error.
- Both can be set simultaneously — `CLICKUP_PARENT_TASK_ID` is used for fetching tasks while `CLICKUP_LIST_ID` is used for creating follow-up tasks.

---

## Configuration Files

### `.clawdup.env`

Primary configuration file. Contains API tokens and settings as `KEY=VALUE` pairs.

- Lives at the **repository root** and is resolved from there no matter which subdirectory `clawdup` is run from.
- Alternative filename: `.env.clickup` (first found wins).
- Values do **not** override existing environment variables.
- **Never committed** — it contains secrets. `clawdup --setup` / `clawdup --init` add it to `.gitignore` automatically; keep it there.

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

Project context file used by Claude Code, at the repository root. Automatically included in every task prompt.

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
| `NATIVE_STACKS` | `true` | After a `--stack` run, link the series' open PRs into a **native GitHub stack** via the official [`gh stack` extension](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands) (public preview), so merging a lower PR automatically rebases and retargets the PRs above it, and reviewers get GitHub's stack UI. Resumed runs extend the existing stack. The extension is required for stack runs: when it's missing, `--stack` prompts to install it (`gh extension install github/gh-stack`) and aborts otherwise (non-interactive runs abort with instructions). Linking itself stays best-effort: where stacked PRs are unavailable for the repository (the preview isn't enabled yet) the chained PRs behave as before, and the run summary says so. Set to `false` to disable — plain chained PRs, no extension needed. |

### Polling & Relaunch

| Variable | Default | Description |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | `30000` (30s) | How often to poll ClickUp for new tasks. Minimum: 5000ms (5s). |
| `RELAUNCH_INTERVAL_MS` | `600000` (10min) | How often to restart the runner process. Set to `0` to disable. Minimum when enabled: 60000ms (1min). See [Relaunch Behavior](#relaunch-behavior). |
| `ADDRESS_PR_COMMENTS` | `true` | Automatically address new PR review comments. Each poll cycle, tasks sitting in "in progress" / "in review" are checked for GitHub PR reviews and inline code comments posted after the automation's last activity on the task; when found, the automation re-runs Claude with the feedback and pushes the updates to the same PR. Approval-only reviews (e.g. "LGTM") don't trigger a round, and each task is limited to 3 automatic rounds per runner session (a guard against ping-pong with auto-review bots) — after that, a comment asks a human to take over. Set to `false` to require the manual flow (move the task back to "to do" to trigger a feedback round). |

### Claude Code

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_COMMAND` | `claude` | CLI command to invoke Claude Code. |
| `CLAUDE_TIMEOUT_MS` | `1800000` (30min) | Maximum time Claude Code can run per task. Minimum: 30000ms (30s). |
| `CLAUDE_MAX_TURNS` | `100` | Maximum agentic turns (tool calls) per task. Range: 1–500. |
| `MAX_CONCURRENT_TASKS` | `2` | Number of ClickUp tasks processed in parallel. Each concurrent task runs in its own git worktree under `.clawdup-worktrees/slot-{n}`. Set to `1` to disable parallelism (no worktrees created). Range: 1–10. Note: each slot is a full checkout of the repo, so disk usage scales with this value. Worktrees do not auto-initialize git submodules or LFS — repos relying on those need additional setup per slot. |

### ClickUp Statuses

Customize status names to match your ClickUp list configuration. Names are case-insensitive.

| Variable | Default | Required in list? | Description |
| --- | --- | --- | --- |
| `STATUS_TODO` | `to do` | **Yes** (or any open-type status) | Task ready to be picked up. |
| `STATUS_IN_PROGRESS` | `in progress` | **Yes** | Automation is currently working. |
| `STATUS_IN_REVIEW` | `in review` | No | PR created, awaiting review. |
| `STATUS_APPROVED` | `approved` | No | Approved — automation will merge the PR. |
| `STATUS_REQUIRE_INPUT` | `require input` | No | Task needs clarification. |
| `STATUS_COMPLETED` | `complete` | **Yes** (or any done/closed-type status) | Task done, PR merged. |
| `STATUS_BLOCKED` | `blocked` | No | Automation hit an error. |

#### Status Fallbacks (minimal lists)

Only three statuses must exist in the list, so a default **TO DO / IN PROGRESS / DONE** list works out of the box. At startup clawdup fetches the list's actual statuses and rewrites the mapping for any that are missing:

| Missing from list | Falls back to |
| --- | --- |
| `to do` | The list's open-type status |
| `complete` | The list's closed-type (else done-type) status, e.g. `DONE` |
| `in review` | `in progress` |
| `require input` | `in progress` |
| `blocked` | `require input` if present, else `in progress` |
| `approved` | *No fallback* — approve-to-merge polling is disabled; merge PRs manually or use `AUTO_APPROVE=true` |

Consequences of running in fallback mode:

- Tasks needing review, input, or hit by an error all sit in `in progress` — the automation's task comment says which case applies and what to do next.
- Crash recovery of orphaned in-progress tasks is disabled (the runner can't distinguish parked tasks from crashed ones); move a stalled task back to `to do` to retry it.
- Without `approved`, nothing polls for tasks to merge: merge the PR yourself and move the task to done, or set `AUTO_APPROVE=true` to merge immediately after each successful run.

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
2. **`.clawdup.env`** (or `.env.clickup`) — loaded from the repository root
3. **`clawdup.config.mjs`** — JavaScript config file for `prompt` and `claudeArgs`, also at the repository root
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
- ClickUp list statuses cover the required set (`to do`, `in progress`, and a done/closed status) after [fallback resolution](#status-fallbacks-minimal-lists).
- GitHub CLI (`gh`) is installed and authenticated.
- Claude Code CLI (`claude`) is installed and responsive.
- Git repository detection.
- Presence of `CLAUDE.md` and `clawdup.config.mjs` (informational).

---

## Monorepo Configuration

A repository has exactly **one** clawdup configuration, at its root:

```
my-monorepo/
├── packages/
│   ├── frontend/
│   └── backend/
├── .clawdup.env                 # One config for the whole repo (gitignored)
├── clawdup.config.mjs           # Repo-wide Claude instructions (optional)
├── CLAUDE.md                    # Shared project context
└── pnpm-workspace.yaml
```

**How it works:**

- `GIT_ROOT` = the repository root, detected via `git rev-parse --show-toplevel` from wherever `clawdup` is invoked.
- Config files (`.clawdup.env`, `clawdup.config.mjs`), `CLAUDE.md`, runtime state files, and all git operations are anchored at `GIT_ROOT`.
- Running `clawdup` from any subdirectory behaves identically to running it at the root.

One ClickUp list (or parent task) feeds the whole repository. Direct work at specific packages through task descriptions and file hints, and encode per-package conventions in `CLAUDE.md` / `clawdup.config.mjs`.
