# Clawdup Architecture & State Flow

This document provides an authoritative overview of how Clawdup works — how it discovers tasks, sequences git operations, manages status transitions, and handles restarts.

> For setup instructions, see [GUIDE.md](GUIDE.md). For configuration reference, see [CONFIGURATION.md](CONFIGURATION.md). For failure recovery, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). For task dependency handling, see [DEPENDENCIES.md](DEPENDENCIES.md).

---

## Table of Contents

1. [Component Overview](#component-overview)
2. [Task Discovery & Selection](#task-discovery--selection)
3. [Task Status State Machine](#task-status-state-machine)
4. [Core Processing Loop](#core-processing-loop)
5. [Three Processing Paths](#three-processing-paths)
6. [Git Operations Sequence](#git-operations-sequence)
7. [Claude Code Integration](#claude-code-integration)
8. [Relaunch & Restart Behavior](#relaunch--restart-behavior)
9. [Concurrency & Locking](#concurrency--locking)
10. [Security Model](#security-model)
11. [Configuration Cascade](#configuration-cascade)

---

## Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        bin/clawdup.js                        │
│              (Process wrapper, relaunch loop)                 │
│          Detects exit code 75 → respawns process             │
└────────────────────────┬────────────────────────────────────┘
                         │ spawns
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                         cli.ts                               │
│   Argument parsing: --check, --setup, --init, --once, etc.   │
│   Calls startRunner() or runSingleTask()                     │
│   Triggers rebuild + exit(75) when relaunch is needed        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                        runner.ts                             │
│                  (Main orchestration engine)                  │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ pollForTasks │  │ processTask  │  │ processApprovedTask│  │
│  │             │  │              │  │                    │  │
│  │ Picks next  │  │ New task     │  │ Merge approved PR  │  │
│  │ TODO task   │  │ pipeline     │  │                    │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬───────────┘  │
│         │                │                    │              │
│         │         ┌──────┴───────┐            │              │
│         │         │processReturn-│            │              │
│         │         │  ingTask     │            │              │
│         │         │ Review redo  │            │              │
│         │         └──────┬───────┘            │              │
│         │                │                    │              │
└─────────┼────────────────┼────────────────────┼──────────────┘
          │                │                    │
    ┌─────▼─────┐   ┌─────▼──────┐   ┌────────▼────────┐
    │clickup-api│   │claude-worker│   │    git-ops      │
    │           │   │            │   │                 │
    │ Task CRUD │   │ Prompt     │   │ Branch, commit, │
    │ Status    │   │ building   │   │ push, PR ops    │
    │ Comments  │   │ JSONL parse│   │ Conflict resolve│
    │ Security  │   │ Safety scan│   │ via git + gh CLI│
    └─────┬─────┘   └─────┬──────┘   └────────┬────────┘
          │                │                    │
          ▼                ▼                    ▼
    ClickUp API v2   Claude Code CLI      git + gh CLI
```

**Key modules:**

| Module | File | Responsibility |
|--------|------|----------------|
| **CLI** | `cli.ts` | Argument parsing, mode dispatch, rebuild-and-relaunch |
| **Runner** | `runner.ts` | Orchestration engine — task lifecycle, polling loop, error handling |
| **ClickUp API** | `clickup-api.ts` | ClickUp REST client, task formatting, injection detection |
| **Git Ops** | `git-ops.ts` | Git and GitHub CLI operations (branch, commit, push, PR) |
| **Claude Worker** | `claude-worker.ts` | Prompt building, Claude invocation, output parsing, safety scanning |
| **Config** | `config.ts` | Configuration loading and validation |
| **Logger** | `logger.ts` | Structured logging (human-readable or JSON) |
| **Setup** | `setup.ts` | Interactive setup wizard |
| **Types** | `types.ts` | TypeScript interfaces |

All modules use **zero runtime dependencies** — only Node.js built-ins and external CLI tools (`git`, `gh`, `claude`).

---

## Task Discovery & Selection

Clawdup supports two task source modes:

### List Mode (`CLICKUP_LIST_ID`)

Queries `GET /list/{id}/task?statuses[]={status}&include_subtasks=true` to find tasks in a specific ClickUp list.

### Parent Task Mode (`CLICKUP_PARENT_TASK_ID`)

Fetches a parent task with `?include_subtasks=true`, then filters subtasks by status. Full details are fetched for each matching subtask.

### Selection Priority

Tasks are sorted by:
1. **Priority** (ascending ID: 1=urgent, 2=high, 3=normal, 4=low, 99=none)
2. **Creation date** (oldest first, for FIFO within same priority)

The first task in the sorted list that hasn't been processed in the current session is selected. Tasks with unresolved dependencies are skipped — see [DEPENDENCIES.md](DEPENDENCIES.md) for details.

### Per-Session Deduplication

A `processedTaskIds` set tracks tasks already worked on. This prevents re-processing a task that was just moved to "in review" before the ClickUp API reflects the status change. The set resets on each runner restart.

---

## Task Status State Machine

```
                    ┌──────────────────────────────────┐
                    │                                  │
                    ▼                                  │
              ┌──────────┐                             │
     ┌───────>│  TO DO   │<──────────────────┐         │
     │        └────┬─────┘                   │         │
     │             │ Runner picks task       │         │
     │             ▼                         │         │
     │     ┌──────────────┐          ┌───────┴───────┐ │
     │     │ IN PROGRESS  │────────> │REQUIRE INPUT  │ │
     │     └──┬───┬───┬───┘          └───────────────┘ │
     │        │   │   │   Needs input /                │
     │        │   │   │   no changes                   │
     │        │   │   │                                │
     │        │   │   └──────────> ┌─────────┐         │
     │        │   │    Error       │ BLOCKED │─────────┘
     │        │   │                └─────────┘  (manual retry)
     │        │   │
     │        │   │ Success
     │        │   ▼
     │        │  ┌───────────┐
     │        │  │ IN REVIEW │
     │        │  └─────┬─────┘
     │        │        │ Reviewer moves to "approved"
     │        │        ▼
     │        │  ┌───────────┐
     │        │  │ APPROVED  │──────> ┌─────────┐
     │        │  └─────┬─────┘  Fail  │ BLOCKED │
     │        │        │              └─────────┘
     │        │        │ Merge PR
     │        │        ▼
     │        │  ┌───────────┐
     │        └─>│ COMPLETED │  (auto-approve skips IN REVIEW)
     │           └───────────┘
     │
     │  (review feedback → task moved back to TODO)
     └───────────────────────────────────────────
```

### What automation does in each state

| Status | Trigger | Automation Action |
|--------|---------|-------------------|
| **TO DO** | Task created or moved back | Runner picks it up on next poll cycle |
| **IN PROGRESS** | Runner starts processing | Creates branch, runs Claude, commits/pushes, creates PR |
| **IN REVIEW** | Successful PR creation | Waits for human review. If task is moved back to TODO, collects review feedback and reruns Claude |
| **APPROVED** | Reviewer moves task here | Runner detects it on next poll, squash-merges the PR, deletes branch, moves to COMPLETED |
| **REQUIRE INPUT** | Claude needs clarification or no changes produced | Posts explanation comment, closes draft PR. Human adds info and moves back to TODO |
| **BLOCKED** | Error during processing or merge | Posts error comment. Human fixes issue and moves back to TODO |
| **COMPLETED** | PR merged successfully | Terminal state — no further automation |

---

## Core Processing Loop

### Startup Sequence

```
startRunner()
  │
  ├─ 1. Reset module state (processedTaskIds, flags)
  ├─ 2. Acquire lock file (.clawdup.lock)
  ├─ 3. Load & validate configuration
  ├─ 4. Validate ClickUp statuses against list
  ├─ 5. Ensure clean git state (abort merges, reset, clean)
  ├─ 6. Sync base branch (fetch + reset to origin)
  ├─ 7. Prune stale local branches
  ├─ 8. Recover orphaned in-progress tasks
  │     └─ For each task stuck in IN_PROGRESS:
  │        ├─ Has branch with commits → push, create/find PR, move to IN_REVIEW
  │        ├─ Has empty branch → delete, reprocess
  │        └─ No branch → reset to TODO
  │
  └─ 9. Enter polling loop
         │
         ├─ Poll for APPROVED tasks → processApprovedTask()
         ├─ Poll for TODO tasks → processTask() or processReturningTask()
         ├─ Check relaunch interval → exit if elapsed and idle
         └─ Sleep POLL_INTERVAL_MS, repeat
```

### Single Poll Cycle

```
pollForTasks()
  │
  ├─ 1. Fetch tasks with APPROVED status
  │     └─ For each: processApprovedTask() (merge PR)
  │
  ├─ 2. Fetch tasks with TODO status
  │     └─ Filter out already-processed tasks (processedTaskIds)
  │     └─ Check dependencies for each candidate (skip if unresolved)
  │     └─ Pick first eligible task (highest priority, oldest)
  │           │
  │           ├─ Has existing PR URL in comments?
  │           │   └─ YES → processReturningTask() (review redo)
  │           │   └─ NO  → processTask() (new task)
  │           │
  │           └─ Add to processedTaskIds
  │
  └─ 3. Return (sleep until next cycle)
```

---

## Three Processing Paths

### Path 1: New Task (`processTask`)

For tasks with no existing branch or PR.

```
processTask(task)
  │
  ├─ 1. Move task to IN_PROGRESS
  ├─ 2. Create feature branch (clickup/CU-{id}-{slug})
  │     └─ Syncs base branch first, checks for existing branch
  ├─ 3. Check for existing PR on this branch
  │     └─ If already merged → mark COMPLETED, return
  ├─ 4. If no PR: create empty commit + push + create draft PR
  ├─ 5. Comment on ClickUp task with PR link
  ├─ 6. Save HEAD hash (to detect if Claude commits)
  ├─ 7. Format task for Claude (with security sanitization)
  ├─ 8. Run Claude Code
  ├─ 9. Process .clawdup.todo.json (follow-up tasks)
  ├─ 10. Handle result:
  │      ├─ Needs input → notify, REQUIRE_INPUT, close PR
  │      ├─ Error → push partial changes if any, BLOCKED
  │      ├─ No changes → notify, REQUIRE_INPUT, close PR
  │      └─ Success → commit (fallback), push, update PR, mark ready
  ├─ 11. If AUTO_APPROVE: squash-merge immediately → COMPLETED
  │      Else: move to IN_REVIEW, add summary comment
  │
  └─ Finally: return to base branch, process todo file
```

### Path 2: Returning Task (`processReturningTask`)

For tasks moved back to TODO that already have a PR (review feedback cycle).

```
processReturningTask(task, prUrl)
  │
  ├─ 1. Move task to IN_PROGRESS
  ├─ 2. Check out existing branch
  ├─ 3. Merge base branch into feature branch
  │     └─ If conflicts: use Claude to resolve, or abort → BLOCKED
  ├─ 4. Collect review feedback from 3 sources:
  │     ├─ GitHub PR reviews
  │     ├─ GitHub inline code comments
  │     └─ New ClickUp comments (since last automation comment)
  ├─ 5. Run Claude with review-specific prompt + feedback
  ├─ 6. Handle result (same as new task path)
  │
  └─ Finally: return to base branch
```

### Path 3: Approved Task (`processApprovedTask`)

For tasks moved to APPROVED status — merge the PR.

```
processApprovedTask(task)
  │
  ├─ 1. Find PR URL from task comments
  ├─ 2. Check PR state (must be "open")
  ├─ 3. Check mergeability
  │     └─ CONFLICTING → checkout branch, merge base, Claude resolves
  │        └─ Resolution fails → BLOCKED
  ├─ 4. Squash-merge PR (--admin to bypass protections)
  ├─ 5. Delete branch, move to COMPLETED
  ├─ 6. Set shouldRelaunchAfterMerge flag
  │
  └─ On failure: BLOCKED with error comment
```

---

## Git Operations Sequence

### Branch Lifecycle

```
1. SYNC BASE        git fetch --all --prune
                    git checkout -f {BASE_BRANCH}
                    git reset --hard origin/{BASE_BRANCH}

2. CREATE BRANCH    git checkout -b clickup/CU-{id}-{slug}
   (or checkout     git checkout -f clickup/CU-{id}-{slug}
    existing)       git reset --hard origin/clickup/CU-{id}-{slug}

3. EMPTY COMMIT     git commit --allow-empty -m "[CU-{id}] Starting work..."
   (for early PR)

4. PUSH             git push --set-upstream origin clickup/CU-{id}-{slug}
                    (retries with exponential backoff: 2s, 4s, 8s, 16s)

5. CLAUDE WORKS     Claude makes changes, may commit via Bash tool

6. FALLBACK COMMIT  If Claude didn't commit:
                    git add -A && git commit -m "[CU-{id}] {title}"

7. PUSH CHANGES     git push (with retry)

8. RETURN TO BASE   git checkout -f {BASE_BRANCH}
```

### Conflict Resolution Flow

```
mergeBaseBranch()
  │
  ├─ git merge origin/{BASE_BRANCH} --no-edit
  │
  ├─ Clean merge? → done
  │
  └─ Conflicts detected?
     ├─ Get conflicted files list
     ├─ Run Claude with conflict-resolution prompt
     │   └─ Claude edits files, removes conflict markers
     ├─ git add -A && git commit --no-edit
     │
     └─ Resolution failed?
        └─ git merge --abort → task moves to BLOCKED
```

### State Recovery

At startup, `ensureCleanState()` handles broken git state:
```
git merge --abort     (if merge in progress)
git rebase --abort    (if rebase in progress)
git cherry-pick --abort (if cherry-pick in progress)
git reset --hard HEAD
git clean -fd
```

---

## Claude Code Integration

### Prompt Construction

The system prompt sent to Claude is built in layers:

```
┌─────────────────────────────────────────┐
│ 1. Base automation rules                 │
│    - Read task, follow conventions       │
│    - Commit format: [CU-{id}] ...       │
│    - Follow-up tasks: .clawdup.todo.json │
│    - Don't push or create branches       │
├─────────────────────────────────────────┤
│ 2. Security block                        │
│    - Treat <task> content as untrusted   │
│    - Refuse contradicting instructions   │
│    - Refuse destructive commands         │
├─────────────────────────────────────────┤
│ 3. CLAUDE.md (project context)           │
│    - Checked in PROJECT_ROOT, then       │
│      GIT_ROOT for monorepo support       │
├─────────────────────────────────────────┤
│ 4. User config prompt                    │
│    - From clawdup.config.mjs             │
├─────────────────────────────────────────┤
│ 5. Task content (in <task> tags)         │
│    - Sanitized (</task> escaped)         │
│    - Title, description, checklists,     │
│      subtasks, comments                  │
└─────────────────────────────────────────┘
```

### Invocation Modes

| Mode | Flag | Behavior |
|------|------|----------|
| **Non-interactive** | (default) | Claude runs with `-p` flag, output streamed as JSONL |
| **Interactive** | `--interactive` | Claude runs with `stdio: "inherit"`, user interacts directly |
| **Review feedback** | (automatic) | Same as non-interactive but with review-specific prompt |
| **Conflict resolution** | (automatic) | Specialized prompt for resolving merge conflicts |

### Output Processing

Claude's JSONL stream is parsed for:
- **Text deltas** — displayed incrementally to the terminal
- **Tool use** — tool name and key parameters logged
- **Result event** — final text, cost summary, turn count
- **Needs-input detection** — 11 marker phrases scanned in output
- **Safety scanning** — 6 regex patterns for credential access, exfiltration, destructive commands

---

## Relaunch & Restart Behavior

Clawdup has a two-layer process architecture that enables self-updating:

```
bin/clawdup.js (outer wrapper)
  │
  ├─ Spawns dist/cli.js as child process
  ├─ Forwards SIGINT/SIGTERM to child
  │
  ├─ Child exits with code 75?
  │   └─ YES → respawn (loop back to start)
  │   └─ NO  → exit with child's exit code
  │
  └─ This enables: merge PR → rebuild → restart with new code
```

### Relaunch Triggers

1. **After PR merge** — When `processApprovedTask()` or `autoApproveAndMerge()` completes, the `shouldRelaunchAfterMerge` flag is set. The polling loop detects this, syncs the base branch, and returns `true` to cli.ts.

2. **Relaunch interval** — If `RELAUNCH_INTERVAL_MS` has elapsed since startup and the runner is idle (not processing a task), the runner syncs the base branch and triggers a relaunch.

### Relaunch Sequence

```
Runner detects relaunch needed
  │
  ├─ Sync base branch (get latest code)
  ├─ Return true to cli.ts
  │
  └─ cli.ts:
     ├─ Run "npm run build" (recompile TypeScript)
     ├─ Exit with code 75
     │
     └─ bin/clawdup.js detects code 75
        └─ Respawn dist/cli.js (fresh process with new code)
```

This ensures the runner always operates on the latest merged code without manual intervention.

---

## Concurrency & Locking

### Lock File (`.clawdup.lock`)

Prevents multiple Clawdup instances from running simultaneously in the same project directory.

- **Acquire:** Writes PID to `.clawdup.lock` at startup. If file exists, checks if the PID is still alive via `process.kill(pid, 0)`. Stale locks from crashed processes are automatically cleared.
- **Release:** Deletes the lock file on shutdown (SIGINT/SIGTERM handlers + finally blocks).

### Signal Handling

- **SIGINT / SIGTERM:** Sets `isShuttingDown = true`. If a task is being processed (`isProcessing = true`), the current task completes before shutdown. Otherwise, exits immediately after cleanup.

### Single-Task Processing

Only one task is processed at a time. The `isProcessing` flag prevents the polling loop from picking up new tasks while one is in flight.

---

## Security Model

Clawdup treats ClickUp task content as **untrusted input** (it may contain prompt injection attempts). Eight defense layers are applied:

| Layer | Location | Defense |
|-------|----------|---------|
| 1. System prompt hardening | `claude-worker.ts` | Explicit instructions to ignore manipulation in task content |
| 2. Boundary markers | `claude-worker.ts` | Task wrapped in `<task>` tags; `</task>` in content escaped |
| 3. Injection detection | `clickup-api.ts` | 10 regex patterns scan task content; warnings logged |
| 4. Content length limits | `clickup-api.ts` | Description: 5000 chars, comments: 2000 chars each, max 10 comments |
| 5. Input validation | `clickup-api.ts` | Task IDs: alphanumeric only, max 30 chars; slugs sanitized |
| 6. CLI arg blocking | `claude-worker.ts` | `--dangerously*`, `--no-verify`, `--skip-permissions` rejected |
| 7. Tool restrictions | `claude-worker.ts` | Claude restricted to: `Edit, Write, Read, Glob, Grep, Bash` |
| 8. Output scanning | `claude-worker.ts` | Post-execution scan for credential access, exfiltration, destructive commands |

For the full security model, see [PROMPT_SAFETY.md](PROMPT_SAFETY.md).

---

## Configuration Cascade

Settings are resolved from multiple sources with clear precedence:

```
┌─────────────────────────┐  Highest priority
│  Environment variables   │  (already set in process.env)
├─────────────────────────┤
│  .clawdup.env file       │  (only sets values NOT in env)
│  (or .env.clickup)       │
├─────────────────────────┤
│  clawdup.config.mjs      │  (prompt and claudeArgs only)
├─────────────────────────┤
│  Built-in defaults       │  Lowest priority
└─────────────────────────┘
```

### Monorepo Awareness

Two root paths are tracked:
- **`PROJECT_ROOT`** = `process.cwd()` — where config files are resolved
- **`GIT_ROOT`** = `git rev-parse --show-toplevel` — where git operations run

This allows each workspace package to have its own ClickUp list and Claude instructions while sharing a single git repository.

For the full configuration reference, see [CONFIGURATION.md](CONFIGURATION.md).
