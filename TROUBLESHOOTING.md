# Troubleshooting & Recovery Guide

This guide covers common Clawdup automation failures, how to diagnose them, and how to recover.

> For a detailed understanding of how the pipeline works and how status transitions are managed, see the **[Architecture & State Flow](ARCHITECTURE.md)** document.

## Overview

Clawdup automates the pipeline from ClickUp task to GitHub PR. It polls for tasks, creates branches, runs Claude Code, commits/pushes, and manages PR lifecycle. Failures can occur at any stage — ClickUp API calls, git operations, Claude execution, or GitHub CLI commands.

When something goes wrong, Clawdup typically:
1. Posts a comment on the ClickUp task describing the error
2. Moves the task to **"blocked"** or **"require input"**
3. Cleans up the branch/PR if no useful work was produced
4. Returns to the base branch and continues polling

## Common Scenarios

### Branch Already Exists

**Symptoms:**
- Log message: `Branch already exists for task {id}: {branch}. Checking it out.`
- This is **not an error** — Clawdup handles this automatically

**What happens:**
When Clawdup creates a branch for a task, it first checks for an existing local or remote branch matching the pattern `{prefix}/CU-{task-id}-*`. If found, it checks out the existing branch instead of creating a new one.

**When it can cause issues:**
- The existing branch has stale or conflicting changes from a previous failed run
- The branch was manually modified and is in an unexpected state

**Recovery:**
1. Delete the stale branch locally and remotely:
   ```bash
   git branch -D clickup/CU-{task-id}-{slug}
   git push origin --delete clickup/CU-{task-id}-{slug}
   ```
2. Close any associated PR on GitHub
3. Move the task back to **"to do"** in ClickUp to retry

**Prevention:**
- Let Clawdup manage branch lifecycle — avoid manually modifying task branches
- If a task is stuck in "blocked", resolve the root cause before moving it back to "to do"

---

### Merge Conflicts

**Symptoms:**
- ClickUp comment: `🔀 PR has merge conflicts with {base}. Attempting automatic resolution using Claude.`
- Task moved to **"blocked"** with a comment listing conflicted files
- PR shows "This branch has conflicts that must be resolved"

**What happens:**
Clawdup detects merge conflicts in two situations:
1. **During approval merge** — when a PR is approved but the base branch has diverged
2. **During review/retry** — when checking out an existing branch and merging the latest base

Clawdup attempts automatic resolution using Claude Code. If Claude cannot resolve the conflicts, the task is moved to "blocked".

**Recovery:**
1. Check out the task branch locally:
   ```bash
   git checkout clickup/CU-{task-id}-{slug}
   ```
2. Merge the base branch and resolve conflicts manually:
   ```bash
   git merge origin/main
   # Resolve conflicts in your editor
   git add -A && git commit --no-edit
   git push
   ```
3. Move the task back to **"approved"** (if it was ready to merge) or **"in review"**

**Prevention:**
- Merge or close completed PRs promptly to reduce divergence from main
- Keep tasks small and focused to minimize conflict surface area
- Approve and merge PRs soon after review to reduce the window for conflicts

---

### Blocked Tasks (Automation Error)

**Symptoms:**
- ClickUp comment: `❌ Automation encountered an error: {error message}`
- Task status changed to **"blocked"**
- PR may be closed or left as a draft

**Common causes:**
- **Git push failure** — network issues, authentication expired, or branch protection rules
- **GitHub CLI failure** — `gh` not authenticated, rate limiting, or API errors
- **Claude Code failure** — timeout, crash, or exit with non-zero code
- **ClickUp API error** — invalid token, rate limiting, or network issues

**Recovery:**
1. Read the error message in the ClickUp comment carefully
2. Fix the underlying issue (see specific sections below)
3. If the task has partial changes pushed to a PR, you can:
   - Continue manually from the branch
   - Or close the PR, delete the branch, and move the task to "to do" to retry
4. If no PR exists, simply move the task back to **"to do"**

---

### Claude Needs More Input

**Symptoms:**
- ClickUp comment: `🔍 Automation needs more information to complete this task: {reason}`
- Task moved to **"require input"**
- Draft PR closed and branch cleaned up

**What happens:**
Claude detected that the task description lacks enough information to proceed. This is triggered when Claude's output contains markers like `NEEDS_MORE_INFO:`, `I need more information`, or similar phrases.

**Recovery:**
1. Read Claude's explanation of what information is missing
2. Add the requested details to the task description or as a comment
3. Move the task back to **"to do"** to retry

**Prevention:**
- Write clear, specific task descriptions with acceptance criteria
- Include file paths or component names when relevant
- Use ClickUp checklists for multi-step requirements

---

### No Changes Produced

**Symptoms:**
- ClickUp comment: `⚠️ Automation completed but no code changes were produced.`
- Task moved to **"require input"**
- Draft PR closed

**Common causes:**
- The task was already implemented in the codebase
- The task description was not actionable (too vague or conceptual)
- Claude couldn't determine what code changes to make
- Claude made changes but then reverted them

**Recovery:**
1. Review the task description — is it specific enough for code changes?
2. Add more implementation details and move back to **"to do"**

---

### Partial Changes (Error After Some Work)

**Symptoms:**
- ClickUp comment: `⚠️ Automation encountered an error but made partial changes.`
- Task moved to **"blocked"**
- PR contains incomplete work

**What happens:**
Claude started working but encountered an error partway through. The partial changes were committed and pushed to preserve the work.

**Recovery:**
1. Review the partial changes in the PR
2. Either:
   - Complete the work manually on the branch
   - Move the task back to **"to do"** so Clawdup picks it up again (it will detect the existing branch and continue from where it left off)
3. Once complete, move to **"in review"** for human review

---

### Orphaned In-Progress Tasks

**Symptoms:**
- Tasks stuck in **"in progress"** after a Clawdup crash or restart
- Log message at startup: `Found {N} orphaned in-progress task(s). Recovering...`

**What happens:**
When Clawdup starts, it checks for tasks in "in progress" status. These indicate tasks that were being worked on when the process was interrupted. Clawdup recovers them automatically:
- If a branch exists with commits: pushes and creates/finds a PR, moves to "in review"
- If a branch exists but is empty: deletes it and re-processes the task
- If no branch exists: resets the task to "to do"

**Recovery (if automatic recovery fails):**
1. Check the task's ClickUp comments for error details
2. Manually inspect the branch state:
   ```bash
   git branch --list 'clickup/CU-{task-id}-*'
   git log clickup/CU-{task-id}-{slug} --oneline
   ```
3. Either clean up and retry, or complete the work manually

---

### Claude Code Timeout

**Symptoms:**
- Log message: `Claude Code timed out after {N}s`
- Task moved to **"blocked"**

**What happens:**
Claude Code took longer than the configured timeout (default: 10 minutes / 600,000ms).

**Recovery:**
1. If partial changes were pushed, review them in the PR
2. Consider breaking the task into smaller subtasks
3. Move back to **"to do"** to retry

**Prevention:**
- Increase `CLAUDE_TIMEOUT_MS` in `.clawdup.env` for complex tasks
- Increase `CLAUDE_MAX_TURNS` if Claude needs more iterations
- Write smaller, more focused tasks

---

### Prompt Injection Detection

**Symptoms:**
- Log warning: `Potential prompt injection detected in task {id}: {patterns}`
- Claude outputs `NEEDS_MORE_INFO: The task description does not contain a clear software development request.`

**What happens:**
Clawdup scans task content for known prompt injection patterns (e.g., "ignore previous instructions", "you are now", `</task>` tag attempts). When detected:
- A warning is logged
- The content is still processed but sanitized (closing `</task>` tags are escaped)
- Claude's system prompt includes instructions to ignore manipulation attempts

**Recovery:**
1. Review the task content for unintentional patterns that triggered detection
2. Rephrase the task description to avoid the flagged patterns
3. Move back to **"to do"**

**Note:** This is a safety feature. If a task legitimately contains phrases like "ignore previous" in its description (e.g., documenting prompt injection), consider rephrasing.

---

### Another Clawdup Instance Is Already Running

**Symptoms:**
- Error at startup: `Another Clawdup instance is already running (PID ..., started ...).`
- Clawdup exits immediately

**What happens:**
A `.clawdup.lock` file exists and its recorded PID is still a live process. This prevents concurrent instances from corrupting git state or racing on ClickUp tasks.

**Recovery:**
1. If another instance is legitimately running, wait for it to finish or stop it gracefully (`kill <pid>` or `Ctrl+C`).
2. If the lock is stale (e.g., after a crash or `kill -9`), remove it manually:
   ```bash
   # Verify the PID is not actually clawdup
   ps -p $(jq -r .pid .clawdup.lock) -o pid,cmd
   # If not clawdup, remove the lock
   rm .clawdup.lock
   ```
3. Restart Clawdup — preflight checks also auto-clean stale locks from dead PIDs.

For a complete guide on single-runner enforcement, deployment patterns, and operational tips, see **[Runner Deployment Guide](RUNNER_DEPLOYMENT.md)**.

---

### Working Tree Not Clean

**Symptoms:**
- Error at startup: `Working tree is not clean. Please commit or stash changes before running.`
- Clawdup exits immediately

**Recovery:**
1. Commit or stash your uncommitted changes:
   ```bash
   git stash
   # or
   git add -A && git commit -m "WIP"
   ```
2. Ensure you're on the base branch:
   ```bash
   git checkout main
   ```
3. Restart Clawdup

---

### ClickUp API Errors

**Symptoms:**
- Error: `ClickUp API error {status} {method} {path}: {response}`
- Polling fails silently or tasks aren't picked up

**Common causes:**
- **401 Unauthorized** — invalid or expired API token
- **429 Rate Limited** — too many requests (reduce `POLL_INTERVAL_MS`)
- **404 Not Found** — wrong list ID or task ID
- **Network errors** — connectivity issues

**Recovery:**
1. Verify your API token: `curl -H "Authorization: pk_xxx" https://api.clickup.com/api/v2/user`
2. Check that `CLICKUP_LIST_ID` or `CLICKUP_PARENT_TASK_ID` is correct
3. Run `clawdup --check` to validate the configuration

---

### GitHub CLI Errors

**Symptoms:**
- Error: `gh {command} failed: {message}`
- PR creation, merging, or status checks fail

**Common causes:**
- `gh` not authenticated — run `gh auth login`
- Repository not found — check git remote configuration
- PR creation fails due to branch protection rules
- Rate limiting on GitHub API

**Recovery:**
1. Verify `gh` is authenticated: `gh auth status`
2. Test PR operations manually: `gh pr list`
3. Check branch protection rules if merges fail

---

### Status Validation Failures

**Symptoms:**
- Warning at startup: `The following configured statuses are not in the ClickUp list: {statuses}`
- Tasks may not be picked up or status transitions may fail

**Recovery:**
1. Run `clawdup --statuses` to see the required statuses
2. Add the missing statuses to your ClickUp list (List Settings > Statuses)
3. Or configure custom status names in `.clawdup.env` (e.g., `STATUS_TODO=open`)
4. Run `clawdup --check` to verify

---

### PR State Mismatch

**Symptoms:**
- ClickUp comment: `⚠️ The associated PR is "{state}" (expected "open")`
- Task moved to **"blocked"** when trying to merge an approved task

**What happens:**
When a task is moved to "approved", Clawdup tries to merge its PR. If the PR was already closed or is in an unexpected state, the merge fails.

**Recovery:**
1. If the PR was closed accidentally, reopen it on GitHub
2. If the PR was already merged, move the task to **"complete"** manually
3. If a new PR is needed, close any existing PRs, delete the branch, and move the task to **"to do"**

---

## Where to Look in Logs

Clawdup logs all operations with timestamps and severity levels. Set `LOG_LEVEL=debug` in `.clawdup.env` for verbose output.

**Key log patterns to search for:**
- `[ERROR]` — failures that stopped a task
- `[WARN]` — non-fatal issues (partial changes, retries, injection detection)
- `git push` / `git checkout` — git operation details
- `ClickUp API` — API request/response details (at debug level)
- `Claude Code` — Claude invocation and output
- `PR created` / `PR merged` — PR lifecycle events

**Useful commands:**
```bash
# Run with debug logging
LOG_LEVEL=debug clawdup

# Check configuration
clawdup --check

# Process a single task for testing
clawdup --once {task-id}

# Interactive mode (see Claude's work in real-time)
clawdup --once {task-id} --interactive
```

## When to Escalate

Collect this information before asking for help:

1. **The error message** from the ClickUp task comment or terminal output
2. **The task ID** and URL
3. **The branch name** (if one was created)
4. **Git state**: `git status`, `git branch -a | grep CU-{task-id}`, `git log --oneline -5`
5. **Configuration**: output of `clawdup --check`
6. **Log output**: run with `LOG_LEVEL=debug` and capture the relevant output

**Situations that warrant escalation:**
- Clawdup crashes repeatedly on the same task after multiple retries
- Data inconsistency between ClickUp status and actual PR/branch state
- Claude consistently produces incorrect or harmful code changes
- Authentication issues that persist after re-authenticating
