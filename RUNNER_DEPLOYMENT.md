# Single-Runner Deployment Guide

Clawdup is designed as a **single-runner-per-repo** system. Only one Clawdup process should be active for a given repository and ClickUp configuration at any time. This document explains why, how the constraint is enforced, and how to deploy and operate the runner safely.

> For architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md). For configuration reference, see [CONFIGURATION.md](CONFIGURATION.md). For failure recovery, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Table of Contents

1. [Why Single-Runner?](#why-single-runner)
2. [What Goes Wrong With Multiple Instances](#what-goes-wrong-with-multiple-instances)
3. [How Locking Works](#how-locking-works)
4. [Relaunch and Lock Lifecycle](#relaunch-and-lock-lifecycle)
5. [Deployment Patterns](#deployment-patterns)
6. [Operational Tips](#operational-tips)

---

## Why Single-Runner?

Clawdup operates directly on the git working tree — checking out branches, running Claude Code, committing, and pushing. A git repository has a single working tree, so concurrent processes would clobber each other's checkouts, stage conflicting files, and produce corrupted commits.

Beyond git, Clawdup manages task state in ClickUp (moving tasks between statuses, posting comments). Two runners polling the same list would race to claim the same task, producing duplicate branches, duplicate PRs, and conflicting status transitions.

The single-runner model guarantees:

- **One branch per task** — no duplicate or divergent branches for the same ClickUp task.
- **Consistent status transitions** — tasks move through statuses in a predictable sequence without races.
- **Clean git state** — the working tree is always in a known state between tasks.
- **Predictable ClickUp comments** — exactly one automation comment thread per task, not duplicated noise.

---

## What Goes Wrong With Multiple Instances

If two Clawdup processes run against the same repo and ClickUp list simultaneously:

| Problem | Description |
|---------|-------------|
| **Duplicate branches** | Both runners create a branch for the same task, leading to conflicting implementations |
| **Conflicting git operations** | One runner's `git checkout` destroys another's uncommitted work |
| **Race on task status** | Both pick up the same TODO task; one's status update overwrites the other's |
| **Duplicate PRs** | Two PRs opened for the same task, confusing reviewers |
| **Noisy comments** | Both runners post automation comments on the same task |
| **Merge conflicts** | If both somehow produce PRs, merging one immediately conflicts with the other |

---

## How Locking Works

Clawdup enforces the single-runner constraint with a lock file: `.clawdup.lock` in the project root (`PROJECT_ROOT`).

### Lock File Contents

The lock file is a JSON file recording the owning process:

```json
{
  "pid": 12345,
  "startedAt": "2026-02-25T10:30:00.000Z"
}
```

### Acquisition

At startup, `acquireLock()` in `runner.ts`:

1. Checks if `.clawdup.lock` exists.
2. If it exists, reads the PID and checks whether that process is still alive (`process.kill(pid, 0)`).
3. If the process is alive — exits with an error: `Another Clawdup instance is already running (PID ...).`
4. If the process is dead — logs a warning, removes the stale lock, and proceeds.
5. If the file is corrupted (invalid JSON) — removes it and proceeds.
6. Writes a new lock file with the current PID and timestamp.

### Release

`releaseLock()` deletes the lock file, but only if the current process owns it (PID matches). It is called:

- On `SIGINT` (Ctrl+C)
- On `SIGTERM` (e.g., `kill <pid>`, systemd stop)
- On process exit (via the `process.on("exit")` handler)
- Before returning from the runner when a relaunch is triggered

### Preflight Validation

Before the main runner starts, `runPreflightChecks()` in `preflight.ts` performs an independent lock file check with more sophisticated stale-lock detection:

- **Dead PID** — lock removed automatically.
- **PID reuse** (process alive but not a node/clawdup process) — lock removed automatically. On Linux, this is verified by reading `/proc/{pid}/cmdline`.
- **Self-owned** (lock PID matches current process) — treated as valid.
- **Live Clawdup process** — preflight fails with a clear message and suggested fix.
- **Corrupted file** — removed automatically.

### Dry-Run Mode

In dry-run mode (`--dry-run`), the lock is **not acquired**, so you can safely run `clawdup --check` or dry-run alongside a live runner.

---

## Relaunch and Lock Lifecycle

Clawdup has a two-layer process architecture that supports self-updating without losing the single-runner guarantee.

### Process Layers

```
bin/clawdup.js          (outer wrapper — persistent)
  └─ dist/cli.js        (inner runner — replaced on relaunch)
```

The outer wrapper (`bin/clawdup.js`) spawns the inner runner and watches for exit code **75**, which signals "please restart me." On any other exit code, the wrapper exits normally.

### Relaunch Triggers

1. **After a PR merge** — when `processApprovedTask()` merges a PR, it sets a `shouldRelaunchAfterMerge` flag. On the next idle poll cycle, the runner syncs the base branch and exits with code 75.
2. **Relaunch interval** — if `RELAUNCH_INTERVAL_MS` (default: 10 minutes) has elapsed and the runner is idle, it relaunches to pick up any code changes.

### Lock During Relaunch

The relaunch sequence carefully manages the lock:

```
Runner detects relaunch needed (idle, not processing)
  ├─ Sync base branch (git fetch + reset)
  ├─ releaseLock()                          ← lock released
  ├─ Return true to cli.ts
  │
  └─ cli.ts:
     ├─ npm run build                       ← recompile TypeScript
     ├─ process.exit(75)
     │
     └─ bin/clawdup.js detects code 75
        └─ Respawn dist/cli.js
           └─ acquireLock()                 ← new lock acquired
```

The lock is released before exit and re-acquired by the fresh process. The window without a lock is brief (the build + respawn time), which is acceptable since no task processing occurs during that window.

---

## Deployment Patterns

### Pattern 1: systemd Service (Recommended for Production)

Create a systemd unit file that runs Clawdup as a long-lived service:

```ini
# /etc/systemd/system/clawdup.service
[Unit]
Description=Clawdup automation runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/my-project
ExecStart=/usr/bin/npx clawdup
Restart=on-failure
RestartSec=30
Environment=NODE_ENV=production

# Ensure only one instance
# (Clawdup's own lock file also enforces this, but systemd adds a second layer)

[Install]
WantedBy=multi-user.target
```

**Usage:**

```bash
sudo systemctl enable clawdup      # start on boot
sudo systemctl start clawdup       # start now
sudo systemctl stop clawdup        # graceful stop (sends SIGTERM)
sudo systemctl status clawdup      # check status
journalctl -u clawdup -f           # follow logs
```

systemd's `Restart=on-failure` handles crashes, while Clawdup's own exit-code-75 relaunch loop handles planned restarts. The two mechanisms complement each other.

### Pattern 2: tmux / screen Session (Development / Small Teams)

Run Clawdup in a persistent terminal session:

```bash
# Start a new tmux session
tmux new-session -d -s clawdup 'cd /home/deploy/my-project && npx clawdup'

# Attach to see output
tmux attach -t clawdup

# Detach: Ctrl+B, then D

# Stop gracefully
tmux send-keys -t clawdup C-c
```

This is suitable for development or small-team setups where you want to watch the runner's output interactively.

### Pattern 3: GitHub Actions Self-Hosted Runner

Run Clawdup on a self-hosted GitHub Actions runner with a scheduled workflow:

```yaml
# .github/workflows/clawdup.yml
name: Clawdup Runner
on:
  workflow_dispatch:    # manual trigger
  schedule:
    - cron: '0 */1 * * *'  # hourly restart as fallback

jobs:
  run:
    runs-on: self-hosted
    timeout-minutes: 55  # leave room before next cron
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: npm run build
      - run: npx clawdup
        env:
          CLICKUP_API_TOKEN: ${{ secrets.CLICKUP_API_TOKEN }}
          CLICKUP_LIST_ID: ${{ secrets.CLICKUP_LIST_ID }}
          RELAUNCH_INTERVAL_MS: "0"  # disable relaunch; cron handles restarts
```

**Important:** Use `RELAUNCH_INTERVAL_MS=0` since the CI environment handles restarts via the cron schedule. Each run is a fresh checkout, so stale locks are not an issue.

### Monorepo: Multiple Runners

In a monorepo with per-package ClickUp lists, you can run one Clawdup instance per package — each operates in its own `PROJECT_ROOT` and creates its own `.clawdup.lock`:

```bash
# Terminal 1 (or systemd unit 1)
cd packages/frontend && npx clawdup

# Terminal 2 (or systemd unit 2)
cd packages/backend && npx clawdup
```

This is safe because each runner:
- Has its own `.clawdup.lock` in its package directory.
- Polls a different ClickUp list.
- Creates branches with distinct task IDs.

However, both share the same git working tree at the repo root, so **be cautious** — concurrent git operations from different package runners can still interfere. For monorepo setups, consider running packages sequentially or using separate git worktrees.

---

## Operational Tips

### Checking Runner Status

```bash
# Check if a lock file exists and who owns it
cat .clawdup.lock

# Verify the process is actually running
ps -p $(jq -r .pid .clawdup.lock) -o pid,cmd

# Validate configuration without starting
clawdup --check
```

### Stopping the Runner Gracefully

Send `SIGTERM` or `SIGINT` to the runner process. Clawdup will:
1. Set `isShuttingDown = true`.
2. If a task is being processed, wait for it to complete.
3. Release the lock file.
4. Exit cleanly.

```bash
# If running in foreground: Ctrl+C

# If running as a service:
sudo systemctl stop clawdup

# If you know the PID:
kill $(jq -r .pid .clawdup.lock)
```

**Do not use `kill -9`** — this skips signal handlers and leaves a stale lock file behind.

### Dealing With Stale Locks

A stale lock occurs when the runner process dies without cleaning up (e.g., `kill -9`, OOM kill, machine crash). Clawdup handles this automatically in most cases:

1. **Preflight auto-cleanup** — when you start a new runner, preflight checks detect dead PIDs and remove the stale lock automatically.
2. **Manual removal** — if auto-cleanup doesn't work (e.g., PID was reused by another node process):
   ```bash
   # Verify the lock holder is not actually running clawdup
   ps -p $(jq -r .pid .clawdup.lock) -o pid,cmd

   # If it's not clawdup, remove the lock
   rm .clawdup.lock
   ```

### Restarting After a Crash

If the runner crashes:

1. Check for orphaned "in progress" tasks in ClickUp — the runner recovers these automatically on restart.
2. Simply restart the runner. It will:
   - Detect and clean any stale lock.
   - Clean the git working tree.
   - Recover orphaned in-progress tasks.
   - Resume polling.

### Verifying Single-Runner Behavior

To confirm only one instance is running:

```bash
# Check for clawdup processes
pgrep -af clawdup

# Check the lock file
cat .clawdup.lock 2>/dev/null || echo "No lock file (runner not active)"
```

---

## Further Reading

- [Architecture & State Flow](ARCHITECTURE.md) — full runner lifecycle, relaunch flow, and concurrency model
- [Configuration Reference](CONFIGURATION.md) — `POLL_INTERVAL_MS`, `RELAUNCH_INTERVAL_MS`, and other relevant settings
- [Troubleshooting Guide](TROUBLESHOOTING.md) — recovery procedures for common failures including lock-related issues
