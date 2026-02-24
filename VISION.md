# Clawup

**Poll ClickUp for tasks. Run Claude Code. Open PRs.**

An open-source CLI that connects ClickUp to Claude Code. Write a task in ClickUp, Clawup picks it up, Claude implements it, and a PR appears on GitHub.

## Why

ClickUp has Super Agents for routine work. GitHub has Copilot for code suggestions. Neither one picks up a task from your board and ships a PR.

Clawup does one thing: **ClickUp task in, GitHub PR out.**

## How It Works

```
clawup

1. Polls a ClickUp list for tasks in "to do"
2. Picks one up → moves to "in progress"
3. Hands the task to Claude Code with repo context
4. Claude writes code, runs tests, commits
5. Pushes a branch, opens a PR
6. Posts the PR link as a ClickUp comment
7. Moves task to "review"
8. Repeat
```

## Setup

```bash
npm install -g clawup
clawup --setup    # walks you through ClickUp API key, list ID, GitHub repo
clawup --check    # validates everything works
clawup            # start processing
```

## Configuration

Environment variables or `clawup.config.mjs`:

```javascript
export default {
  clickup: {
    apiKey: process.env.CLICKUP_API_KEY,
    listId: process.env.CLICKUP_LIST_ID,
  },
  github: {
    repo: 'owner/repo',
  },
  // Optional: custom instructions for Claude
  prompt: 'Follow our coding conventions. Use TypeScript. Write tests.',
  // Optional: max tasks to process per run
  maxTasks: 5,
};
```

## Task Statuses

Clawup expects these statuses on your ClickUp list:

| Status | What Happens |
|--------|-------------|
| **to do** | Clawup picks it up |
| **in progress** | Claude is working on it |
| **review** | PR is open, waiting for human review |
| **complete** | PR merged (or task done) |

That's it. Four statuses. No "pending approval," no "needs input," no workflow engine. If you want more, add them yourself — Clawup only cares about "to do" as the trigger.

## What Goes in a Task

The task name and description become Claude's instructions. Be as specific or as vague as you want:

```
Specific:  "Add a /health endpoint that returns { status: 'ok', uptime: process.uptime() }"
Vague:     "Add health checks"
With context: Paste error logs, link to docs, attach screenshots
```

Claude figures it out. The task description IS the prompt.

## What You Get

- A branch named `clickup/CU-{taskId}-{slug}`
- A PR with the implementation
- A ClickUp comment with the PR link
- The task moved to "review"

## What This Isn't

- **Not a general-purpose agent.** It does code. That's it.
- **Not a managed service.** It runs on your machine. You bring your own API keys.
- **Not a ClickUp replacement.** ClickUp is the UI. Clawup is the worker.
- **Not competing with OpenClaw.** OpenClaw is a general AI agent platform. Clawup is a single-purpose tool. Use OpenClaw if you want email, calendar, Slack, etc. Use Clawup if you want ClickUp tasks turned into PRs.

## Tech Stack

- TypeScript, zero runtime dependencies
- Shells out to `claude` CLI (Claude Code) and `gh` CLI (GitHub)
- Node.js 18+

## Contributing

PRs welcome. The codebase is small on purpose.

## License

MIT
