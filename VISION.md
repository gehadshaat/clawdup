# Clawup: Claude's Brain + ClickUp's Body

## The One-Liner

**Clawup connects Claude's deep reasoning to ClickUp's execution layer — using ClickUp for everything it can do natively, and MCP servers for the rest.**

ClickUp already has Super Agents with 500+ skills, native email, calendar, Slack, and automation. What it doesn't have is Claude. Clawup brings Claude's planning, reasoning, and code generation into ClickUp's ecosystem — not by rebuilding what ClickUp already does, but by orchestrating it.

---

## The Landscape

### What ClickUp Already Does (December 2025)

ClickUp launched **Super Agents** — autonomous AI teammates that live inside the platform:

- **500+ work skills** including email, calendar, scheduling, reporting, task management
- **Email ClickApp** — send/receive real emails from tasks via linked Gmail/Outlook
- **Google Calendar automations** — create, update, delete calendar events triggered by task changes
- **Native integrations** — Slack, GitHub, HubSpot, Google Drive, and 100+ more
- **No-code builder** — natural language agent configuration
- **Memory system** — short-term, long-term, and preference memory
- **Approval modes** — human sign-off for critical actions
- **Codegen acquisition** — AI code generation folded into Super Agents

Super Agents handle routine automation well. What they lack:

- **Deep multi-step reasoning** — Claude's ability to think through novel, complex problems
- **Real software engineering** — full repo context, multi-file edits, test-driven development, PR workflows
- **Recursive task decomposition** — breaking a vague goal into a structured plan, then executing each piece
- **Programmatic control** — no API/SDK; everything is through the no-code builder
- **Model choice** — you use whatever LLM ClickUp chose; you can't bring Claude

### The Gap Clawup Fills

```
Super Agents:  "Do routine work inside ClickUp"
Clawup:        "Think hard, plan deeply, write code, and USE ClickUp to execute"
```

Clawup doesn't replace Super Agents. It's the brain that drives them. Claude reasons about what needs to happen, then uses ClickUp's native capabilities to make it happen — creating tasks, triggering automations, sending emails through the Email ClickApp, scheduling through Calendar, posting to Slack. For anything ClickUp can't do natively, MCP servers fill the gap.

---

## How It Works

### The Architecture: ClickUp-Native First, MCP for the Rest

```
┌─────────────────────────────────────────────────────────┐
│                     CLAWUP ENGINE                       │
│                                                         │
│  ┌───────────┐    ┌──────────────────────────────────┐  │
│  │           │    │          CLAUDE                   │  │
│  │  ClickUp  │◄──►│  Planning · Reasoning · Code     │  │
│  │  Poller   │    │                                   │  │
│  │           │    │  "What needs to happen?"          │  │
│  └───────────┘    └──────────┬───────────────────────┘  │
│                              │                          │
│              ┌───────────────┼───────────────┐          │
│              ▼               ▼               ▼          │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────┐   │
│  │  ClickUp API  │  │ ClickUp MCP  │  │ Other MCP  │   │
│  │  (direct)     │  │ (official)   │  │ (custom)   │   │
│  │               │  │              │  │            │   │
│  │ • Tasks CRUD  │  │ • Search     │  │ • Code     │   │
│  │ • Comments    │  │ • Docs       │  │ • Git/GH   │   │
│  │ • Statuses    │  │ • Workspace  │  │ • Custom   │   │
│  │ • Checklists  │  │   queries    │  │   APIs     │   │
│  └───────┬───────┘  └──────┬───────┘  └─────┬──────┘   │
│          │                 │                │           │
└──────────┼─────────────────┼────────────────┼───────────┘
           │                 │                │
           ▼                 ▼                ▼
   ClickUp Platform    ClickUp Data     External Systems
   • Super Agents      • Docs           • GitHub
   • Automations       • Tasks          • File systems
   • Email ClickApp    • Comments       • Custom tools
   • Calendar sync     • Workspace
   • Slack integration
```

### The Three Execution Layers

**Layer 1: ClickUp API (Direct)**
Clawup already uses this. Create tasks, update statuses, post comments, manage checklists. This is the foundation — all state lives in ClickUp.

**Layer 2: ClickUp's Native Capabilities (via task/automation patterns)**
Instead of building email and calendar tools from scratch, Clawup creates the right ClickUp artifacts and lets ClickUp's existing integrations do the work:

| Claude wants to... | Clawup does... | ClickUp handles... |
|---|---|---|
| Send an email | Creates subtask with email custom fields, sets status to "pending approval" | User approves → ClickUp Email ClickApp sends it via linked Gmail |
| Schedule a meeting | Creates subtask with event details in custom fields | User approves → ClickUp Calendar automation creates the event |
| Notify the team on Slack | Creates subtask with message content | ClickUp Slack automation posts it |
| Update a CRM record | Creates subtask describing the change | ClickUp HubSpot/Salesforce automation executes it |

**The approval workflow IS the execution trigger.** When a human moves a task from "pending approval" to "approved," ClickUp automations fire and do the actual work — send the email, create the event, post the message. No extra credentials. No MCP server needed. The user's existing ClickUp integrations become the agent's toolkit.

**Layer 3: MCP Servers (for everything else)**
For capabilities ClickUp doesn't have natively:

| MCP Server | What It Provides | Why Not ClickUp-Native |
|---|---|---|
| **ClickUp MCP** (official, `mcp.clickup.com`) | Deep workspace search, Doc reading, cross-space queries | API doesn't cover all query patterns |
| **Code** (Claude Code native) | `git_branch`, `commit`, `create_pr`, `push`, full repo editing | ClickUp's Codegen is young; Claude Code is battle-tested |
| **Web Research** | `web_search`, `web_read`, data extraction | ClickUp has no web research capability |
| **Custom** (user-built) | Domain-specific APIs, internal tools, specialized data sources | Unique to each team |

### The Decision Flow

When Claude processes a task, it chooses the right execution path:

```
Claude receives task: "Email the Hamilton about March 20 availability"
  │
  ├─ Can ClickUp do this natively?
  │   └─ YES: Email ClickApp is connected
  │       └─ Create subtask with custom fields:
  │          • email_to: events@thehamiltondc.com
  │          • email_subject: Venue inquiry — March 20, 50 guests
  │          • email_body: <drafted content>
  │          • status: pending approval
  │       └─ Human approves → ClickUp automation sends email
  │       └─ Reply arrives as comment on task → Claude reads it next cycle
  │
  ├─ Does an MCP server handle this?
  │   └─ Example: "Generate a PR for the auth module"
  │       └─ Use Code MCP: branch, edit, test, commit, push, create PR
  │
  └─ Neither?
      └─ Break it down further, research it, or ask for human input
```

---

## The Core Loop

```
1. Human creates a task in ClickUp
2. Clawup polls and picks it up → moves to "in progress"
3. Claude reads the task, thinks, and plans:
   - What needs to happen?
   - What can ClickUp handle natively?
   - What needs MCP tools?
   - What needs human approval?
4. Claude acts:
   - Research: web search, read docs, gather data (MCP)
   - Plan: decompose into subtasks in ClickUp (API)
   - Execute: code via MCP, emails/calendar/slack via ClickUp-native patterns
   - Report: post findings as ClickUp comments (API)
5. For gated actions:
   - Creates subtask in "pending approval" with all details
   - Human reviews and approves/rejects
   - ClickUp automation executes the approved action
6. Task moves to "complete"
```

---

## The Event Planning Example

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

MINUTE 5-15: Research Phase (parallel, via MCP web tools)
├── "Research venues" → in progress
│   Claude searches the web, reads venue sites, compares capacity/pricing
│   Posts comment: "Found 4 strong options:
│     1. The Hamilton — 75 cap, $3,200, downtown
│     2. 600F Loft — 60 cap, $2,500, Penn Quarter
│     3. Eastern Market — 100 cap, $1,800, outdoor covered
│     4. The Lumen — 80 cap, $4,100, rooftop"
│   Creates subtasks for each venue:
│     "Contact The Hamilton for March 20 availability" → pending approval
│       (custom fields: email_to, email_subject, email_body pre-filled)
│     "Contact 600F Loft for March 20 availability" → pending approval
│     "Contact Eastern Market for March 20 availability" → pending approval
│   Moves "Research venues" → complete
│
├── "Research catering" → same pattern
│
├── "Draft invitation email" → in progress
│   Writes draft, posts in comment for review
│   Moves → complete
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
├── Sees venue options in comments. Likes The Hamilton and 600F.
├── Approves "Contact The Hamilton" → status: approved
│   └── ClickUp Email automation fires → sends inquiry via linked Gmail
│       (No MCP needed. No separate email credentials. ClickUp did it.)
├── Approves "Contact 600F Loft" → status: approved
│   └── Same: ClickUp sends the email
├── Cancels Eastern Market (too far from hotel)
└── Comments on invite draft: "Make it more casual"

NEXT POLL CYCLE:
├── Claude sees the comment about casual tone
│   Updates draft in a new comment
│
├── Hamilton replies to the inquiry email
│   Reply appears as comment on the task (ClickUp Email threading)
│   Claude reads it: "Available March 20. $3,200 + $500 AV package."
│   Creates subtask: "Confirm booking — The Hamilton — $3,700" → pending approval
│     (custom fields: email_to, confirmation email body pre-filled)
│
└── Claude creates follow-up subtask for 600F if no reply by Thursday
    (due date set → Clawup picks it up when due)

HUMAN APPROVES booking → ClickUp sends confirmation email → done.
```

**What ClickUp did natively:** Sent all emails via the Email ClickApp, threaded replies back into tasks.

**What MCP did:** Web research (venue/catering searches), code generation (if any).

**What Claude did:** All the thinking — venue comparison, email drafting, budget structure, follow-up planning, task decomposition.

**Total human effort: ~10 minutes of reading comments and approving/rejecting.**

---

## The Architecture Details

### ClickUp Is the State

All state lives in ClickUp. No external database. No "agent memory store." ClickUp IS the state:

- **Task hierarchy** = the agent's plan
- **Task statuses** = the agent's workflow state
- **Comments** = the agent's work output and communication
- **Custom fields** = structured data for automations (email addresses, event details)
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
- ClickUp Super Agents can also see and act on the same tasks (coexistence)

### The Status Workflow

| Status | Type | Color | Purpose |
|--------|------|-------|---------|
| **to do** | open | `#d3d3d3` | Ready for the agent to pick up |
| **in progress** | active | `#4194f6` | Agent is actively working |
| **pending approval** | active | `#f9d900` | Agent prepared an action — needs human sign-off |
| **approved** | active | `#2ecd6f` | Human approved — ClickUp automation executes |
| **needs input** | active | `#a875ff` | Agent is stuck — needs human clarification |
| **waiting** | active | `#ff7800` | Paused on external party (email reply, vendor, etc.) |
| **complete** | closed | `#6bc950` | Done |
| **cancelled** | closed | `#808080` | Not doing this |

**The critical design:** "approved" is both a human decision AND an automation trigger. When a task moves to "approved," ClickUp automations fire — sending the email, creating the calendar event, posting to Slack. The status change IS the execution command.

**ClickUp automations to configure:**
```
When status changes to "approved" AND custom field "email_to" is set:
  → Send email via Email ClickApp
  → Move status to "waiting" (awaiting reply)

When status changes to "approved" AND custom field "event_date" is set:
  → Create Google Calendar event
  → Move status to "complete"

When status changes to "approved" AND custom field "slack_channel" is set:
  → Post message to Slack channel
  → Move status to "complete"
```

### The Tool System

**Principle: ClickUp-native for execution, MCP for reasoning and code.**

**ClickUp-native tools (via API + automations):**

| Capability | How It Works |
|---|---|
| Create/update tasks | ClickUp API v2 (direct) |
| Post comments | ClickUp API v2 (direct) |
| Send emails | Email ClickApp triggered by status + custom fields |
| Calendar events | Google Calendar automation triggered by status + custom fields |
| Slack messages | Slack automation triggered by status + custom fields |
| CRM updates | HubSpot/Salesforce automation triggered by status + custom fields |

**MCP tools (for everything else):**

| MCP Server | Tools | Why MCP |
|---|---|---|
| **ClickUp MCP** (`mcp.clickup.com`) | Workspace search, Doc queries, cross-space context | Deeper queries than API supports |
| **Code** (Claude Code built-in) | File read/write/edit, bash, git, GitHub CLI | ClickUp can't write real code |
| **Web** | `web_search`, `web_read` | ClickUp has no web research |
| **Custom** | Whatever your team needs | Domain-specific extensions |

**Tool permission model:**
```javascript
// clawup.config.mjs
export default {
  // ClickUp-native actions that need human approval
  // (these create "pending approval" subtasks with custom fields)
  gatedActions: ['email', 'calendar_event', 'slack_message'],

  // ClickUp-native actions that execute automatically
  autoActions: ['create_task', 'update_task', 'post_comment'],

  // MCP tools that execute automatically
  autoTools: ['web_search', 'web_read', 'clickup_mcp_search'],

  // MCP tools that need approval
  gatedTools: ['git_push', 'create_pr'],
};
```

### Task Expansion: The Recursive Engine

When Claude encounters a complex task, it decomposes:

```
processTask("Plan Q1 marketing campaign")
  ↓
Claude creates subtasks:
  ├── "Analyze Q4 campaign performance" (to do — auto-process)
  ├── "Research competitor campaigns" (to do — auto-process via web MCP)
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

**Depth control:** Configurable max depth (default: 3). Beyond that, Claude comments "This needs further breakdown by a human" and moves to `needs input`.

**Context threading:** When working on a subtask, Claude reads parent and sibling tasks via the ClickUp MCP server for full context.

---

## Clawup + Super Agents: Coexistence

Clawup and ClickUp Super Agents aren't competitors — they're complementary layers:

| Dimension | Super Agents | Clawup |
|---|---|---|
| **Strength** | Routine automation, native integration depth | Deep reasoning, novel problem solving, code |
| **Trigger** | @mention, assignment, schedule, automation | Poll-based, processes "to do" tasks |
| **Reasoning** | Good for structured, repeatable workflows | Excels at ambiguous, complex, multi-step problems |
| **Code** | Codegen (early, unproven) | Claude Code (battle-tested, full repo context) |
| **Configuration** | No-code builder (accessible) | Code-first config (powerful, version-controlled) |
| **Cost model** | AI credits per user/month | Pay-per-use Claude API |
| **Control** | ClickUp controls the model and behavior | You control the model, prompts, and execution |

**How they work together:**

```
Complex task arrives in ClickUp
  │
  ├─ Clawup picks it up (deep work)
  │   Claude reasons, plans, decomposes into subtasks
  │   Some subtasks are straightforward enough for Super Agents
  │   Claude tags them appropriately
  │
  ├─ Super Agent handles routine subtasks
  │   "Send weekly status report" — Super Agent does this natively
  │   "Update the onboarding doc" — Super Agent handles it
  │
  ├─ Clawup handles complex subtasks
  │   "Implement the OAuth module" — Claude Code writes the PR
  │   "Evaluate 5 vendors and recommend one" — Claude reasons deeply
  │
  └─ Both report back to the same ClickUp task tree
      Full visibility, shared state, unified audit trail
```

**The key insight:** Super Agents are excellent employees for well-defined work. Claude (via Clawup) is the senior thinker who handles novel problems, makes judgment calls, and produces work that requires deep reasoning. They share the same workspace.

---

## Use Cases

### Where Clawup Adds Value Over Super Agents Alone

**Complex reasoning tasks:**
```
"Evaluate whether we should build or buy a customer data platform.
 Consider our current stack, team size, budget, and 3-year roadmap."
→ Claude researches, analyzes, produces a structured recommendation
  with pros/cons, cost projections, and risk assessment
→ Posts findings as ClickUp comments with a recommendation
→ Creates subtasks for next steps based on the decision
```

**Software development:**
```
"Implement user authentication with OAuth"
→ Claude Code: branches, writes code, runs tests, creates PR
→ Also creates ClickUp subtasks: documentation, QA plan, security review
→ ClickUp automations notify the team via Slack when PR is ready
```

**Novel business operations:**
```
"Plan a team offsite in DC for 50 people. Budget: $15K."
→ Claude: web research, vendor comparison, email drafting, budget planning
→ ClickUp-native: sends emails, creates calendar events, posts to Slack
→ All through the approval workflow — human reviews, ClickUp executes
```

**Cross-functional coordination:**
```
"We're launching v2.0 next month. Coordinate eng, marketing, and sales."
→ Claude decomposes into department-specific subtask trees
→ Engineering: code tasks processed by Clawup + Claude Code
→ Marketing: content tasks — some handled by Super Agents, complex ones by Claude
→ Sales: outreach tasks — emails sent via ClickUp Email ClickApp
→ All visible in one ClickUp task hierarchy
```

### Where Super Agents Are Better (Let Them Handle It)

- Daily/weekly status reports
- Meeting note summaries
- Routine email digests
- Simple task triage and assignment
- Template-based document generation
- Standard onboarding workflows

Clawup shouldn't try to do these. Super Agents are purpose-built for them.

---

## The Clawup CLI

### Setup

```bash
# Install
npm install -g clawup

# Interactive setup:
# - Connects to ClickUp API
# - Creates Space with the 8-status workflow
# - Configures custom fields (email_to, email_subject, etc.)
# - Sets up ClickUp automations for the approval→execute pattern
# - Connects ClickUp MCP server
# - Configures additional MCP servers (code, web, custom)
clawup --setup

# Validate everything
clawup --check
```

### Running

```bash
# Start the agent — polls ClickUp, processes tasks
clawup

# Process a single task
clawup --once CU-abc123

# With verbose output
clawup --verbose
```

### Configuration (`clawup.config.mjs`)

```javascript
export default {
  // Custom instructions for Claude
  prompt: `
    You are an operations assistant for Acme Corp.
    Our company is a B2B SaaS startup with 50 employees in Austin, TX.
    When contacting vendors, always mention we're a growing startup.
    Budget approvals over $5,000 need CFO sign-off — create a separate
    approval task assigned to @sarah.
  `,

  // ClickUp-native actions (these use automations, not MCP)
  clickupNative: {
    email: true,      // Email ClickApp is connected
    calendar: true,   // Google Calendar integration active
    slack: true,      // Slack integration active
  },

  // MCP servers to connect
  mcpServers: {
    clickup: 'https://mcp.clickup.com/mcp',  // Official ClickUp MCP
    // Add custom MCP servers as needed
  },

  // Actions requiring human approval
  gatedActions: ['email', 'calendar_event', 'slack_message', 'git_push'],

  // Maximum subtask depth
  maxDepth: 3,
};
```

---

## Why This Matters for ClickUp

### Clawup Makes ClickUp's Ecosystem More Valuable

Every ClickUp integration — Gmail, Google Calendar, Slack, HubSpot — becomes more valuable when an AI agent is creating the right tasks and triggering the right automations. Clawup doesn't compete with ClickUp's native capabilities. It **drives more usage of them**.

- More emails sent through Email ClickApp
- More calendar events created through Calendar integration
- More Slack messages through Slack integration
- More tasks, comments, and subtasks created
- More automations triggered

**Clawup is a power user of ClickUp**, not a replacement for any part of it.

### The Compound Effect

```
ClickUp alone:          Human creates tasks → human does work → human updates tasks
Super Agents alone:     Human creates tasks → agent handles routine work → human handles complex work
Clawup + Super Agents:  Human creates tasks → Claude plans and reasons → ClickUp executes
                        → Super Agents handle routine pieces → Claude handles complex pieces
                        → humans only make decisions
```

Each layer reduces the human effort required. Together, they approach the vision: **humans make decisions, software does the work.**

### Revenue Opportunity

Clawup as an open-source tool drives ClickUp adoption and feature usage:
- Teams adopt ClickUp specifically because Clawup works with it
- Teams upgrade to Business+ for Email ClickApp, advanced automations
- Teams pay for Brain/Super Agents for routine work alongside Clawup for complex work
- Teams connect more integrations (Gmail, Calendar, Slack) because Clawup uses them
- ClickUp could acquire or partner with Clawup for a hosted version

---

## Roadmap

### Phase 1: Foundation (Now → 3 months)
- Core ClickUp API integration (tasks, comments, statuses, custom fields)
- ClickUp MCP server connection for workspace context
- Web research via MCP (search, read pages)
- Recursive task expansion with depth control
- The 8-status workflow with `clawup --setup`
- Research and analysis use cases work end-to-end

### Phase 2: ClickUp-Native Execution (3 → 6 months)
- Custom field schema for email, calendar, and Slack actions
- Automation templates: "approved" status triggers native execution
- Email flow: Claude drafts → human approves → Email ClickApp sends → reply threads back
- Calendar flow: Claude proposes → human approves → Calendar integration creates event
- `clawup --setup` configures all automations automatically
- Event planning and vendor outreach work end-to-end

### Phase 3: Code + Deliverables (6 → 9 months)
- Claude Code integration for full software development lifecycle
- PR workflow: branch → code → test → commit → push → PR → review
- ClickUp Docs integration (via MCP) for document deliverables
- Task-to-PR linking with ClickUp's GitHub integration
- Software development use cases work end-to-end

### Phase 4: Intelligence + Platform (9 → 12 months)
- Context threading: Claude reads parent/sibling tasks via ClickUp MCP
- Cross-task learning from comment history and past decompositions
- Community MCP server registry (let anyone extend Clawup)
- Super Agent coordination (Clawup creates tasks that Super Agents pick up)
- Hosted Clawup option

---

## The Endgame

ClickUp built the body: integrations, automations, native email, calendar, Slack, 500+ skills.

Clawup brings the brain: Claude's reasoning, planning, code generation, and judgment.

**ClickUp for everything it can do. MCP for the rest. Claude for the thinking.**

The work gets done.
