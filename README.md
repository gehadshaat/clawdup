# clawdup

**Your AI intern that never sleeps, never calls in sick, and never asks for a raise.**

Write a ClickUp task. Go touch grass. Come back to a PR. That's it. That's the product.

clawdup polls your ClickUp list, feeds tasks to Claude Code, and ships PRs while you're doing literally anything else. It saves you 6–7 days a week (results may vary on the 7th day depending on your backlog).

Works with **any** project — just install, configure, and let it cook.

> **New to clawdup?** Read the **[Complete Setup & Usage Guide](GUIDE.md)** to go from zero to autopilot.
>
> **Something broken?** See the **[Troubleshooting & Recovery Guide](TROUBLESHOOTING.md)** before you panic.
>
> **Want to understand the internals?** See the **[Architecture & State Flow](ARCHITECTURE.md)** if you're into that sort of thing.
>
> **Looking for the full configuration reference?** See **[CONFIGURATION.md](CONFIGURATION.md)** for all the knobs and dials.

## Quick Start

```bash
# Install globally
npm install -g clawdup

# Or use npx (no install needed)
npx clawdup --init

# Set up your config
clawdup --setup

# Validate everything (aka vibe check)
clawdup --check

# Let it cook
clawdup
```

## How It Works

You write the task. clawdup does everything else. Seriously.

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
                                                               │  You approve │
                                                               │  (the human  │
                                                               │   part lol)  │
                                                               └──────┬───────┘
                                                                      │
                                                                      ▼
                                                               ┌──────────────┐
                                                               │  Automation  │
                                                               │  merges PR   │
                                                               │ → "complete" │
                                                               └──────────────┘
```

### The Full Rundown

1. **Poll** — Stalks your ClickUp list every 30s for tasks marked "to do"
2. **Pick** — Grabs the highest-priority task (it has standards)
3. **Branch** — Creates `clickup/CU-{task-id}-{slug}` from the base branch (auto-links to ClickUp, because traceability is cool)
4. **Cook** — Runs Claude Code with the task description + your CLAUDE.md as context
5. **Result handling:**
   - **Nailed it** — Commits, pushes, creates PR, moves task to "in review"
   - **Confused** — Comments on task with what's missing, moves to "require input"
   - **Something broke** — Comments with error details, moves to "blocked"
   - **Nothing to do** — Comments that no changes were needed, moves to "require input"
6. **Approval** — When you move a task to "approved", the automation merges the PR (you're still in charge... for now)
7. **Repeat** — Goes back to the base branch and hunts for more work. Tireless.

## Installation

### Per-Package (recommended)

Install as a dev dependency in each package that needs its own ClickUp automation. Each package gets its own `.clawdup.env` with its own ClickUp list ID, API key, etc.

```bash
npm install -D clawdup
# or
pnpm add -D clawdup
```

Then add some scripts to your `package.json`. We recommend the fun ones:

```json
{
  "scripts": {
    "cook": "clawdup",
    "vibe-check": "clawdup --check",
    "summon": "clawdup --setup",
    "yolo": "clawdup --once"
  }
}
```

Now you can `npm run cook` and let it cook. `npm run vibe-check` to make sure everything's good. `npm run summon` to conjure the setup wizard. `npm run yolo` when you just need one task done right now.

> The boring aliases still work if you prefer `"clawdup": "clawdup"` — we won't judge (much).

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

For the commitment-ready:

```bash
npm install -g clawdup
```

### npx (no install)

For the commitment-averse:

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
clawdup                     # Let it cook (continuous polling)
clawdup --once <task-id>    # YOLO one task
clawdup --interactive       # Pair-program with the AI (accepts user input)
clawdup --check             # Vibe check your configuration
clawdup --statuses          # Show recommended ClickUp statuses
clawdup --setup             # Summon the setup wizard
clawdup --init              # Create config files in current directory
clawdup --dry-run           # Dress rehearsal (no real changes)
clawdup --debug             # Turn on X-ray vision (debug logging)
clawdup --json-log          # Output logs in JSON format (for the machines)
clawdup --help              # Show help (you're reading the fun version)
```

Or if you set up the fun scripts:

```bash
npm run cook                # Let it cook
npm run vibe-check          # Make sure everything's good
npm run summon              # Conjure the setup wizard
npm run yolo                # Process one task, no questions asked
```

For the full configuration reference including all environment variables, validation rules, and advanced options, see **[CONFIGURATION.md](CONFIGURATION.md)**.

## CI Dry-Run Workflow

Trust but verify. The repo includes a GitHub Actions workflow (`.github/workflows/dry-run.yml`) that runs clawdup in `--dry-run` mode on every PR. Think of it as a dress rehearsal — all the motions, none of the consequences.

### How it works

1. Checks out the PR branch and builds the project
2. Runs `clawup --dry-run` with debug logging enabled
3. Scans logs for fatal errors or configuration problems
4. Uploads the full log as an artifact for debugging
5. Fails the job on non-zero exit codes or error markers

### Setup for your own repo

1. **Create a dedicated CI ClickUp list** (or parent task) with a small set of test tasks in "to do" status.

2. **Add repository secrets** in GitHub (Settings > Secrets > Actions):
   - `CLICKUP_API_TOKEN` — your ClickUp API token (read-only access is sufficient for dry-run)
   - `CLICKUP_LIST_ID` — the test list ID (or use `CLICKUP_PARENT_TASK_ID` instead)

3. **Copy the workflow** from `.github/workflows/dry-run.yml` into your project, or adapt it:

```yaml
- name: Run Clawup dry-run
  env:
    CLICKUP_API_TOKEN: ${{ secrets.CLICKUP_API_TOKEN }}
    CLICKUP_LIST_ID: ${{ secrets.CLICKUP_LIST_ID }}
    DRY_RUN: "true"
    LOG_LEVEL: debug
  run: node dist/cli.js --dry-run
```

The dry-run mode performs a single poll cycle: it reads tasks from ClickUp, simulates what actions would be taken (branch creation, Claude invocation, PR creation, status updates), and exits — without touching git, GitHub, or ClickUp. All vibes, no side effects.

## Programmatic API

For the tinkerers who want to go under the hood — you can import and use the modules directly:

```js
import { startRunner, runSingleTask } from "clawdup";
import { getTasksByStatus, updateTaskStatus } from "clawdup/clickup-api";
import { createTaskBranch, createPullRequest } from "clawdup/git-ops";
```

## Prerequisites

You'll need a few things before clawdup can start its shift:

- **Node.js 18+** (for native `fetch` — we don't polyfill around here)
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** (`claude` command — the brains of the operation)
- **[GitHub CLI](https://cli.github.com/)** (`gh` command, authenticated — clawdup's hands)
- **Git** (configured with push access — obviously)
- **ClickUp GitHub integration** (optional but recommended — makes everything auto-link beautifully)

## Writing Good Tasks

clawdup is only as good as the tasks you feed it. Garbage in, garbage out. Gold in, PRs out.

- **Clear title** — What needs to be done in one line (not "fix stuff")
- **Detailed description** — The more context, the better the code. Be specific.
- **Acceptance criteria** — Use ClickUp checklists so clawdup knows when it's done
- **File hints** — Mention specific files or components. clawdup appreciates a good treasure map.

## Disclaimer

This project is a personal open-source tool created and maintained by a ClickUp engineer. It is **not** an official ClickUp product, nor is it endorsed, supported, or affiliated with ClickUp in any way. Use it at your own risk. (But honestly, the risk is mostly "what do I do with all this free time?")

## License

MIT — go wild.
