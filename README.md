# clawdup

Automated pipeline that polls a ClickUp list for tasks, uses Claude Code to implement them, creates GitHub PRs, and manages task statuses through their full lifecycle.

Works with **any** project — just install, configure, and run.

> **New to clawdup?** Read the **[Complete Setup & Usage Guide](GUIDE.md)** for step-by-step instructions, including how to sign up for ClickUp, configure statuses, install all prerequisites, and get everything running.
>
> **Something broken?** See the **[Troubleshooting & Recovery Guide](TROUBLESHOOTING.md)** for common failure scenarios and how to fix them.
>
> **Looking for the full configuration reference?** See **[CONFIGURATION.md](CONFIGURATION.md)** for all CLI flags, environment variables, validation rules, and advanced options.

## Quick Start

```bash
# Install globally
npm install -g clawdup

# Or use npx (no install needed)
npx clawdup --init

# Set up your config
clawdup --setup

# Validate everything
clawdup --check

# Start the automation
clawdup
```

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   ClickUp    │     │  Git Branch  │     │  Claude Code  │     │  GitHub PR   │
│   "to do"    │────>│   created    │────>│  implements   │────>│   created    │
│              │     │              │     │   the task    │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
       │                                         │                     │
       ▼                                         ▼                     ▼
  Task moves to                          If needs input:         Task moves to
  "in progress"                          → comments on task      "in review"
                                         → moves to                   │
                                           "require input"            ▼
                                                               ┌──────────────┐
                                                               │  Move task   │
                                                               │ to "approved"│
                                                               └──────┬───────┘
                                                                      │
                                                                      ▼
                                                               ┌──────────────┐
                                                               │  Automation  │
                                                               │  merges PR   │
                                                               │ → "complete" │
                                                               └──────────────┘
```

### Full Flow

1. **Poll** — Checks ClickUp list every 30s for tasks with "to do" status
2. **Pick** — Selects the highest-priority task
3. **Branch** — Creates `clickup/CU-{task-id}-{slug}` from the base branch (auto-links to ClickUp)
4. **Work** — Runs Claude Code with the task description + your CLAUDE.md as context
5. **Result handling:**
   - **Success** — Commits, pushes, creates PR, moves task to "in review"
   - **Needs input** — Comments on task with what's missing, moves to "require input"
   - **Error** — Comments with error details, moves to "blocked"
   - **No changes** — Comments that no changes were produced, moves to "require input"
6. **Approval** — When a reviewer moves a task to "approved", the automation merges the PR
7. **Repeat** — Returns to base branch and polls for the next task

## Installation

### Per-Package (recommended)

Install as a dev dependency in each package that needs its own ClickUp automation. Each package gets its own `.clawdup.env` with its own ClickUp list ID, API key, etc.

```bash
npm install -D clawdup
# or
pnpm add -D clawdup
```

Then add to the package's `package.json` scripts:

```json
{
  "scripts": {
    "clawdup": "clawdup",
    "clawdup:check": "clawdup --check",
    "clawdup:setup": "clawdup --setup",
    "clawdup:once": "clawdup --once"
  }
}
```

### Monorepo / Workspace

In a monorepo, each workspace package can have its own clawdup config pointing to a different ClickUp list:

```
my-monorepo/
├── packages/
│   ├── frontend/
│   │   ├── .clawdup.env          # CLICKUP_LIST_ID=frontend-list
│   │   ├── clawdup.config.mjs    # Frontend-specific Claude instructions
│   │   └── package.json         # "clawdup": "clawdup"
│   └── backend/
│       ├── .clawdup.env          # CLICKUP_LIST_ID=backend-list
│       ├── clawdup.config.mjs    # Backend-specific Claude instructions
│       └── package.json         # "clawdup": "clawdup"
├── CLAUDE.md                    # Shared project context (auto-detected)
└── pnpm-workspace.yaml
```

Config files (`.clawdup.env`, `clawdup.config.mjs`) are resolved from the directory where `clawdup` is run. Git operations automatically use the repository root. `CLAUDE.md` is checked in both the package directory and the repo root.

### Global Install

```bash
npm install -g clawdup
```

### npx (no install)

```bash
npx clawdup --init
npx clawdup
```

## Configuration

### 1. Environment File

Create `.clawdup.env` in your package directory (or run `clawdup --init`):

```env
CLICKUP_API_TOKEN=pk_xxx
CLICKUP_LIST_ID=your-list-id
```

The tool also checks `.env.clickup` as an alternative filename.

**Add to `.gitignore`:**

```
.clawdup.env
.env.clickup
```

### 2. Config File (Optional)

Create `clawdup.config.mjs` in your package directory to customize Claude's behavior:

```js
// clawdup.config.mjs
export default {
  // Extra instructions appended to Claude's system prompt.
  // Your CLAUDE.md is loaded automatically — this is for additional context.
  prompt: `
After making changes, run "pnpm prettier" to format the code.
Always write tests for new functions.
  `.trim(),

  // Extra CLI args passed to the 'claude' command
  // claudeArgs: ["--allowedTools", "Bash,Read,Write,Edit"],
};
```

### 3. CLAUDE.md (Recommended)

If your project has a `CLAUDE.md` file (used by Claude Code for project context), it will be automatically included in every task prompt. In a monorepo, clawdup checks the package directory first, then falls back to the repository root.

### All Environment Variables

| Variable               | Required | Default         | Description                         |
| ---------------------- | -------- | --------------- | ----------------------------------- |
| `CLICKUP_API_TOKEN`    | Yes      | —               | ClickUp API token                   |
| `CLICKUP_LIST_ID`      | Yes*     | —               | ClickUp list to poll                |
| `CLICKUP_PARENT_TASK_ID` | Yes*   | —               | Or: parent task to poll subtasks    |
| `GITHUB_REPO`          | No       | *(auto-detect)*  | GitHub repo (`owner/repo`)          |
| `BASE_BRANCH`          | No       | `main`          | Base branch for feature branches    |
| `BRANCH_PREFIX`        | No       | `clickup`       | Prefix for task branches            |
| `POLL_INTERVAL_MS`     | No       | `30000`         | Polling interval (ms)               |
| `RELAUNCH_INTERVAL_MS` | No       | `600000`        | Runner restart interval (ms, 0=off) |
| `CLAUDE_COMMAND`       | No       | `claude`        | Claude Code CLI command             |
| `CLAUDE_TIMEOUT_MS`    | No       | `600000`        | Timeout per task (ms)               |
| `CLAUDE_MAX_TURNS`     | No       | `50`            | Max agentic turns per task          |
| `LOG_LEVEL`            | No       | `info`          | `debug` / `info` / `warn` / `error` |
| `STATUS_TODO`          | No       | `to do`         | ClickUp status: to do               |
| `STATUS_IN_PROGRESS`   | No       | `in progress`   | ClickUp status: in progress         |
| `STATUS_IN_REVIEW`     | No       | `in review`     | ClickUp status: in review           |
| `STATUS_APPROVED`      | No       | `approved`      | ClickUp status: approved            |
| `STATUS_REQUIRE_INPUT` | No       | `require input` | ClickUp status: require input       |
| `STATUS_COMPLETED`     | No       | `complete`      | ClickUp status: complete            |
| `STATUS_BLOCKED`       | No       | `blocked`       | ClickUp status: blocked             |

*\* At least one of `CLICKUP_LIST_ID` or `CLICKUP_PARENT_TASK_ID` must be set. See [CONFIGURATION.md](CONFIGURATION.md#task-source-list-vs-parent-task) for details.*

## ClickUp List Statuses

Set up these statuses in your ClickUp list:

| Status          | Type   | Color     | Description                                |
| --------------- | ------ | --------- | ------------------------------------------ |
| `to do`         | open   | `#d3d3d3` | Task ready to be picked up                 |
| `in progress`   | active | `#4194f6` | Automation is working on it                |
| `in review`     | active | `#a875ff` | PR created, awaiting human review          |
| `approved`      | active | `#2ecd6f` | Approved — automation will merge the PR    |
| `require input` | active | `#f9d900` | Needs clarification (comment explains why) |
| `blocked`       | active | `#f44336` | Automation hit an error                    |
| `complete`      | closed | `#6bc950` | Done — PR merged                           |

```
to do → in progress → in review → approved → complete
             │              │                    ▲
             ├→ require input → to do (retry)    │
             └→ blocked ─────────────────────────┘
```

## ClickUp GitHub Integration

All branches, commits, and PRs include `CU-{task-id}` so ClickUp's GitHub integration auto-links them.

| Artifact | Format                   | Example                      |
| -------- | ------------------------ | ---------------------------- |
| Branch   | `clickup/CU-{id}-{slug}` | `clickup/CU-abc123-add-auth` |
| Commit   | `[CU-{id}] {title}`      | `[CU-abc123] Add auth`       |
| PR title | `[CU-{id}] {title}`      | `[CU-abc123] Add auth`       |

Enable at: ClickUp Settings > Integrations > GitHub.

## CLI Reference

```bash
clawdup                     # Start continuous polling
clawdup --once <task-id>    # Process a single task
clawdup --interactive       # Run Claude in interactive mode (accepts user input)
clawdup --check             # Validate configuration
clawdup --statuses          # Show recommended ClickUp statuses
clawdup --setup             # Interactive setup wizard
clawdup --init              # Create config files in current directory
clawdup --help              # Show help
```

For the full configuration reference including all environment variables, validation rules, and advanced options, see **[CONFIGURATION.md](CONFIGURATION.md)**.

## Programmatic API

You can also import and use the modules directly:

```js
import { startRunner, runSingleTask } from "clawdup";
import { getTasksByStatus, updateTaskStatus } from "clawdup/clickup-api";
import { createTaskBranch, createPullRequest } from "clawdup/git-ops";
```

## Prerequisites

- **Node.js 18+** (for native `fetch`)
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** (`claude` command)
- **[GitHub CLI](https://cli.github.com/)** (`gh` command, authenticated)
- **Git** (configured with push access)
- **ClickUp GitHub integration** (optional but recommended)

## Writing Good Tasks

For best results, write ClickUp tasks with:

- **Clear title** — What needs to be done in one line
- **Detailed description** — Specifics about the implementation
- **Acceptance criteria** — Use ClickUp checklists
- **File hints** — Mention specific files or components if relevant

## Disclaimer

This project is a personal open-source tool created and maintained by a ClickUp engineer. It is **not** an official ClickUp product, nor is it endorsed, supported, or affiliated with ClickUp in any way. Use it at your own risk.

## License

MIT
