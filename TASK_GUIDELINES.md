# Writing ClickUp Tasks for Clawdup

This guide covers how to write ClickUp tasks that produce reliable results with Clawdup automation. It distills patterns from successful tasks into a reusable checklist, annotated examples, and templates.

> **How Clawdup reads your task:** The task title, description, checklists, subtasks, tags, priority, and recent comments are all sent to Claude Code as context. Claude also receives the project's `CLAUDE.md` and any custom prompt from `clawdup.config.mjs`. Write your task knowing that everything in these fields will be read by an AI coding assistant.

---

## Quick Checklist

Before setting a task to **"to do"**, confirm:

- [ ] **Title** is a single, actionable sentence describing the change
- [ ] **Description** includes *what* to change and *why*
- [ ] **Acceptance criteria** are listed (checklists or clear requirements in the description)
- [ ] **File/component hints** are included when relevant
- [ ] **Context** (error logs, links, screenshots) is attached if applicable
- [ ] **Priority** is set (urgent > high > normal > low)
- [ ] **No conflicting or overly broad instructions** — one focused goal per task

---

## Anatomy of a Good Task

### Title

One line that answers "what needs to happen?"

| Quality | Example |
|---------|---------|
| Good | Add email validation to the signup form |
| Good | Fix crash in UserService.getProfile when user is null |
| Bad | Fix bug *(too vague — which bug?)* |
| Bad | Improvements and cleanup *(not actionable)* |

**Tips:**
- Start with a verb: *Add*, *Fix*, *Refactor*, *Update*, *Remove*
- Be specific enough that someone unfamiliar with the codebase knows the scope

### Description

Provide the details Claude needs to implement the change without guessing.

**Include:**
- **What** to change and **where** (files, functions, components)
- **Why** the change is needed (context helps Claude make better decisions)
- **How** it should behave (expected inputs/outputs, edge cases)
- **Constraints** (backwards compatibility, performance, specific libraries to use)

**Keep it focused:** One task = one logical change. If you find yourself writing "also" or "and while you're at it", consider splitting into separate tasks.

### Acceptance Criteria

Use ClickUp checklists — they appear as a structured checklist in Claude's prompt.

Good acceptance criteria are:
- **Testable** — each item can be verified as done or not done
- **Specific** — no ambiguity about what "done" looks like
- **Independent** — each item stands on its own

### File Hints

Mention specific files or directories when you know where the change should go:

```
Files to modify:
- src/components/SignupForm.tsx (add validation logic)
- src/utils/validators.ts (create new validation helpers)
```

This saves Claude exploration time and reduces the chance of changes landing in the wrong place.

### Priority

Set the ClickUp priority to control processing order:

1. **Urgent** — processed first
2. **High** — processed before normal/low
3. **Normal** — default
4. **Low** — processed last

### Tags

Tags are included in the prompt. Use them to signal the type of work:
- `bug`, `feature`, `refactor`, `docs`, `improvement`, `chore`

---

## Annotated Example

Below is a well-structured task with callouts explaining why each part works.

> **Title:** Add rate limiting to the /api/users endpoint
>
> *Clear verb + specific location. Claude knows exactly what and where.*
>
> **Description:**
>
> The `/api/users` endpoint currently has no rate limiting, which exposes it to abuse. Add rate limiting using the existing `rateLimiter` middleware in `src/middleware/rate-limiter.ts`.
>
> *States the problem (why) and points to existing code to build on (where).*
>
> Requirements:
> - Limit to 100 requests per minute per IP
> - Return HTTP 429 with a `Retry-After` header when the limit is exceeded
> - Use the existing Redis-backed rate limiter — do not add new dependencies
>
> *Specific numbers, expected HTTP behavior, and a constraint (no new deps).*
>
> The endpoint is defined in `src/routes/users.ts` at the router level.
>
> *Direct file hint so Claude doesn't have to search.*
>
> **Checklist:**
> - [ ] Rate limiter applied to /api/users route
> - [ ] Returns 429 with Retry-After header on limit exceeded
> - [ ] No new dependencies added
> - [ ] Existing tests still pass
>
> *Each item is independently verifiable.*

---

## Providing Context

### Error Logs and Stack Traces

When filing a bug, paste the relevant error output. Trim it to the useful parts:

```
TypeError: Cannot read properties of null (reading 'email')
    at UserService.getProfile (src/services/user-service.ts:42:18)
    at async handler (src/routes/users.ts:15:20)
```

Don't paste full application logs spanning hundreds of lines — the description is truncated at 5,000 characters.

### Links

- Link to relevant docs, issues, or PRs when they provide context
- ClickUp task URLs are automatically included in the prompt

### Screenshots

ClickUp attachments are **not** sent to Claude. If visual context matters, describe the expected behavior in text or reference specific CSS classes/components.

---

## Content Limits

Clawdup enforces these limits to keep prompts focused:

| Field | Limit |
|-------|-------|
| Task description | 5,000 characters |
| Each comment | 2,000 characters |
| Comments included | 10 most recent |
| Checklist items | 500 characters each |

Write concisely. If you need more space, break the work into multiple tasks.

---

## Task Statuses and the Automation Lifecycle

Understanding how statuses map to automation behavior helps you work with the system:

| Status | Who sets it | What happens |
|--------|------------|--------------|
| **to do** | You | Automation picks up the task |
| **in progress** | Automation | Claude is working — do not edit the task |
| **in review** | Automation | PR created — review it on GitHub |
| **approved** | You | Automation merges the PR |
| **require input** | Automation | Claude needs more info — read the comment, update the task, move back to "to do" |
| **blocked** | Automation | An error occurred — read the comment, fix the issue, move back to "to do" |
| **complete** | Automation | PR merged — done |

**Key points:**
- Only move tasks to **"to do"** when they're ready for automation
- Don't edit a task while it's **"in progress"** — Claude is already reading it
- When a task moves to **"require input"**, read Claude's comment, add the missing info, then move back to **"to do"**
- After reviewing a PR, move the task to **"approved"** to trigger the merge

---

## What to Avoid

### Overly Broad Tasks

Bad: *"Refactor the entire authentication system"*
Better: *"Extract token validation from AuthController into a dedicated TokenService class"*

Large, vague tasks lead to timeouts, incomplete work, or unexpected changes. Break big efforts into focused subtasks.

### Conflicting Instructions

Bad: *"Use JWT for auth but also support session cookies and implement OAuth"*
Better: Pick one approach per task and create follow-ups for alternatives.

### Implementation Prescriptions That Fight the Codebase

Bad: *"Rewrite this Express route using Koa middleware patterns"*
Better: *"Add input validation to the POST /users route"* — let Claude follow existing patterns.

### Prompt-Injection-Like Content

Clawdup scans task content for patterns that resemble prompt injection attempts. Avoid phrasing that could trigger false positives:

- "Ignore previous instructions" or "forget your instructions"
- "You are now a..." or "new system prompt"
- "IMPORTANT: override..." or "CRITICAL: ignore..."
- Closing `</task>` tags in task content

If your task legitimately needs to reference these patterns (e.g., documenting security rules), rephrase to avoid the exact trigger phrases. See [PROMPT_SAFETY.md](PROMPT_SAFETY.md) for the full list.

### Secrets and Credentials

Never put API keys, passwords, or tokens in task descriptions. Claude is instructed to refuse access to credentials, and these would be visible to anyone with list access.

---

## Templates

Copy these templates when creating new tasks. Fill in the bracketed sections.

### Bug Fix

**Title:** Fix [symptom] in [component/file]

**Description:**

```
[One-sentence summary of the bug.]

Steps to reproduce:
1. [Step 1]
2. [Step 2]
3. [Expected behavior] vs [actual behavior]

Error output:
[Paste the relevant error/stack trace, trimmed to key lines]

The issue is likely in [file/function hint].
```

**Checklist:**
- [ ] Bug no longer occurs for the described scenario
- [ ] No regressions in related functionality
- [ ] Existing tests pass

---

### New Feature

**Title:** Add [feature] to [component/area]

**Description:**

```
[What the feature does and why it's needed.]

Requirements:
- [Requirement 1]
- [Requirement 2]
- [Requirement 3]

Files to modify:
- [file1] ([what to change])
- [file2] ([what to change])

Constraints:
- [Any constraints: no new deps, backwards compatibility, etc.]
```

**Checklist:**
- [ ] [Verifiable outcome 1]
- [ ] [Verifiable outcome 2]
- [ ] Existing tests pass

---

### Refactor

**Title:** Refactor [what] to [target pattern/structure]

**Description:**

```
[Why the refactor is needed — what problem does the current structure cause?]

Current state:
- [Description of current code organization]

Desired state:
- [Description of target code organization]

Files involved:
- [file1]
- [file2]

Constraints:
- No behavior changes — this is a pure refactor
- [Any other constraints]
```

**Checklist:**
- [ ] Code restructured as described
- [ ] All existing behavior preserved
- [ ] Existing tests pass

---

### Documentation

**Title:** Update [document/docs area] for [topic]

**Description:**

```
[What documentation needs to change and why.]

Sections to update:
- [Section 1]: [what to add/change]
- [Section 2]: [what to add/change]

Reference:
- [Links to relevant code, PRs, or external docs]
```

**Checklist:**
- [ ] Documentation accurately reflects current behavior
- [ ] Examples are correct and runnable
- [ ] Links are valid

---

## Tips for Better Results

1. **Be specific over being thorough** — a focused 200-word description outperforms a vague 2,000-word essay
2. **Mention existing patterns** — "follow the pattern in `src/routes/health.ts`" helps Claude match your codebase style
3. **State what NOT to do** when it matters — "do not modify the database schema" prevents scope creep
4. **One task, one PR** — this keeps reviews simple and rollbacks safe
5. **Use comments for iteration** — if a task moves to "require input", add clarification as a comment rather than rewriting the whole description (the 10 most recent comments are included in the prompt)
6. **Set realistic scope** — Claude has a 10-minute default timeout and 50 agentic turns; if a task would take a human more than a few hours, it should probably be broken down
