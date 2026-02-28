# Task Dependencies

How Clawdup handles ClickUp task dependencies — when tasks are skipped, blocked, or worked on, and how to structure your board for sequenced work.

> For general setup, see [README.md](README.md). For architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md). For troubleshooting, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Table of Contents

1. [Concepts](#concepts)
2. [Runtime Behavior](#runtime-behavior)
3. [Logging](#logging)
4. [Usage Patterns & Examples](#usage-patterns--examples)
5. [Gotchas & Edge Cases](#gotchas--edge-cases)

---

## Concepts

### ClickUp Dependency Types

ClickUp supports two directions of dependency between tasks:

- **Waiting on** — "This task cannot start until that task is done." The current task depends on another task being completed first.
- **Blocking** — "That task cannot start until this task is done." The current task is a prerequisite for another task.

These are two sides of the same relationship. If Task B is **waiting on** Task A, then Task A is **blocking** Task B.

### What Clawup Considers "Unresolved"

A dependency is **unresolved** when the task being waited on has any status other than `complete` (the configured `STATUS_COMPLETED` value).

Clawup checks each "waiting on" dependency by fetching the dependency task's current status from ClickUp. If the status is not `complete`, the dependency is unresolved and the dependent task will not be picked up during polling.

If a dependency task cannot be reached (e.g., deleted, permissions error, API failure), it is treated as **unresolved** to err on the side of safety.

---

## Runtime Behavior

### Polling Loop (Continuous Mode)

When Clawup polls for TODO tasks, it evaluates each candidate in priority order:

1. Fetch all TODO tasks, sorted by priority (urgent first) then creation date (oldest first).
2. For each candidate, check its "waiting on" dependencies.
3. If **any** dependency is unresolved — skip the task and move to the next candidate.
4. The **first task with all dependencies resolved** (or no dependencies) is selected for processing.
5. If **all** TODO tasks are blocked by unresolved dependencies, none are processed and the runner waits for the next poll cycle.

Skipped tasks remain in TODO status. They are automatically reconsidered on every subsequent poll cycle. Once all their dependencies reach `complete`, they become eligible.

### Single-Task Mode (`--once`)

When you run a specific task with `clawdup --once <task-id>`:

1. Dependencies are checked and a **warning** is logged if any are unresolved.
2. The task is **processed anyway** — single-task mode does not block on dependencies.

This allows you to force-run a task for debugging or manual overrides, even if its dependencies are not yet complete.

### Error Handling

If the dependency check itself fails (e.g., ClickUp API is unreachable), the behavior depends on the mode:

- **Polling loop** — the candidate is skipped (treated as blocked, to be safe).
- **Single-task mode** — a warning is logged and the task proceeds.

---

## Logging

Dependency events are logged at `info` or `warn` level. Set `LOG_LEVEL=debug` for more detail.

| Scenario | Level | Example Message |
|----------|-------|-----------------|
| Task skipped (has unresolved deps) | `info` | `Task "Add auth" (abc123) will NOT be worked on — it has 2 unresolved dependency/ies that must be completed first: "Design auth flow" (xyz789, status: in progress), "Set up DB" (def456, status: to do)` |
| Some tasks skipped, another picked | `info` | `Skipped 2 task(s) due to unresolved dependencies. Picking next eligible task.` |
| All TODO tasks blocked | `info` | `3 TODO task(s) found but all 3 are blocked by unresolved dependencies — none will be worked on...` |
| Single-task mode with deps | `warn` | `Task has 1 unresolved dependency/ies: "Design auth flow" (xyz789, status: in progress). Proceeding anyway since this is a direct task run.` |
| Dependency check failed | `warn` | `Failed to check dependencies for task abc123: {error}. Processing anyway.` |

---

## Usage Patterns & Examples

### Sequential Multi-Step Work

Use dependencies to model a pipeline where each step must complete before the next begins.

**Example: Feature rollout**

```
Task A: "Design auth flow"         (no dependencies)
Task B: "Implement auth"           (waiting on A)
Task C: "Write auth docs"          (waiting on B)
```

Set all three tasks to TODO. Clawup will:
1. Pick up Task A first (no dependencies).
2. Skip Tasks B and C on every poll cycle until A is complete.
3. Once A is marked `complete` (PR merged), pick up Task B.
4. Once B is marked `complete`, pick up Task C.

**How to set this up in ClickUp:**
1. Create all tasks in the list with TODO status.
2. Open Task B, click the "..." menu or the dependencies section, and add Task A as a "waiting on" dependency.
3. Open Task C and add Task B as a "waiting on" dependency.

### Fan-In (Multiple Prerequisites)

A task can wait on multiple dependencies. All must be complete before it becomes eligible.

```
Task A: "Build API endpoint"       (no dependencies)
Task B: "Build UI component"       (no dependencies)
Task C: "Integration tests"        (waiting on A and B)
```

Tasks A and B can be processed in any order (across separate poll cycles — Clawup processes one task at a time). Task C will only be picked up after both A and B are complete.

### Fan-Out (One Prerequisite, Many Dependents)

Multiple tasks can depend on the same prerequisite.

```
Task A: "Set up database schema"   (no dependencies)
Task B: "Build user service"       (waiting on A)
Task C: "Build product service"    (waiting on A)
Task D: "Build order service"      (waiting on A)
```

Once Task A is complete, Tasks B, C, and D all become eligible. They will be processed one at a time, in priority order.

### When Dependencies Are Not a Good Fit

Avoid using dependencies for:

- **Unrelated tasks** that happen to share the same external blocker (e.g., "waiting for staging environment"). Use the `blocked` status instead.
- **Soft ordering preferences** where one task "should ideally" go first but doesn't strictly need to. Just set priorities instead.
- **Cross-list dependencies** — Clawup only checks dependencies within what it can access via the ClickUp API. Dependencies on tasks in lists you don't have access to will be treated as unresolved.

---

## Gotchas & Edge Cases

### Dependency Left Open Accidentally

If a dependency task is done but its status was not moved to `complete` (e.g., still in `in review` or `approved`), all downstream tasks remain blocked. Check that completed prerequisite tasks have actually reached `complete` status (PR merged).

**Symptom:** Tasks that should be eligible are logged as skipped due to unresolved dependencies.

**Fix:** Move the prerequisite task to `complete` status, or merge its PR so Clawup does it automatically.

### Circular Dependencies

If Task A waits on Task B and Task B waits on Task A, neither will ever be picked up. Clawup does not detect circular dependencies — both tasks will simply be skipped on every poll cycle.

**Symptom:** Tasks are perpetually skipped with unresolved dependency logs pointing at each other.

**Fix:** Remove one side of the circular dependency in ClickUp.

### Unreachable Dependency Tasks

If a dependency task has been deleted, is in a different workspace, or is otherwise inaccessible via the API, Clawup treats it as unresolved. This prevents accidentally processing a task whose prerequisite status is unknown.

**Symptom:** Task is skipped, and the dependency is listed as unreachable in debug logs.

**Fix:** Remove the dependency link in ClickUp if the prerequisite task no longer exists.

### Interaction with Task Statuses

Dependencies are only checked for tasks in TODO status during polling. Other statuses behave as follows:

| Status | Dependency Check? | Behavior |
|--------|-------------------|----------|
| `to do` | Yes (polling loop) | Skipped if unresolved dependencies exist |
| `in progress` | No | Already being processed |
| `in review` | No | Waiting for human review |
| `approved` | No | Will be merged regardless of dependencies |
| `blocked` | No | Waiting for manual intervention |
| `require input` | No | Waiting for clarification |
| `complete` | No | Terminal state |

Moving a task back to `to do` (e.g., after review feedback) will re-trigger the dependency check on the next poll cycle.

### Dependencies and `--once` Override

Running `clawdup --once <task-id>` bypasses dependency blocking. This is intentional — it lets you manually force a task through the pipeline. The warning log ensures you're aware of any unresolved dependencies.

### No Caching

Dependency status is fetched fresh from ClickUp on every poll cycle. There is no local cache, so status changes in ClickUp are reflected on the next poll (within `POLL_INTERVAL_MS`).
