# Configuration Examples Cookbook

Copy-pasteable Clawup setups for common usage patterns. Each example is self-contained — pick the one closest to your situation, adapt the identifiers and secrets, and you're running.

> **Prerequisites for all examples:** Node.js 18+, Claude Code CLI, GitHub CLI (authenticated), Git with push access. See the **[Complete Setup & Usage Guide](GUIDE.md)** for installation steps.

---

## 1. Solo Repo, Single List

**When to use:** You have one repository and one ClickUp list. This is the simplest setup — one long-running runner watches a single list and processes tasks sequentially.

### `.clawdup.env`

```env
# Required
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLICKUP_LIST_ID=901234567890
```

### Start the runner

```bash
# Validate setup first
clawdup --check

# Start continuous polling
clawdup
```

That's it. The runner polls every 30 seconds, picks the highest-priority "to do" task, implements it, and creates a PR. When you move a task to "approved" in ClickUp, the runner merges the PR automatically.

### Optional: custom Claude instructions

Create `clawdup.config.mjs` to give Claude extra context beyond your `CLAUDE.md`:

```js
// clawdup.config.mjs
export default {
  prompt: `
After making changes, run "npm run lint" to check for issues.
Always write tests for new functions.
  `.trim(),
};
```

**Relevant docs:** [CONFIGURATION.md — Environment Variables](CONFIGURATION.md#environment-variables), [GUIDE.md — Running Clawup](GUIDE.md)

---

## 2. Single Repo, Parent-Task-Centric

**When to use:** You don't want a dedicated ClickUp list for automation. Instead, you group automation tasks as subtasks under an existing parent task. Good for teams that want to keep automation tasks alongside manual work in the same list.

### `.clawdup.env`

```env
# Required
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Use a parent task instead of a list
# Find the task ID from the task URL: https://app.clickup.com/t/abc123def
CLICKUP_PARENT_TASK_ID=abc123def
```

### How it works

1. Create a task in ClickUp that serves as the "container" (e.g., "Automation Tasks for v2.0").
2. Add subtasks under it — each subtask is a unit of work for Clawup.
3. Clawup polls the parent task's subtasks filtered by status, just like it would poll a list.

### Start the runner

```bash
clawdup --check    # Validates parent task access and statuses
clawdup            # Polls subtasks of the parent task
```

Subtasks follow the same status lifecycle as list tasks: `to do → in progress → in review → approved → complete`.

**Relevant docs:** [CONFIGURATION.md — Task Source: List vs Parent Task](CONFIGURATION.md#task-source-list-vs-parent-task)

---

## 3. Monorepo with Multiple Apps

**When to use:** You have a monorepo with multiple packages (e.g., frontend and backend), and each package has its own ClickUp list driving separate areas of the codebase.

### Directory structure

```
my-monorepo/
├── packages/
│   ├── frontend/
│   │   ├── .clawdup.env            # Points to frontend ClickUp list
│   │   ├── clawdup.config.mjs      # Frontend-specific Claude instructions
│   │   └── package.json
│   └── backend/
│       ├── .clawdup.env            # Points to backend ClickUp list
│       ├── clawdup.config.mjs      # Backend-specific Claude instructions
│       └── package.json
├── CLAUDE.md                        # Shared project context (auto-detected)
└── pnpm-workspace.yaml
```

### `packages/frontend/.clawdup.env`

```env
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLICKUP_LIST_ID=111111111111

# Optional: use a different branch prefix to distinguish packages
BRANCH_PREFIX=frontend
```

### `packages/backend/.clawdup.env`

```env
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLICKUP_LIST_ID=222222222222

BRANCH_PREFIX=backend
```

### `packages/frontend/clawdup.config.mjs`

```js
export default {
  prompt: `
You are working in the frontend package (packages/frontend/).
This is a React app using TypeScript and Vite.
Run "pnpm --filter frontend test" after making changes.
  `.trim(),
};
```

### `packages/backend/clawdup.config.mjs`

```js
export default {
  prompt: `
You are working in the backend package (packages/backend/).
This is a Node.js API using Express and TypeScript.
Run "pnpm --filter backend test" after making changes.
  `.trim(),
};
```

### `packages/frontend/package.json` (and similar for backend)

```json
{
  "scripts": {
    "cook": "clawdup",
    "vibe-check": "clawdup --check"
  }
}
```

### Running

Each package runs its own independent Clawup instance:

```bash
# Terminal 1: frontend runner
cd packages/frontend && pnpm run cook

# Terminal 2: backend runner
cd packages/backend && pnpm run cook

# Or using pnpm workspace filters
pnpm --filter frontend run cook
pnpm --filter backend run cook
```

Both runners share the same Git repo but create branches with different prefixes (`frontend/CU-...` vs `backend/CU-...`). The shared `CLAUDE.md` at the repo root is automatically included alongside each package's `clawdup.config.mjs`.

**Relevant docs:** [README.md — Monorepo / Workspace](README.md#monorepo--workspace), [CONFIGURATION.md — Monorepo Support](CONFIGURATION.md#monorepo-support)

---

## 4. High-Safety CI-Driven Flow

**When to use:** You want a conservative setup with maximum visibility — dry-run validation in CI, structured logging for monitoring, and manual review before any merge. Good for production codebases where you want guardrails.

### `.clawdup.env`

```env
# Required
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLICKUP_LIST_ID=901234567890

# Conservative settings
CLAUDE_MAX_TURNS=30             # Limit Claude's iterations
CLAUDE_TIMEOUT_MS=300000        # 5-minute timeout (shorter leash)
POLL_INTERVAL_MS=60000          # Poll every 60s (less aggressive)
RELAUNCH_INTERVAL_MS=1800000    # Restart every 30 minutes
LOG_LEVEL=debug                 # Full visibility
```

### Preflight validation

Before starting the runner, always run the doctor check:

```bash
# Full environment health check
clawdup --doctor

# Validate config, API access, statuses, and CLI tools
clawdup --check
```

### CI dry-run workflow (`.github/workflows/dry-run.yml`)

Add a dry-run step to your PR pipeline to catch regressions:

```yaml
name: Clawup Dry Run
on:
  pull_request:
    branches: [main]

jobs:
  dry-run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Run Clawup dry-run
        env:
          CLICKUP_API_TOKEN: ${{ secrets.CLICKUP_API_TOKEN }}
          CLICKUP_LIST_ID: ${{ secrets.CLICKUP_LIST_ID }}
          DRY_RUN: "true"
          LOG_LEVEL: debug
          LOG_FORMAT: json
        run: node dist/cli.js --dry-run

```

### Structured JSON logging for monitoring

Use JSON log output for integration with log aggregation tools:

```bash
# JSON logs to stdout, pipe to your log collector
clawdup --json-log 2>&1 | tee clawdup.log
```

JSON log entries include `timestamp`, `level`, `message`, and contextual `tags` (operation name, task ID, etc.).

### Review workflow

With this setup, the flow is:

1. Clawup creates PRs automatically.
2. CI runs your test suite + the dry-run workflow on each PR.
3. A human reviews the PR and moves the ClickUp task to "approved".
4. Clawup merges the PR only after approval.

No `AUTO_APPROVE` — every change gets human eyes.

**Relevant docs:** [CONFIGURATION.md — Validation Rules](CONFIGURATION.md#validation-rules), [README.md — CI Dry-Run Workflow](README.md#ci-dry-run-workflow), [ARCHITECTURE.md — Security Model](ARCHITECTURE.md)

---

## 5. Local Development Sandbox

**When to use:** You're a contributor experimenting with Clawup on your own fork, or you want to test configuration changes safely without affecting real tasks or creating real PRs.

### `.clawdup.env`

```env
# Required
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Use a dedicated test list (separate from production tasks)
CLICKUP_LIST_ID=999999999999

# Optional: custom branch prefix to avoid collisions
BRANCH_PREFIX=sandbox
```

### Dry-run first

Always start with a dry run to verify your setup without side effects:

```bash
# Simulate the full pipeline — no branches, no PRs, no status changes
clawdup --dry-run --debug
```

### Process a single task interactively

Use `--once` with `--interactive` to pair-program with Claude on a specific task:

```bash
# Process one task with interactive Claude session
clawdup --once abc123 --interactive
```

In interactive mode, Claude accepts input from your terminal — you can guide it, ask questions, and iterate before it commits.

### Process a single task non-interactively

```bash
# Process one task, then exit
clawdup --once abc123 --debug
```

### Tips for safe experimentation

- **Use a separate ClickUp list** with throwaway test tasks so you don't disrupt real work.
- **Use `--dry-run`** to validate the full pipeline without making any changes.
- **Use `--once`** to process a single known task instead of polling continuously.
- **Use `--debug`** to see exactly what Clawup is doing at each step.
- **Use `--interactive`** when you want to collaborate with Claude in real time.
- **Check your setup** with `clawdup --check` or `clawdup --doctor` before running.

**Relevant docs:** [GUIDE.md — First Run](GUIDE.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## 6. Auto-Approve for Trusted Workloads

**When to use:** You trust the automation enough to skip manual PR review — Clawup creates the PR and immediately merges it. Useful for low-risk tasks like documentation updates, dependency bumps, or internal tooling where speed matters more than manual review.

### `.clawdup.env`

```env
# Required
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLICKUP_LIST_ID=901234567890

# Auto-merge PRs without manual review
AUTO_APPROVE=true
```

### How it differs

With `AUTO_APPROVE=true`, the lifecycle shortens:

```
to do → in progress → (PR created + merged) → complete
```

The task skips the "in review" and "approved" stages entirely. Claude implements the task, creates a PR, and Clawup immediately squash-merges it.

### Combine with `--once` for one-shot automation

```bash
# Process a single task and auto-merge the result
clawdup --once abc123
```

### When NOT to use this

- Production application code that needs human review
- Security-sensitive changes
- Tasks that modify CI/CD, permissions, or infrastructure
- Any codebase where you want a review gate

Consider pairing with CI checks (tests, linting) that run on the PR before the merge — even with auto-approve, GitHub branch protection rules are respected.

**Relevant docs:** [CONFIGURATION.md — AUTO_APPROVE](CONFIGURATION.md#environment-variables), [ARCHITECTURE.md — Processing Paths](ARCHITECTURE.md)

---

## Quick Reference: Which Example Fits?

| Scenario | Example | Key settings |
|----------|---------|-------------|
| One repo, one list, get started fast | [1. Solo Repo](#1-solo-repo-single-list) | `CLICKUP_LIST_ID` |
| Tasks grouped under a parent task | [2. Parent-Task-Centric](#2-single-repo-parent-task-centric) | `CLICKUP_PARENT_TASK_ID` |
| Multiple packages, separate lists | [3. Monorepo](#3-monorepo-with-multiple-apps) | Per-package `.clawdup.env` |
| Maximum safety and observability | [4. High-Safety CI](#4-high-safety-ci-driven-flow) | `--dry-run`, `--doctor`, JSON logs |
| Testing and experimenting safely | [5. Local Sandbox](#5-local-development-sandbox) | `--dry-run`, `--once`, `--interactive` |
| Skip review, merge immediately | [6. Auto-Approve](#6-auto-approve-for-trusted-workloads) | `AUTO_APPROVE=true` |

---

## Further Reading

- **[CONFIGURATION.md](CONFIGURATION.md)** — Full reference for every environment variable, CLI flag, and validation rule
- **[GUIDE.md](GUIDE.md)** — Step-by-step setup and usage walkthrough
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — How the pipeline works internally
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — Recovery guide for common failures
- **[PROMPT_SAFETY.md](PROMPT_SAFETY.md)** — Security model and prompt injection defenses
