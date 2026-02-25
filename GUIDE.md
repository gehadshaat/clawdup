# clawdup - Complete Setup & Usage Guide

This guide walks you through setting up **clawdup** — from ClickUp configuration to your first automated PR.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step 1: Sign Up for ClickUp](#step-1-sign-up-for-clickup)
4. [Step 2: Create a ClickUp Space and List](#step-2-create-a-clickup-space-and-list)
5. [Step 3: Configure ClickUp List Statuses](#step-3-configure-clickup-list-statuses)
6. [Step 4: Get Your ClickUp API Token](#step-4-get-your-clickup-api-token)
7. [Step 5: Find Your ClickUp List ID](#step-5-find-your-clickup-list-id)
8. [Step 6: Enable ClickUp GitHub Integration](#step-6-enable-clickup-github-integration)
9. [Step 7: Install Prerequisites](#step-7-install-prerequisites)
10. [Step 8: Install clawdup](#step-8-install-clawdup)
11. [Step 9: Configure clawdup](#step-9-configure-clawdup)
12. [Step 10: Validate Your Setup](#step-10-validate-your-setup)
13. [Running the Automation](#running-the-automation)
14. [Writing Effective Tasks](#writing-effective-tasks)
15. [Understanding the Workflow](#understanding-the-workflow)
16. [Task Status Lifecycle](#task-status-lifecycle)
17. [Reviewing and Approving Changes](#reviewing-and-approving-changes)
18. [Advanced Configuration](#advanced-configuration)
19. [Monorepo Setup](#monorepo-setup)
20. [Programmatic API](#programmatic-api)
21. [Troubleshooting](#troubleshooting)
22. [FAQ](#faq)

---

## Overview

clawdup automates the boring parts of the software development workflow:

1. Polls your ClickUp list for tasks marked "to do"
2. Picks the highest-priority task
3. Creates a git branch linked to the ClickUp task
4. Runs Claude Code to implement the task
5. Commits, pushes, and creates a GitHub pull request
6. Updates the ClickUp task status at every step
7. Merges the PR once you approve it

Write a task in ClickUp, come back to a PR ready for review.

---

## Prerequisites

Before you begin, ensure you have the following:

| Requirement | Minimum Version | Purpose |
|---|---|---|
| **Node.js** | 18.0+ | Runtime for clawdup (needs native `fetch`) |
| **Git** | Any recent version | Version control and branch management |
| **GitHub CLI (`gh`)** | Any recent version | Creating and merging pull requests |
| **Claude Code CLI (`claude`)** | Latest | AI-powered code implementation |
| **A GitHub repository** | — | Where your code lives |
| **A ClickUp account** | Free tier works | Task management |

---

## Step 1: Sign Up for ClickUp

If you don't already have a ClickUp account:

1. Go to [https://clickup.com](https://clickup.com)
2. Click **"Get Started Free"**
3. Sign up using your email, Google account, or SSO
4. Follow the onboarding flow to create your **Workspace** (this is your team's top-level container)

> **Tip:** The free tier of ClickUp is sufficient for using clawdup. You don't need a paid plan.

### ClickUp Hierarchy

ClickUp organizes work in a hierarchy. Understanding this helps when setting up clawdup:

```
Workspace (your team/org)
└── Space (a project area, e.g., "Engineering")
    └── Folder (optional grouping)
        └── List (where tasks live — this is what clawdup polls)
            └── Tasks (individual work items)
```

clawdup works at the **List** level — it polls a specific list for tasks.

---

## Step 2: Create a ClickUp Space and List

1. In your ClickUp Workspace, click the **"+"** button in the left sidebar
2. Select **"Space"** and name it (e.g., "My Project" or "Engineering")
3. Inside the Space, click **"+ Add List"**
4. Name the list (e.g., "Automation Tasks" or your project name)

This list is where you'll create tasks for clawdup to pick up and implement.

---

## Step 3: Configure ClickUp List Statuses

clawdup relies on specific task statuses to track progress. You need to set up these statuses in your ClickUp list.

### Required Statuses

| Status | Type | Color | Description |
|---|---|---|---|
| `to do` | open | `#d3d3d3` | Task is ready to be picked up by the automation |
| `in progress` | active | `#4194f6` | Automation is currently working on the task |
| `in review` | active | `#a875ff` | PR created, waiting for human review |
| `approved` | active | `#2ecd6f` | Human approved — automation will merge the PR |
| `require input` | active | `#f9d900` | Task needs clarification (automation added a comment explaining why) |
| `blocked` | active | `#f44336` | Automation encountered an error |
| `complete` | closed | `#6bc950` | Done — PR has been merged |

### How to Configure Statuses

1. Open your ClickUp list
2. Click the **"..."** (three dots) menu at the top of the list
3. Select **"List Settings"**
4. Go to the **"Statuses"** tab
5. Add or rename statuses to match the table above
6. Make sure the status names match exactly (they are case-insensitive)
7. Set the status types correctly:
   - **"to do"** should be an "open" type status
   - **"complete"** should be a "closed" type status
   - All others should be "active" type statuses
8. Click **"Save"**

> **Tip:** You can also run `clawdup --statuses` after installation to see this list as a quick reference.

---

## Step 4: Get Your ClickUp API Token

clawdup needs an API token to interact with ClickUp on your behalf.

1. Click your avatar in the bottom-left corner of ClickUp
2. Select **"Settings"**
3. In the left sidebar, click **"Apps"** (under your personal settings)
4. You will see a section labeled **"API Token"**
5. Click **"Generate"** (or copy the existing token if you already have one)
6. Copy the token — it will look like `pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

> **Important:** Keep this token secret. It grants full access to your ClickUp workspace. Never commit it to version control.

---

## Step 5: Find Your ClickUp List ID

clawdup needs the ID of the specific list to poll for tasks.

1. Open your ClickUp list in the browser
2. Click the **"..."** (three dots) menu next to the list name
3. Select **"Copy Link"**
4. The URL will look like: `https://app.clickup.com/12345678/v/li/901234567890`
5. The **List ID** is the number at the end: `901234567890`

Alternatively:
- Look at the URL in your browser address bar when viewing the list
- The list ID is the long numeric value in the URL path

---

## Step 6: Enable ClickUp GitHub Integration

This step is optional but highly recommended. It automatically links your GitHub branches, commits, and PRs to the corresponding ClickUp tasks.

clawdup names branches, commits, and PR titles with `CU-{task-id}` (e.g., `CU-abc123`). ClickUp's GitHub integration recognizes this pattern and shows the linked activity directly on the task.

### How to Enable

1. In ClickUp, go to **Settings** (click your avatar > Settings)
2. Navigate to **Integrations** in the left sidebar
3. Find **GitHub** and click **"Connect"**
4. Authorize ClickUp to access your GitHub account/organization
5. Select the repositories you want to link

### What Gets Linked

| Artifact | Naming Format | Example |
|---|---|---|
| Branch | `clickup/CU-{id}-{slug}` | `clickup/CU-abc123-add-auth` |
| Commit message | `[CU-{id}] {title}` | `[CU-abc123] Add auth` |
| PR title | `[CU-{id}] {title}` | `[CU-abc123] Add auth` |

Once enabled, you'll see GitHub activity (branches, commits, PRs) directly on each ClickUp task card.

---

## Step 7: Install Prerequisites

### Node.js (18+)

clawdup requires Node.js 18 or later for native `fetch` support.

```bash
# Check your version
node --version

# Install via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 18
nvm use 18

# Or via your package manager
# macOS: brew install node
# Ubuntu: sudo apt install nodejs npm
```

### Git

```bash
# Check if git is installed
git --version

# Make sure you have push access to your repository
git remote -v
```

### GitHub CLI (`gh`)

The GitHub CLI is used to create and merge pull requests.

```bash
# Install
# macOS: brew install gh
# Ubuntu: sudo apt install gh
# Windows: winget install GitHub.cli
# Or see: https://cli.github.com/

# Authenticate
gh auth login
# Follow the prompts to authenticate with your GitHub account
```

Verify it works:

```bash
gh auth status
```

### Claude Code CLI (`claude`)

Claude Code is Anthropic's AI coding assistant that runs in your terminal.

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version
```

You'll need an Anthropic API key or an active Claude subscription for Claude Code to work. Follow the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for setup instructions.

---

## Step 8: Install clawdup

Choose one of these installation methods:

### Option A: Per-Project Install (Recommended)

Install as a dev dependency in your project:

```bash
cd your-project
npm install -D clawdup
```

Add some scripts to your `package.json`:

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

`npm run cook` starts continuous polling, `npm run vibe-check` validates your setup, and `npm run yolo` processes a single task.

### Option B: Global Install

```bash
npm install -g clawdup
```

### Option C: Use npx (No Install)

```bash
npx clawdup --init
npx clawdup
```

---

## Step 9: Configure clawdup

There are two ways to configure clawdup: the interactive setup wizard or manual configuration.

### Option A: Interactive Setup Wizard (Recommended)

```bash
clawdup --setup
```

The wizard will:
1. Ask for your ClickUp API token
2. Ask for your ClickUp List ID
3. Validate the connection to ClickUp
4. Check if the required statuses exist
5. Ask for optional settings (base branch, polling interval, etc.)
6. Write the `.clawdup.env` file

### Option B: Quick Init + Manual Edit

```bash
# Generate template config files
clawdup --init
```

This creates two files:
- **`.clawdup.env`** — Environment variables (API token, list ID, etc.)
- **`clawdup.config.mjs`** — Optional Claude Code customization

Edit `.clawdup.env` and fill in your values:

```env
# Required
CLICKUP_API_TOKEN=pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
CLICKUP_LIST_ID=901234567890

# Optional (shown with defaults)
# BASE_BRANCH=main
# BRANCH_PREFIX=clickup
# POLL_INTERVAL_MS=30000
# CLAUDE_TIMEOUT_MS=600000
# CLAUDE_MAX_TURNS=50
# LOG_LEVEL=info
```

### Add to .gitignore

Your `.clawdup.env` contains secrets. Make sure it's not committed:

```bash
echo ".clawdup.env" >> .gitignore
echo ".env.clickup" >> .gitignore
```

### Optional: Customize Claude's Behavior

Edit `clawdup.config.mjs` to add project-specific instructions for Claude:

```js
// clawdup.config.mjs
export default {
  // Extra instructions for Claude (appended to the system prompt)
  prompt: `
After making changes, run "npm run lint" to check for issues.
Always write tests for new functions.
Use TypeScript strict mode conventions.
  `.trim(),

  // Extra CLI args for the claude command
  // claudeArgs: ["--allowedTools", "Bash,Read,Write,Edit"],
};
```

### Optional: Add a CLAUDE.md File

If your project has a `CLAUDE.md` file (used by Claude Code for project context), clawdup will automatically include its contents in every task prompt. This is the best way to give Claude context about your project's architecture, conventions, and coding standards.

```markdown
# CLAUDE.md

This is a Node.js project using TypeScript and Express.
- Use ESM imports (not CommonJS)
- Follow the existing error handling patterns
- Tests use Vitest
- Run `npm test` to verify changes
```

---

## Step 10: Validate Your Setup

Before running the automation, verify everything is configured correctly:

```bash
clawdup --check
```

This will verify:
- ClickUp API connection and list access
- All required statuses exist in your ClickUp list
- GitHub repository is detected from git remote
- Claude Code CLI (`claude`) is installed and working
- GitHub CLI (`gh`) is installed
- `CLAUDE.md` presence (optional)
- `clawdup.config.mjs` presence (optional)

Example output:

```
Running configuration checks...

  ClickUp List: "Automation Tasks" (901234567890)
  Task count: 12
  Statuses: to do, in progress, in review, approved, require input, blocked, complete
  All configured statuses validated successfully.
  GitHub repo: your-org/your-repo
  Claude Code: 1.x.x
  GitHub CLI: gh version 2.x.x
  CLAUDE.md: found (will be used for project context)
  Config file: found

All checks passed! Ready to run.
```

Fix any issues reported before proceeding.

---

## Running the Automation

### Let It Cook (Continuous Polling)

Start the automation:

```bash
clawdup
# or, if you set up the fun scripts:
npm run cook
```

This will:
1. Validate your configuration
2. Recover any tasks left "in progress" from a previous crash
3. Poll your ClickUp list every 30 seconds (configurable)
4. Process tasks one at a time in priority order
5. Keep running until you stop it

### YOLO Mode (Single Task)

To process one specific task without continuous polling:

```bash
clawdup --once <task-id>
# or
npm run yolo -- <task-id>
```

The task ID is the alphanumeric identifier from ClickUp (visible in the task URL or the task detail panel).

### Stopping the Automation

Press `Ctrl+C` to gracefully shut down. clawdup will:
1. Finish processing the current task (if any)
2. Return to the base branch
3. Exit cleanly

Sending `SIGTERM` also triggers graceful shutdown.

---

## Writing Effective Tasks

The quality of clawdup's output depends directly on the quality of your task descriptions. Be specific.

### Task Title

Write a clear, one-line summary of what needs to be done:

- **Chef's kiss:** "Add email validation to the signup form"
- **Solid:** "Fix null pointer error in UserService.getProfile"
- **Please no:** "Fix bug" (which bug? where?)
- **Absolutely not:** "Make improvements" (to what?)

### Task Description

Provide specific details about the implementation:

```markdown
Add input validation to the signup form at src/components/SignupForm.tsx.

Requirements:
- Email field: validate format using a regex pattern
- Password field: minimum 8 characters, at least one uppercase and one number
- Show inline error messages below each field
- Disable the submit button while validation errors exist

The validation should happen on blur and on form submission.
```

### Checklists / Acceptance Criteria

Use ClickUp checklists for acceptance criteria. clawdup includes these in the prompt to Claude:

- [ ] Email validation shows error for invalid formats
- [ ] Password validation enforces minimum requirements
- [ ] Error messages appear below the relevant field
- [ ] Submit button is disabled when there are errors

### File Hints

If the change should be in specific files, mention them:

```
Modify the following files:
- src/components/SignupForm.tsx (add validation logic)
- src/utils/validators.ts (add validation helper functions)
- src/styles/forms.css (add error message styles)
```

### Priority

Set ClickUp task priority to control processing order:
1. **Urgent** — processed first
2. **High** — processed before normal/low
3. **Normal** — default priority
4. **Low** — processed last

Tasks with the same priority are processed by creation date (oldest first).

---

## Understanding the Workflow

Here's what happens when clawdup processes a task:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   ClickUp    │     │  Git Branch  │     │  Claude Code  │     │  GitHub PR   │
│   "to do"    │────>│   created    │────>│  implements   │────>│   created    │
│              │     │              │     │   the task    │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
       │                                         │                     │
       v                                         v                     v
  Task moves to                          If needs input:         Task moves to
  "in progress"                          → comments on task      "in review"
                                         → moves to
                                           "require input"
```

### Detailed Steps

1. **Poll** — clawdup checks the ClickUp list every 30 seconds for tasks with "to do" status
2. **Pick** — Selects the highest-priority task (urgent > high > normal > low, then oldest first)
3. **Status update** — Moves the task to "in progress" and adds a comment
4. **Branch** — Creates a branch named `clickup/CU-{task-id}-{slug}` from the base branch
5. **Claude Code** — Runs Claude Code with:
   - The task title, description, checklists, subtasks, and comments
   - Your `CLAUDE.md` project context (if it exists)
   - Custom instructions from `clawdup.config.mjs` (if configured)
6. **Result handling:**
   - **Success with changes** — Commits, pushes, creates a GitHub PR, moves task to "in review"
   - **Needs input** — Adds a comment explaining what info is missing, moves to "require input"
   - **Error** — Adds a comment with the error details, moves to "blocked"
   - **No changes** — Adds a comment noting no changes were made, moves to "require input"
7. **Cleanup** — Returns to the base branch, ready for the next task

### Approval and Merge

clawdup also watches for tasks in the "approved" status:

1. A human reviews the PR and the task
2. The human moves the task to **"approved"** in ClickUp
3. On the next poll, clawdup detects the approved task
4. clawdup merges the PR (squash merge, deletes the branch)
5. The task is moved to **"complete"**

---

## Task Status Lifecycle

```
to do → in progress → in review → approved → complete
             │              │                    ^
             ├→ require input → to do (retry)    │
             └→ blocked ─────────────────────────┘
```

| Transition | Triggered By | What Happens |
|---|---|---|
| to do → in progress | Automation | clawdup picks up the task and starts working |
| in progress → in review | Automation | Claude succeeded, PR created |
| in progress → require input | Automation | Claude needs more information |
| in progress → blocked | Automation | An error occurred |
| require input → to do | Human | After adding requested info, move back to retry |
| in review → approved | Human | After reviewing the PR, approve it |
| approved → complete | Automation | clawdup merges the PR |
| blocked → to do | Human | After fixing the issue, move back to retry |

---

## Reviewing and Approving Changes

When clawdup creates a PR:

1. **Check the ClickUp task** — The automation adds a comment with the PR link
2. **Review the PR on GitHub** — Look at the code changes, run tests locally if needed
3. **If changes look good:**
   - Move the ClickUp task status to **"approved"**
   - clawdup will automatically merge the PR on the next poll cycle
4. **If changes need work:**
   - Leave comments on the PR or ClickUp task
   - Move the task back to **"to do"** to have clawdup retry
   - Or make manual edits on the branch and push them

---

## Advanced Configuration

### All Environment Variables

These can be set in `.clawdup.env` or as system environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLICKUP_API_TOKEN` | Yes | — | Your ClickUp personal API token |
| `CLICKUP_LIST_ID` | Yes | — | The ClickUp list ID to poll |
| `BASE_BRANCH` | No | `main` | Base branch for creating feature branches |
| `BRANCH_PREFIX` | No | `clickup` | Prefix for task branch names |
| `POLL_INTERVAL_MS` | No | `30000` | How often to poll ClickUp (milliseconds) |
| `CLAUDE_COMMAND` | No | `claude` | The Claude Code CLI command name |
| `CLAUDE_TIMEOUT_MS` | No | `600000` | Max time per task for Claude (milliseconds, default 10 min) |
| `CLAUDE_MAX_TURNS` | No | `50` | Max agentic turns Claude can take per task |
| `LOG_LEVEL` | No | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `STATUS_TODO` | No | `to do` | ClickUp status name for "to do" |
| `STATUS_IN_PROGRESS` | No | `in progress` | ClickUp status name for "in progress" |
| `STATUS_IN_REVIEW` | No | `in review` | ClickUp status name for "in review" |
| `STATUS_APPROVED` | No | `approved` | ClickUp status name for "approved" |
| `STATUS_REQUIRE_INPUT` | No | `require input` | ClickUp status name for "require input" |
| `STATUS_COMPLETED` | No | `complete` | ClickUp status name for "complete" |
| `STATUS_BLOCKED` | No | `blocked` | ClickUp status name for "blocked" |

### Custom Status Names

If your ClickUp list uses different status names (e.g., "Ready" instead of "to do"), override them:

```env
STATUS_TODO=ready
STATUS_IN_REVIEW=code review
STATUS_COMPLETED=done
```

The status names are case-insensitive.

### Claude Code Tuning

Adjust how Claude Code works on tasks:

```env
# Give Claude more time for complex tasks (15 minutes)
CLAUDE_TIMEOUT_MS=900000

# Allow more agentic turns for bigger tasks
CLAUDE_MAX_TURNS=100

# Increase logging for debugging
LOG_LEVEL=debug
```

---

## Monorepo Setup

In a monorepo, each package can have its own clawdup configuration pointing to a different ClickUp list:

```
my-monorepo/
├── packages/
│   ├── frontend/
│   │   ├── .clawdup.env          # CLICKUP_LIST_ID=frontend-list-id
│   │   ├── clawdup.config.mjs    # Frontend-specific instructions
│   │   └── package.json         # "clawdup": "clawdup"
│   └── backend/
│       ├── .clawdup.env          # CLICKUP_LIST_ID=backend-list-id
│       ├── clawdup.config.mjs    # Backend-specific instructions
│       └── package.json         # "clawdup": "clawdup"
├── CLAUDE.md                    # Shared project context
└── pnpm-workspace.yaml
```

### How It Works

- Config files (`.clawdup.env`, `clawdup.config.mjs`) are resolved from the directory where `clawdup` is run
- Git operations automatically use the repository root (detected via `git rev-parse --show-toplevel`)
- `CLAUDE.md` is checked in both the package directory and the repo root
- Each package runs its own independent clawdup instance

### Running in a Monorepo

```bash
# From the frontend package
cd packages/frontend
npx clawdup

# Or using package scripts
pnpm --filter frontend run clawdup
```

---

## Programmatic API

You can import clawdup's modules directly for custom integrations:

```js
import { startRunner, runSingleTask } from "clawdup";
import {
  getTasksByStatus,
  getTask,
  updateTaskStatus,
  addTaskComment,
  formatTaskForClaude,
  validateStatuses,
} from "clawdup/clickup-api";
import {
  detectGitHubRepo,
  createTaskBranch,
  commitChanges,
  pushBranch,
  createPullRequest,
  mergePullRequest,
} from "clawdup/git-ops";
import { runClaudeOnTask } from "clawdup/claude-worker";
import { STATUS, log } from "clawdup/config";
```

### Example: Custom Task Processing

```js
import { getTask, updateTaskStatus, formatTaskForClaude } from "clawdup/clickup-api";
import { createTaskBranch } from "clawdup/git-ops";
import { runClaudeOnTask } from "clawdup/claude-worker";
import { STATUS } from "clawdup/config";

const task = await getTask("abc123");
const prompt = formatTaskForClaude(task);
const branch = await createTaskBranch(task.id, "my-feature");
const result = await runClaudeOnTask(prompt, task.id);

if (result.success) {
  console.log("Task completed successfully!");
} else if (result.needsInput) {
  console.log("More info needed:", result.output);
}
```

---

## Troubleshooting

### "Missing required environment variable: CLICKUP_API_TOKEN"

Your `.clawdup.env` file is missing or doesn't contain `CLICKUP_API_TOKEN`. Make sure:
- The file exists in the directory where you run `clawdup`
- The file is named `.clawdup.env` (or `.env.clickup`)
- The token value is set correctly (no quotes needed)

### "ClickUp API error 401"

Your API token is invalid or expired. Generate a new one from ClickUp Settings > Apps > API Token.

### "ClickUp API error 404"

The list ID is incorrect. Double-check the ID by copying the list link from ClickUp.

### "Status validation failed"

Your ClickUp list is missing required statuses. Run `clawdup --statuses` to see which statuses are needed, then add them in ClickUp (List Settings > Statuses).

### "claude command not found"

Claude Code CLI is not installed or not in your PATH. Install it:

```bash
npm install -g @anthropic-ai/claude-code
```

### "gh command not found"

GitHub CLI is not installed. Install it from [https://cli.github.com](https://cli.github.com) and authenticate:

```bash
gh auth login
```

### "Could not detect GitHub repo from remote"

Your git repository doesn't have a GitHub remote configured, or the remote URL format is unexpected. Check:

```bash
git remote get-url origin
```

It should be a GitHub URL (SSH or HTTPS format).

### "Working tree is not clean"

clawdup requires a clean git working directory before starting. Commit or stash any pending changes:

```bash
git stash
# or
git add -A && git commit -m "WIP"
```

### Claude Code times out

Increase the timeout for complex tasks:

```env
CLAUDE_TIMEOUT_MS=900000
```

Or increase the max turns:

```env
CLAUDE_MAX_TURNS=100
```

### Task stuck in "in progress"

If clawdup crashes or is killed while processing a task, the task may be left as "in progress". On the next startup, clawdup automatically detects and recovers orphaned tasks:
- If a branch with commits exists, it pushes and creates a PR
- If a branch exists but has no commits, it re-processes the task
- If no branch exists, it resets the task to "to do"

You can also manually move the task back to "to do" in ClickUp to retry it.

### Follow-up tasks not being created

If Claude discovers follow-up work during a task, it creates a `.clawdup.todo.json` file. clawdup automatically processes this file after each task, creating new ClickUp tasks from its contents. If this isn't working, check the logs with `LOG_LEVEL=debug`.

---

## FAQ

### Can I use this with any project?

Yes. clawdup works with any project in a GitHub repository — JavaScript, Python, Rust, Go, whatever. It doesn't assume any specific language, framework, or tooling. Claude Code adapts to your codebase.

### Does it work with private repositories?

Absolutely. As long as:
- Your `gh` CLI is authenticated with access to the repo
- Git is configured with push access (SSH key or credentials)

### Can multiple people run clawdup on the same list?

Not recommended. clawdup runs as a single instance per list. If two instances pick up the same task, they'll create conflicting branches and PRs.

### How do I retry a failed task?

Move the task back to "to do" in ClickUp. clawdup will pick it up on the next poll. If it was moved to "require input", add the requested information first.

### Can I customize which tools Claude Code can use?

Yes, via `clawdup.config.mjs`:

```js
export default {
  claudeArgs: ["--allowedTools", "Bash,Read,Write,Edit,Glob,Grep"],
};
```

By default, clawdup allows: Edit, Write, Read, Glob, Grep, and Bash.

### How do I see what Claude is doing?

clawdup streams Claude's output to the terminal in real time. You'll see text output and tool usage (file reads, edits, bash commands) as they happen. For more detail, set `LOG_LEVEL=debug` in your `.clawdup.env`.

### What merge strategy does clawdup use?

Squash merge. This keeps your main branch history clean with one commit per task. The source branch is automatically deleted after merging.

### Can I use a different base branch?

Yes, set `BASE_BRANCH` in your `.clawdup.env`:

```env
BASE_BRANCH=develop
```

### What happens if I stop clawdup mid-task?

`Ctrl+C` triggers a graceful shutdown — clawdup finishes the current task before exiting. If the process is killed forcefully (e.g., `kill -9`), the task will remain "in progress". On the next startup, clawdup detects and recovers orphaned tasks automatically.
