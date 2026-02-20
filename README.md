# clawup

Automated pipeline that polls a ClickUp list for tasks, uses Claude Code to implement them, creates GitHub PRs, and manages task statuses through their full lifecycle.

Works with **any** project — just install, configure, and run.

> **New to clawup?** Read the **[Complete Setup & Usage Guide](GUIDE.md)** for step-by-step instructions, including how to sign up for ClickUp, configure statuses, install all prerequisites, and get everything running.

## Quick Start

```bash
# Install globally
npm install -g clawup

# Or use npx (no install needed)
npx clawup --init

# Set up your config
clawup --setup

# Validate everything
clawup --check

# Start the automation
clawup
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

Install as a dev dependency in each package that needs its own ClickUp automation. Each package gets its own `.clawup.env` with its own ClickUp list ID, API key, etc.

```bash
npm install -D clawup
# or
pnpm add -D clawup
```

Then add to the package's `package.json` scripts:

```json
{
  "scripts": {
    "clawup": "clawup",
    "clawup:check": "clawup --check",
    "clawup:setup": "clawup --setup",
    "clawup:once": "clawup --once"
  }
}
```

### Monorepo / Workspace

In a monorepo, each workspace package can have its own clawup config pointing to a different ClickUp list:

```
my-monorepo/
├── packages/
│   ├── frontend/
│   │   ├── .clawup.env          # CLICKUP_LIST_ID=frontend-list
│   │   ├── clawup.config.mjs    # Frontend-specific Claude instructions
│   │   └── package.json         # "clawup": "clawup"
│   └── backend/
│       ├── .clawup.env          # CLICKUP_LIST_ID=backend-list
│       ├── clawup.config.mjs    # Backend-specific Claude instructions
│       └── package.json         # "clawup": "clawup"
├── CLAUDE.md                    # Shared project context (auto-detected)
└── pnpm-workspace.yaml
```

Config files (`.clawup.env`, `clawup.config.mjs`) are resolved from the directory where `clawup` is run. Git operations automatically use the repository root. `CLAUDE.md` is checked in both the package directory and the repo root.

### Global Install

```bash
npm install -g clawup
```

### npx (no install)

```bash
npx clawup --init
npx clawup
```

## Configuration

### 1. Environment File

Create `.clawup.env` in your package directory (or run `clawup --init`):

```env
CLICKUP_API_TOKEN=pk_xxx
CLICKUP_LIST_ID=your-list-id
```

The tool also checks `.env.clickup` as an alternative filename.

**Add to `.gitignore`:**

```
.clawup.env
.env.clickup
```

### 2. Config File (Optional)

Create `clawup.config.mjs` in your package directory to customize Claude's behavior:

```js
// clawup.config.mjs
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

If your project has a `CLAUDE.md` file (used by Claude Code for project context), it will be automatically included in every task prompt. In a monorepo, clawup checks the package directory first, then falls back to the repository root.

### All Environment Variables

| Variable               | Required | Default         | Description                         |
| ---------------------- | -------- | --------------- | ----------------------------------- |
| `CLICKUP_API_TOKEN`    | Yes      | —               | ClickUp API token                   |
| `CLICKUP_LIST_ID`      | Yes      | —               | ClickUp list to poll                |
| `BASE_BRANCH`          | No       | `main`          | Base branch for feature branches    |
| `BRANCH_PREFIX`        | No       | `clickup`       | Prefix for task branches            |
| `POLL_INTERVAL_MS`     | No       | `30000`         | Polling interval (ms)               |
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
clawup                     # Start continuous polling
clawup --once <task-id>    # Process a single task
clawup --check             # Validate configuration
clawup --statuses          # Show recommended ClickUp statuses
clawup --setup             # Interactive setup wizard
clawup --init              # Create config files in current directory
clawup --help              # Show help
```

## Programmatic API

You can also import and use the modules directly:

```js
import { startRunner, runSingleTask } from "clawup";
import { getTasksByStatus, updateTaskStatus } from "clawup/clickup-api";
import { createTaskBranch, createPullRequest } from "clawup/git-ops";
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

## License

MIT
