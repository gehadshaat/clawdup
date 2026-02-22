# Clawup: The Autonomous Business Agent That Lives in ClickUp

## The One-Liner

**Clawup is an autonomous AI agent that picks up tasks from ClickUp, does the actual work, and reports back — not just for code, for everything a business does.**

Write a task. The agent plans it, breaks it down, researches, drafts, contacts people, creates deliverables, and completes the work — all while you watch the progress in ClickUp and approve the decisions that matter.

---

## The Problem

Every business runs on tasks. Millions of tasks are created every day in project management tools. And then... humans have to do them. One by one. Manually.

The project management industry spent 20 years optimizing how tasks get **tracked**. Nobody has solved how tasks get **done**.

AI assistants like ChatGPT and Claude are powerful — but they're **reactive**. You have to sit in a chat window and drive the conversation. They don't pick up work on their own. They don't break down projects. They don't follow up. They don't remember what happened last week. They don't integrate into how your business actually operates.

**Clawup bridges this gap.** It turns ClickUp from a place where you *track* work into a place where work *gets done*.

---

## How It Works

Clawup is a CLI tool that runs on a machine (yours, a server, or eventually hosted). It connects to a ClickUp list, polls for tasks, and hands them to Claude with the right tools and context to execute the work autonomously.

### The Core Loop

```
1. Human creates a task in ClickUp
2. Clawup picks it up → moves to "in progress"
3. Claude reads the task, thinks, and acts:
   - Researches (web search, reads docs, gathers data)
   - Plans (decomposes into subtasks, creates them in ClickUp)
   - Executes (drafts emails, writes documents, builds code, contacts vendors)
   - Reports (posts findings and deliverables as ClickUp comments)
4. For actions that need permission (sending emails, spending money):
   - Creates a subtask in "pending approval"
   - Human reviews and approves
   - Claude executes the approved action
5. Task moves to "complete"
```

**The key insight:** Claude doesn't just answer a question. It **does the work** and **creates more work** (subtasks) when the job is bigger than one step. The ClickUp task tree becomes the agent's visible plan, and status changes become the approval mechanism.

---

## The Event Planning Example

This is the scenario that makes the whole vision click.

**Task: "Plan a team offsite in DC for 50 people. Budget: $15K. Date: March 20."**

```
Claude picks up the task. Here's what happens:

MINUTE 1-5: Planning & Research
├── Claude posts a comment: "Breaking this down into venue, catering,
│   logistics, and communications. Creating subtasks now."
├── Creates subtask: "Research venue options in DC" → status: to do
├── Creates subtask: "Research catering vendors" → status: to do
├── Creates subtask: "Draft invitation email" → status: to do
└── Creates subtask: "Create budget tracker" → status: to do

MINUTE 5-15: Research Phase (parallel)
├── "Research venues" → in progress
│   Claude searches the web, reads venue sites, compares capacity/pricing
│   Posts comment: "Found 4 strong options:
│     1. The Hamilton — 75 cap, $3,200, downtown
│     2. 600F Loft — 60 cap, $2,500, Penn Quarter
│     3. Eastern Market — 100 cap, $1,800, outdoor covered
│     4. The Lumen — 80 cap, $4,100, rooftop"
│   Creates subtasks for each venue:
│     "Contact The Hamilton for March 20 availability" → pending approval
│     "Contact 600F Loft for March 20 availability" → pending approval
│     "Contact Eastern Market for March 20 availability" → pending approval
│   Moves "Research venues" → complete
│
├── "Research catering" → in progress
│   Same pattern: research, comment findings, create contact subtasks
│   Moves → complete
│
├── "Draft invitation email" → in progress
│   Writes draft, posts in comment: "Here's the invite draft: ..."
│   Moves → complete (it's a draft, human will review in the comment)
│
└── "Create budget tracker" → in progress
    Creates a checklist on parent task:
    ☐ Venue: $0 / $5,000 budget
    ☐ Catering: $0 / $4,000 budget
    ☐ AV/Equipment: $0 / $1,500 budget
    ☐ Transportation: $0 / $2,000 budget
    ☐ Misc: $0 / $2,500 budget
    Moves → complete

HUMAN REVIEWS (async, whenever they get to it)
├── Sees the venue options in comments. Likes The Hamilton and 600F.
├── Approves "Contact The Hamilton" → moves to approved
├── Approves "Contact 600F Loft" → moves to approved
├── Cancels Eastern Market (too far from hotel)
└── Tweaks the invite draft in a comment: "Make it more casual"

NEXT POLL CYCLE: Execution
├── "Contact The Hamilton" → approved → in progress
│   Claude drafts an email:
│     To: events@thehamiltondc.com
│     Subject: Venue inquiry — March 20, 50 guests
│     Body: Professional inquiry about availability and pricing
│   Sends the email (tool: send_email)
│   Posts comment: "Email sent to The Hamilton. Will follow up if no
│   reply by Thursday."
│   Creates subtask: "Follow up with Hamilton if no reply" (due: Thursday)
│   Moves → waiting
│
├── "Contact 600F Loft" → same pattern
│
└── Claude sees the comment about the invite being more casual
    Updates the draft in a new comment with casual tone
    "Updated invite draft (casual version): ..."

THURSDAY: Follow-up
├── "Follow up with Hamilton" becomes due → to do → in progress
│   Claude checks inbox (tool: check_email)
│   Hamilton replied! "Available March 20. $3,200 + $500 AV package."
│   Posts comment with the reply details
│   Creates subtask: "Confirm booking at The Hamilton — $3,700" → pending approval
│   Moves follow-up → complete
│   Moves "Contact The Hamilton" → complete

HUMAN APPROVES booking → Claude sends confirmation email → done.
```

**Total human effort: ~10 minutes of reading comments and approving/rejecting subtasks.**

**Work done: venue research, vendor research, email drafting, outreach, follow-ups, budget tracking, invitation writing.**

That's a week of coordinator work compressed into an async approval flow.

---

## The Architecture

### ClickUp Is the Brain

All state lives in ClickUp. There is no external database, no separate dashboard, no "agent memory store." ClickUp IS the state:

- **Task hierarchy** = the agent's plan
- **Task statuses** = the agent's workflow state
- **Comments** = the agent's work output and communication
- **Checklists** = structured tracking (budgets, requirements, progress)
- **Subtasks** = decomposed work items
- **Assignees** = who's responsible (human or agent)
- **Due dates** = deadlines and follow-up triggers
- **Tags** = categorization and routing

This means:
- Everything is auditable (ClickUp has full history)
- Nothing is lost if Clawup restarts (state is in ClickUp, not in memory)
- Multiple humans can observe and intervene at any time
- The agent's "thinking" is visible as task structure and comments

### The Status Workflow

Users create a dedicated ClickUp Space (or List) with these statuses:

| Status | Type | Color | Purpose |
|--------|------|-------|---------|
| **to do** | open | `#d3d3d3` | Ready for the agent to pick up |
| **in progress** | active | `#4194f6` | Agent is actively working |
| **pending approval** | active | `#f9d900` | Agent prepared an action — needs human sign-off |
| **approved** | active | `#2ecd6f` | Human approved — agent will execute |
| **needs input** | active | `#a875ff` | Agent is stuck — needs human clarification |
| **waiting** | active | `#ff7800` | Paused on external party (email reply, vendor, etc.) |
| **complete** | closed | `#6bc950` | Done |
| **cancelled** | closed | `#808080` | Not doing this |

**Status flows by task type:**

```
Research/Analysis (autonomous):
  to do → in progress → complete

Action requiring approval (gated):
  to do → in progress → pending approval → approved → complete

Action with external dependency:
  to do → in progress → pending approval → approved → waiting → complete

Agent needs help:
  to do → in progress → needs input → (human comments) → in progress → ...

Human rejects an action:
  pending approval → cancelled  (agent adapts, may create alternative)
  pending approval → to do      (human adds feedback, agent retries)
```

**The critical design choice:** The agent auto-creates gated tasks directly in `pending approval` when it knows the action needs human sign-off (sending emails, contacting people, committing to something). Research and analysis tasks are created in `to do` and the agent picks them up and completes them autonomously.

### The Tool System

Clawup's power comes from the tools it gives Claude. Today, Claude Code has tools for code (Edit, Write, Read, Bash). Clawup extends this with **business tools** — implemented as MCP servers that plug into Claude.

**Core tools (always available):**

| Tool | What It Does |
|------|-------------|
| `clickup_create_task` | Create a subtask in ClickUp with name, description, status |
| `clickup_update_task` | Update task status, add checklist items, set due dates |
| `clickup_comment` | Post a comment on the current task or any task |
| `clickup_get_tasks` | Read other tasks for context (related work, past decisions) |
| `web_search` | Search the web for information |
| `web_read` | Read and extract information from a URL |

**Pluggable tools (configured per instance):**

| Tool Pack | Tools Included | Use Case |
|-----------|---------------|----------|
| **Email** | `send_email`, `check_inbox`, `draft_reply` | Outreach, follow-ups, communications |
| **Calendar** | `check_availability`, `create_event`, `send_invite` | Scheduling, event planning |
| **Documents** | `create_doc`, `edit_doc`, `share_doc` | Reports, proposals, content |
| **Code** | `git_branch`, `commit`, `create_pr`, `push` | Software development (existing Clawup capability) |
| **Slack** | `send_message`, `post_channel`, `read_channel` | Internal communications |
| **CRM** | `lookup_contact`, `update_deal`, `log_activity` | Sales operations |
| **Spreadsheets** | `create_sheet`, `update_cells`, `add_chart` | Data, budgets, tracking |

**The tools are the moat.** Every new tool pack makes Clawup useful for another business function. The core engine (poll → execute → report → approve) stays the same. The tools determine *what kind of work* the agent can do.

**Tool permission model:** Some tools are auto-approved (research, creating ClickUp tasks, posting comments). Others require human approval via the `pending approval` status (sending emails, spending money, publishing content). This is configured in `clawup.config.mjs`:

```javascript
export default {
  // Tools that require human approval before execution
  gatedTools: ['send_email', 'create_event', 'send_invite', 'publish'],

  // Tools that execute automatically
  autoTools: ['web_search', 'web_read', 'clickup_create_task', 'clickup_comment'],
};
```

### Task Expansion: The Recursive Engine

This is the architecture's most powerful feature. When Claude encounters a complex task, it doesn't try to do everything in one pass. It **decomposes**:

```
processTask("Plan Q1 marketing campaign")
  ↓
Claude creates subtasks:
  ├── "Analyze Q4 campaign performance" (to do — will auto-process)
  ├── "Research competitor campaigns" (to do — will auto-process)
  ├── "Draft campaign strategy doc" (to do — depends on research)
  ├── "Create content calendar" (to do — depends on strategy)
  └── "Draft launch email sequence" (to do — depends on calendar)
  ↓
Clawup sees new "to do" subtasks → picks them up → processes them
  ↓
Each subtask may create MORE subtasks
  ↓
Work cascades down the tree until everything is "complete"
  ↓
Parent task auto-completes when all children are done
```

**Depth control:** The agent has a configurable maximum depth (default: 3 levels). Beyond that, it comments "This needs further breakdown by a human" and moves to `needs input`. This prevents runaway expansion.

**Priority inheritance:** Subtasks inherit the parent's priority. Urgent parent = urgent children. This means the agent works on the most important branches first.

**Context threading:** When the agent works on a subtask, it reads the parent task and sibling tasks for context. It knows "Research catering" is part of "Plan event in DC" — it doesn't research catering in a vacuum.

---

## Use Cases Across the Business

### Operations & Event Planning
```
"Plan the company holiday party for 200 people in Austin"
→ Venue research, vendor outreach, budget tracking, invitation drafting,
  RSVP management, logistics coordination — all as ClickUp subtasks
  with human approval at decision points
```

### Sales & Business Development
```
"Research and prepare outreach for 20 mid-market SaaS companies in healthcare"
→ Company research, contact finding, personalized email drafting,
  outreach tasks created in "pending approval", follow-up scheduling,
  response tracking — CRM updated automatically
```

### Content & Marketing
```
"Create a 5-part blog series on our new product launch"
→ Topic research, outline creation, draft writing for each post,
  SEO optimization, social media snippet creation, editorial review
  tasks — all posted as comments for review, published after approval
```

### HR & Recruiting
```
"Screen the 30 applications for Senior Product Manager"
→ Resume analysis against job requirements, candidate scoring,
  shortlist with rationale, interview question prep, scheduling
  outreach tasks for top candidates (pending approval)
```

### Customer Success
```
"Investigate spike in churn among enterprise accounts this month"
→ Data analysis, account review, pattern identification, risk assessment,
  recommended actions for each at-risk account, outreach drafts for
  CSMs to approve and send
```

### Finance & Procurement
```
"Find and evaluate 3 vendors for our new CRM system"
→ Market research, feature comparison matrix, pricing analysis,
  reference check outreach, summary recommendation doc,
  meeting scheduling tasks for demos
```

### Software Development (existing capability, enhanced)
```
"Implement user authentication with OAuth"
→ Code implementation via PR (existing Clawup flow), BUT ALSO:
  documentation tasks, QA test plan tasks, security review tasks,
  deployment checklist — the full lifecycle, not just the code
```

---

## The Clawup CLI Experience

### Setup

```bash
# Install
npm install -g clawup

# Interactive setup — creates a ClickUp Space with the right statuses,
# configures API tokens, selects tool packs
clawup --setup

# Validate configuration
clawup --check
```

### Running

```bash
# Start the agent — polls ClickUp, processes tasks autonomously
clawup

# Process a single task (for testing)
clawup --once CU-abc123

# With specific tool packs enabled
clawup --tools email,calendar,documents

# With verbose output to see the agent's reasoning
clawup --verbose
```

### Configuration (`clawup.config.mjs`)

```javascript
export default {
  // Custom instructions for the agent
  prompt: `
    You are an operations assistant for Acme Corp.
    Our company is a B2B SaaS startup with 50 employees in Austin, TX.
    When contacting vendors, always mention we're a growing startup.
    Budget approvals over $5,000 need CFO sign-off — create a separate
    approval task assigned to @sarah.
  `,

  // Tool packs to enable
  tools: ['email', 'calendar', 'documents', 'web'],

  // Tools that require human approval
  gatedTools: ['send_email', 'create_event', 'send_invite'],

  // Maximum subtask depth
  maxDepth: 3,

  // Email configuration
  email: {
    from: 'ops@acmecorp.com',
    signature: 'Best regards,\nAcme Corp Operations Team',
  },
};
```

---

## Why This Is a Billion-Dollar Opportunity for ClickUp

### 1. It Transforms ClickUp's Value Proposition

**Today:** "ClickUp helps you manage your work."
**Tomorrow:** "ClickUp does your work."

Every competitor (Jira, Asana, Monday, Linear, Notion) is a tracking tool. ClickUp becomes the first project management platform where creating a task doesn't just *record* that work needs to happen — it **triggers the work happening**.

This isn't an incremental improvement. It's a category change. ClickUp stops competing with other PM tools and starts competing with **hiring**.

### 2. It Creates a New Revenue Category

ClickUp currently charges per seat per month for humans. Clawup enables:

- **Agent seats** — pay for the AI agent's capacity (tasks/month, tool access)
- **Tool pack subscriptions** — email tools, CRM tools, calendar tools as add-ons
- **Execution minutes** — metered AI compute time for heavy tasks
- **Hosted Clawup** — managed infrastructure so users don't run their own

This is net-new revenue that doesn't cannibalize existing seats. Companies don't replace human seats with agent seats — they **add agent capacity** on top of their human team.

### 3. It Makes ClickUp Irreplaceable

A PM tool is easy to switch. Export your tasks, import somewhere else. But once your business operations **run through** Clawup on ClickUp:

- Your approval workflows are in ClickUp
- Your agent's institutional knowledge is in ClickUp (comment history, past tasks)
- Your tool configurations are in ClickUp
- Your team's review patterns are in ClickUp

Switching PM tools means losing your AI operations team's memory and workflow. The lock-in is organic — it comes from value, not vendor tricks.

### 4. The Platform Flywheel

```
More tool packs → more use cases → more users → more tasks processed
→ better agent performance (from patterns) → more tool packs built
→ ... (flywheel)
```

**Community-built tool packs** are the App Store moment. When a HubSpot power user builds a CRM tool pack and shares it, every ClickUp + HubSpot customer benefits. When a real estate agent builds a property research tool pack, every real estate team on ClickUp gets autonomous listing research.

ClickUp becomes the **marketplace for business agent capabilities**.

### 5. The Data Moat

Every task Clawup processes teaches it more about how businesses work:

- How event planning breaks down into subtasks
- What information salespeople need before outreach
- How long vendor selection actually takes
- What approval patterns work for different company sizes

This data — the structure of how work gets decomposed and executed — is proprietary to ClickUp. No competitor has it because no competitor is executing the work.

---

## Competitive Landscape

| Competitor | What They Do | Why Clawup Is Different |
|-----------|-------------|----------------------|
| **ChatGPT / Claude** | Chat-based AI assistant | Reactive. You drive the conversation. No task tracking. No approval workflow. No autonomous execution. |
| **Zapier / Make** | Workflow automation | Pre-defined rules. Can't reason. Can't decompose a novel task. Can't adapt to unexpected situations. |
| **Virtual Assistants (human)** | Delegated task execution | $15-40/hr. Limited hours. Drops balls. Can't scale. Can't work on 10 things in parallel. |
| **ClickUp AI / Copilot** | AI features within ClickUp | Suggestions and summaries. Doesn't execute. Doesn't create subtasks autonomously. Doesn't send emails or contact vendors. |
| **Devin / Cursor** | AI coding agents | Code only. No business operations. No email. No vendor outreach. No event planning. |
| **Custom GPTs / Agents** | Single-purpose AI bots | No project management. No approval workflow. No task decomposition. No state management. |

**Clawup is the only system that combines:**
- Autonomous task execution (it does the work)
- Recursive task decomposition (it plans the work)
- Human-in-the-loop approval (it asks before acting)
- Persistent state management (ClickUp is the memory)
- Pluggable tool system (it adapts to any business function)
- Full audit trail (every action is a ClickUp comment)

---

## Roadmap

### Phase 1: Foundation (Now → 3 months)
- Core ClickUp tools (create tasks, update status, post comments)
- Web research tools (search, read pages, extract data)
- Recursive task expansion with depth control
- The 8-status workflow system
- `clawup --setup` creates the ClickUp Space with correct statuses
- Event planning, research, and analysis use cases work end-to-end

### Phase 2: Communication (3 → 6 months)
- Email tool pack (send, receive, draft, follow up)
- Calendar tool pack (availability, scheduling, invites)
- Gated tool approval pattern (pending approval → approved → execute)
- "Waiting" status with follow-up task scheduling
- Sales outreach and vendor management use cases work end-to-end

### Phase 3: Documents & Deliverables (6 → 9 months)
- Google Docs / Notion tool pack (create, edit, share)
- Spreadsheet tool pack (budgets, trackers, reports)
- File generation (PDF reports, presentations)
- Attach deliverables to ClickUp tasks
- Content creation and reporting use cases work end-to-end

### Phase 4: Integrations & Platform (9 → 12 months)
- Slack tool pack (messaging, channel updates)
- CRM tool packs (Salesforce, HubSpot)
- Community tool pack SDK (let anyone build tools)
- Hosted Clawup (no CLI needed — runs in the cloud)
- ClickUp native app integration (button in the ClickUp UI)

### Phase 5: Intelligence (12+ months)
- Cross-task learning (agent gets better at decomposition over time)
- Team-specific adaptation (learns your company's patterns)
- Proactive suggestions ("Based on past events, you usually book catering 3 weeks before — should I start researching?")
- Multi-agent coordination (sales agent hands off to onboarding agent)

---

## The Endgame

Today, businesses hire people to do work and use software to track it.

Tomorrow, businesses use software to do the work, and people make the decisions.

ClickUp is "the everything app for work." Clawup makes it "the everything app that **does** the work."

**The billion-dollar vision isn't about AI features bolted onto a PM tool. It's about the PM tool becoming the command center for an autonomous workforce — where every task is a work order, every status change is a decision, and every comment is a deliverable.**

Clawup is the engine. ClickUp is the interface. The work gets done.
