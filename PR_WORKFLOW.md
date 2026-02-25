# PR Review & Merge Workflow

How to review and merge pull requests created by clawdup.

## Recognizing a Clawdup PR

| Signal | Pattern | Example |
|--------|---------|---------|
| Branch | `{prefix}/CU-{task-id}-{slug}` | `clickup/CU-abc123-add-auth` |
| PR title | `[CU-{task-id}] {description}` | `[CU-abc123] Add auth` |
| PR body | Contains work summary, file changes, and link to ClickUp task | — |
| ClickUp task | Has a comment with the PR link posted by automation | — |

The `CU-{task-id}` tag auto-links to ClickUp if you have the GitHub integration enabled.

## The Happy Path

```
1. Task in "to do"
2. Automation picks it up → "in progress"
3. Claude implements, pushes, creates PR → "in review"
4. CI runs, reviewer approves
5. Reviewer moves task to "approved" in ClickUp
6. Automation merges PR (squash) → "complete"
```

**If `AUTO_APPROVE=true`:** Step 5–6 are skipped — the PR is merged immediately after Claude finishes.

## What Reviewers Should Check

Passing CI alone is not sufficient. Reviewers should verify:

- **Correctness** — Does the code actually solve the ClickUp task? Read the task description and acceptance criteria.
- **Side effects** — Are there unexpected changes to unrelated files, docs, or configs?
- **Code quality** — Does the code follow project conventions? Is it over-engineered or too minimal?
- **Security** — No secrets committed, no injection vectors, no permission changes unless the task requires them.

## CI and Automation Behavior

The repo runs a **dry-run CI check** (`.github/workflows/dry-run.yml`) on every PR to catch configuration regressions.

**Merge rules:**

- Automation will **not** merge if CI checks are failing.
- Automation uses `--admin` to bypass branch protection, but only after the task reaches "approved" status.
- If CI is still pending when the task is approved, the runner will retry on the next poll cycle.

**Sequence:**

```
CI passes → reviewer approves → task moved to "approved" → automation merges
CI fails  → reviewer leaves feedback → task moved to "to do" or stays "in review"
```

## Giving Feedback (Review Rounds)

When you want changes to a clawdup PR:

1. **Leave review comments** on the GitHub PR (general or inline — both are collected).
2. **Move the ClickUp task back to "to do"** (optionally add a ClickUp comment with extra context).
3. Clawdup picks up the returning task, collects all feedback from:
   - GitHub PR review comments
   - GitHub inline code comments
   - New ClickUp comments since the last automation comment
4. Claude re-implements on the **same branch**, pushes updates to the **same PR**.
5. Task moves back to "in review" when done.

You can repeat this cycle as many times as needed. Each round builds on the previous work.

## Edge Cases

### Merge Conflicts

If the base branch has diverged:
- Automation detects the conflict and asks Claude to resolve it.
- If resolution fails, the task moves to **"blocked"** with a comment listing the conflicted files.
- **Manual fix:** Check out the branch, resolve conflicts, push, then move the task to "approved" (or "to do" for another Claude pass).

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed recovery steps.

### Repeated Failures

If a task keeps bouncing to "blocked":
- Check the ClickUp comments — automation posts error details each time.
- Consider simplifying the task description or breaking it into smaller tasks.
- Move to "to do" with a comment explaining what went wrong for another attempt.

### Needs Input / No Changes

If Claude can't figure out what to do:
- Task moves to **"require input"** with a comment explaining what's missing.
- Add the missing context to the task description or comments, then move back to "to do".

### Merging Manually

If you need to merge a clawdup PR yourself:

1. Merge the PR on GitHub (squash recommended).
2. **Update the ClickUp task** to "complete" — automation won't know the PR was merged otherwise.
3. The feature branch is deleted automatically if you use GitHub's merge button with "delete branch" checked.

### Closing a PR Without Merging

If the approach is wrong and you want to start fresh:

1. Close the PR on GitHub.
2. Move the ClickUp task to "to do" with a comment explaining what to change.
3. Clawdup will create a new branch and PR on the next run.

### Temporarily Disabling Automation for a Task

Move the task to any status that isn't "to do", "approved", or "in review with existing PR moved back to to do". The runner only picks up tasks in "to do" and "approved" statuses.

## Quick-Reference Checklist

Use this when reviewing a clawdup PR:

- [ ] CI checks are green (or known flakiness is called out)
- [ ] Changes match the ClickUp task description and acceptance criteria
- [ ] No unexpected file changes or side effects
- [ ] Code follows project conventions
- [ ] No secrets, credentials, or sensitive data committed
- [ ] ClickUp task status updated after review:
  - **Looks good →** move to "approved"
  - **Needs changes →** leave PR comments, move to "to do"
  - **Wrong approach →** close PR, move to "to do" with new instructions
