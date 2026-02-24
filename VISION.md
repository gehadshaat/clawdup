# Clawup: Managed OpenClaw for ClickUp

## The One-Liner

**Clawup is hosted OpenClaw, purpose-built for ClickUp. Connect your workspace, pick your tools, start creating tasks. Zero setup. Zero infrastructure.**

OpenClaw proved the model: a local AI agent with skills, MCP, and memory can automate real work. But it requires self-hosting, terminal comfort, skill curation, and security vigilance. Most ClickUp teams — ops managers, project leads, agency owners — will never run a Node.js process on their laptop.

Clawup takes OpenClaw's architecture and makes it a managed service, optimized end-to-end for ClickUp.

---

## Why Not Just OpenClaw?

OpenClaw is powerful. It's also 180k stars of self-hosted complexity.

| Dimension | OpenClaw (self-hosted) | Clawup (managed) |
|---|---|---|
| **Setup** | Install Node, configure gateway, find skills, set API keys, manage `openclaw.json` | Connect ClickUp OAuth, pick capabilities, done |
| **Hosting** | Runs on your laptop or server. Stops when you close the terminal. | Always-on cloud. Processes tasks 24/7. |
| **Skills** | 5,700+ on ClawHub — you curate, install, and audit each one | Pre-built ClickUp workflow engine + curated MCP servers. We handle compatibility. |
| **Security** | Community skills are [unaudited](https://www.crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/) — prompt injection, data exfiltration risks | Managed skill layer. We audit. We sandbox. Your ClickUp data stays controlled. |
| **ClickUp depth** | Two community skills (REST API wrapper + MCP passthrough) | Deep integration: status workflows, custom fields, automation templates, recursive task trees, approval-as-execution |
| **Updates** | Manual. You pull, you update skills, you fix breaking changes. | We ship updates. Workflows improve. New capabilities appear. |
| **Target user** | Developers, power users, tinkerers | Anyone who uses ClickUp — ops, project management, agencies, founders |
| **Reliability** | Your laptop's uptime | Cloud SLA. Retries. Monitoring. Alerting. |

**The analogy:** OpenClaw is Linux. Clawup is a managed cloud service built on it. Same power, packaged for people who have work to do.

---

## How It Works

### For the User

```
1. Go to clawup.com
2. Connect your ClickUp workspace (OAuth)
3. Pick a list (or let Clawup create one with the right statuses)
4. Choose capabilities: email, calendar, slack, code, web research
5. Write a task in ClickUp
6. Watch it get done
```

No CLI. No terminal. No `npm install`. No `openclaw.json`. No skill hunting.

### Under the Hood

```
┌──────────────────────────────────────────────────────────────┐
│                     CLAWUP CLOUD                             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              OPENCLAW-BASED AGENT RUNTIME             │    │
│  │                                                       │    │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐  │    │
│  │  │ ClickUp │  │  Claude   │  │     MCP Servers     │  │    │
│  │  │ Poller  │  │  (brain)  │  │  (curated, managed) │  │    │
│  │  │         │  │          │  │                     │  │    │
│  │  │ Watches │  │ Reasons  │  │ • ClickUp MCP      │  │    │
│  │  │ tasks,  │◄►│ Plans    │◄►│ • Web research     │  │    │
│  │  │ polls,  │  │ Decides  │  │ • Code (Claude)    │  │    │
│  │  │ syncs   │  │ Acts     │  │ • Email (if no     │  │    │
│  │  │         │  │          │  │   Email ClickApp)  │  │    │
│  │  └─────────┘  └──────────┘  │ • Custom           │  │    │
│  │                              └─────────────────────┘  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Workspace   │  │   Security    │  │   Monitoring     │   │
│  │   Isolation    │  │   Sandbox     │  │   & Alerting     │   │
│  │               │  │              │  │                  │   │
│  │ Each customer │  │ MCP calls    │  │ Task processing  │   │
│  │ gets isolated │  │ sandboxed.   │  │ status. Failures.│   │
│  │ agent runtime │  │ No cross-    │  │ Cost tracking.   │   │
│  │               │  │ tenant leak. │  │ Usage dashboards.│   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────┘
           │                    │                  │
           ▼                    ▼                  ▼
    ClickUp Platform      External APIs       GitHub/GitLab
    • Tasks, Comments      • Web search        • PRs, branches
    • Email ClickApp       • Custom APIs       • Code repos
    • Calendar sync        • Data sources
    • Slack integration
    • Automations
```

**Key architecture decisions:**

1. **OpenClaw core** — we don't reinvent the agent runtime. OpenClaw's gateway, memory, and skill architecture are battle-tested. We build on it.

2. **Managed MCP layer** — instead of users hunting for MCP servers on ClawHub, we curate and host the servers that matter for ClickUp workflows. We audit them. We version them. We handle auth.

3. **ClickUp-native first** — when ClickUp can do it (send email via Email ClickApp, create calendar events, post to Slack), we use ClickUp. MCP only for things ClickUp can't do natively.

4. **Always-on** — the agent doesn't stop when you close your laptop. It runs in the cloud, polls continuously, processes tasks when they appear, follows up when things are due.

5. **Workspace isolation** — each customer gets an isolated agent runtime. No shared state. No cross-tenant data leakage.

---

## The ClickUp Integration: Deeper Than a Skill

OpenClaw's ClickUp integration is two community skills — a REST API wrapper and an MCP passthrough. They let you create and read tasks. That's table stakes.

Clawup goes much deeper:

### The Status Workflow Engine

Clawup configures your ClickUp list with a purpose-built status system:

| Status | Purpose |
|--------|---------|
| **to do** | Ready for the agent to pick up |
| **in progress** | Agent is actively working |
| **pending approval** | Agent prepared an action — needs human sign-off |
| **approved** | Human approved — triggers execution |
| **needs input** | Agent is stuck — needs human clarification |
| **waiting** | Paused on external party |
| **complete** | Done |
| **cancelled** | Not doing this |

These aren't just labels. They're **control flow**:

- `to do` → agent picks up automatically
- `pending approval` → agent stops and waits for human
- `approved` → ClickUp automations fire (send email, create event, post to Slack)
- `needs input` → human gets notified, adds context, agent resumes

**"Approved" is the execution trigger.** When a human moves a task to "approved," pre-configured ClickUp automations do the actual work. The status change IS the command. No extra API calls needed from the agent.

### Recursive Task Decomposition

When Claude encounters a complex task, it doesn't try to do everything at once:

```
Task: "Plan Q1 marketing campaign"
  │
  Claude creates subtasks in ClickUp:
  ├── "Analyze Q4 campaign performance" → to do (agent picks up)
  ├── "Research competitor campaigns" → to do (agent picks up)
  ├── "Draft campaign strategy doc" → to do (depends on research)
  ├── "Create content calendar" → to do (depends on strategy)
  └── "Draft launch email sequence" → to do (depends on calendar)
  │
  Clawup sees new "to do" subtasks → picks them up → processes them
  Each subtask may create MORE subtasks
  Work cascades down the tree until everything is "complete"
  Parent task auto-completes when all children are done
```

OpenClaw doesn't do this. It processes one message at a time. Clawup manages a **task tree** — the ClickUp hierarchy IS the agent's plan, and the poll loop IS the execution engine.

### Custom Field Schemas

Clawup sets up custom fields that bridge Claude's intent to ClickUp's automations:

```
When Claude wants to send an email:
  → Creates subtask with custom fields:
    • email_to: vendor@example.com
    • email_subject: Venue inquiry
    • email_body: <drafted by Claude>
    • status: pending approval

When human approves:
  → ClickUp automation reads custom fields
  → Email ClickApp sends via linked Gmail
  → Status moves to "waiting"
  → Reply threads back as comment on task
  → Claude reads reply on next poll cycle
```

This pattern works for email, calendar events, Slack messages, CRM updates — any ClickUp integration becomes an execution channel for the agent, gated by human approval.

### Automation Templates

`clawup --setup` (or the web onboarding) configures ClickUp automations automatically:

- "Approved" + email fields → send email via Email ClickApp
- "Approved" + event fields → create Google Calendar event
- "Approved" + slack fields → post to Slack channel
- All children complete → mark parent complete
- Task overdue → notify assigned human

These automations are the bridge between Claude's decisions and real-world execution.

---

## The Three Layers of Execution

### Layer 1: ClickUp API (Always)
Create tasks, update statuses, post comments, manage checklists. All state lives in ClickUp.

### Layer 2: ClickUp-Native Integrations (When Available)
Email ClickApp, Calendar sync, Slack integration, CRM connectors. Triggered by status changes and automations. No extra credentials — uses what the team already connected.

### Layer 3: MCP Servers (For the Rest)
Managed, curated, audited:

| MCP Server | What It Does | When Used |
|---|---|---|
| **ClickUp MCP** (official) | Deep workspace search, Docs, cross-space queries | Always — gives Claude full workspace context |
| **Web research** | Search the web, read pages, extract data | Research tasks, competitive analysis, vendor scouting |
| **Code** (Claude Code) | Full software engineering — edit, test, commit, PR | Development tasks |
| **Custom** (per-customer) | Domain-specific APIs, internal tools | Customer brings their own MCP servers |

**The decision flow:**
```
Claude needs to act
  ├─ Can ClickUp do it natively? → Use ClickUp (Layer 2)
  ├─ Need deeper ClickUp data? → ClickUp MCP (Layer 3)
  ├─ Need external capability? → Other MCP server (Layer 3)
  └─ None of the above? → Break it down further or ask human
```

---

## The Event Planning Example

**Task: "Plan a team offsite in DC for 50 people. Budget: $15K. Date: March 20."**

```
Claude picks up the task:

PLANNING (minutes 1-5):
├── Posts comment: "Breaking this into venue, catering, logistics,
│   and communications."
├── Creates subtask: "Research venue options in DC" → to do
├── Creates subtask: "Research catering vendors" → to do
├── Creates subtask: "Draft invitation email" → to do
└── Creates subtask: "Create budget tracker" → to do

RESEARCH (minutes 5-15, via web MCP):
├── "Research venues" → in progress
│   Web search, reads venue sites, compares pricing
│   Posts findings as comment with 4 options
│   Creates contact subtasks with email custom fields:
│     "Contact The Hamilton" → pending approval
│       (email_to: events@thehamiltondc.com, email_body: <drafted>)
│     "Contact 600F Loft" → pending approval
│     "Contact Eastern Market" → pending approval
│   Moves "Research venues" → complete
│
├── "Draft invitation" → in progress → complete (posted as comment)
└── "Budget tracker" → in progress → complete (added as checklist)

HUMAN REVIEWS (async, whenever):
├── Approves "Contact The Hamilton"
│   → ClickUp Email automation sends the inquiry via linked Gmail
│   → Status moves to "waiting"
│   (No MCP. No extra credentials. ClickUp did it.)
│
├── Approves "Contact 600F Loft" → same
├── Cancels Eastern Market
└── Comments: "Make the invite more casual"

NEXT CYCLE:
├── Claude sees casual comment → rewrites invite in new comment
├── Hamilton replies (threaded into task by Email ClickApp)
│   Claude reads reply: "Available March 20. $3,700 with AV."
│   Creates subtask: "Confirm Hamilton booking — $3,700" → pending approval
│     (email_to, confirmation body pre-filled)
└── Creates follow-up for 600F with Thursday due date

HUMAN APPROVES booking → ClickUp sends confirmation → done.
```

**Claude did:** All the thinking. Research, comparison, drafting, planning, follow-up scheduling.
**ClickUp did:** All the executing. Sent emails, threaded replies, fired automations.
**MCP did:** Web research (the only thing neither Claude nor ClickUp handles natively).
**Human did:** ~10 minutes of reading and approving.

---

## Why Managed Beats Self-Hosted for This Use Case

### 1. The Buyer Isn't a Developer

The people who manage ClickUp workspaces — ops managers, project leads, agency owners, founders — aren't going to `npm install` anything. They need a product, not a toolkit.

OpenClaw's ClickUp user posted on Skool, not GitHub. They're running a $100k/mo client implementation. They want results, not configuration files.

### 2. Always-On Matters

A self-hosted OpenClaw agent stops when your laptop sleeps. Business tasks don't:

- Follow-up emails need to send on Thursday morning
- Vendor replies arrive at 3 AM
- Approval tasks should process immediately, not when you open your terminal

Clawup runs in the cloud. Tasks process 24/7. Due dates trigger on schedule. The agent doesn't sleep.

### 3. Security Is Non-Negotiable

OpenClaw community skills have [documented security issues](https://www.crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/) — prompt injection, data exfiltration, credential theft. When you're connecting an agent to your business's ClickUp workspace (with client data, employee info, financial details), you need:

- Audited MCP servers, not community grab-bags
- Workspace isolation between customers
- Sandboxed execution for all tool calls
- Audit logs for every action the agent takes
- SOC 2 / compliance path

Clawup provides this. Self-hosted OpenClaw doesn't.

### 4. ClickUp-Specific Optimization

Generic agents waste tokens figuring out ClickUp's API quirks, status semantics, and custom field schemas. Clawup's agent comes pre-trained on ClickUp patterns:

- Knows the 8-status workflow and when to use each status
- Knows how to structure custom fields for automation triggers
- Knows how to decompose tasks into ClickUp subtree hierarchies
- Knows how to read context from parent/sibling tasks
- Knows the difference between "post a comment" and "create a subtask"

This isn't just prompt engineering. It's the difference between a general contractor and a ClickUp specialist.

### 5. The Upgrade Path from Super Agents

Many ClickUp teams already use Super Agents for simple automation. When they hit limits — tasks too complex, reasoning too shallow, code not real — they need an upgrade path. Clawup is that path:

```
Super Agents: "Summarize this task"    → works great
Super Agents: "Plan a product launch"  → too complex, shallow output

Clawup:       "Plan a product launch"  → decomposes into 15 subtasks,
              researches competitors, drafts strategy doc, creates
              timeline, assigns owners, sets up review gates
```

Same ClickUp workspace. Same task hierarchy. Just a smarter agent on the complex work.

---

## Coexistence with Super Agents

Clawup doesn't replace Super Agents. It complements them:

| Work Type | Who Handles It |
|---|---|
| Daily standup summaries | Super Agent |
| Routine email digests | Super Agent |
| Simple task triage | Super Agent |
| Template doc generation | Super Agent |
| **Complex multi-step planning** | **Clawup** |
| **Novel research + analysis** | **Clawup** |
| **Software engineering (real PRs)** | **Clawup** |
| **Cross-functional coordination** | **Clawup** |
| **Vendor evaluation + outreach** | **Clawup** |

Claude (via Clawup) can even create subtasks that Super Agents pick up. The complex brain delegates routine execution to the simple workers. Same task tree, multiple agents, unified visibility.

---

## Product Tiers

### Free Tier
- 1 ClickUp list
- 50 tasks/month
- Web research + ClickUp MCP
- Community support
- "Powered by Clawup" comment on tasks

### Pro ($49/mo)
- Unlimited lists
- 500 tasks/month
- Email, Calendar, Slack via ClickUp-native patterns
- Custom MCP servers (bring your own)
- Priority processing
- Usage dashboard

### Team ($149/mo)
- Everything in Pro
- 2,000 tasks/month
- Multiple agent personalities (ops agent, dev agent, sales agent)
- Team-wide memory (agent learns your company's patterns)
- Approval routing rules
- Audit logs + compliance exports

### Enterprise (Custom)
- Unlimited tasks
- Dedicated infrastructure (single-tenant)
- Custom MCP server development
- SOC 2 compliance
- SLA guarantees
- Onboarding + training

---

## Roadmap

### Phase 1: Core Platform (Now → 3 months)
- OpenClaw-based agent runtime, hosted in cloud
- ClickUp OAuth connection + workspace setup
- 8-status workflow auto-configuration
- Recursive task decomposition with depth control
- ClickUp API integration (tasks, comments, statuses, custom fields)
- ClickUp MCP + web research MCP (managed)
- Web dashboard: connect workspace, monitor tasks, track usage
- Research and analysis use cases work end-to-end

### Phase 2: ClickUp-Native Execution (3 → 6 months)
- Custom field schemas for email, calendar, Slack actions
- ClickUp automation templates (approved → execute)
- Email flow: draft → approve → Email ClickApp sends → reply threads back
- Calendar flow: propose → approve → Google Calendar creates event
- Onboarding wizard configures automations automatically
- Event planning, vendor outreach, communications work end-to-end

### Phase 3: Code + Pro Features (6 → 9 months)
- Claude Code integration for software engineering tasks
- PR workflow: branch → code → test → commit → push → PR
- Multiple agent personalities per workspace
- Team memory: agent learns from past tasks and decisions
- Custom MCP server connections (bring your own)
- Usage dashboards, cost tracking, approval analytics

### Phase 4: Enterprise + Marketplace (9 → 12 months)
- Single-tenant deployments
- SOC 2 certification
- MCP server marketplace (curated, audited extensions)
- Super Agent coordination (Clawup creates tasks for Super Agents)
- Public API for programmatic agent management
- ClickUp native app integration (button in ClickUp UI)

---

## The Endgame

OpenClaw proved that local AI agents can do real work. ClickUp proved that project management can be the everything app. Super Agents proved that native AI in PM tools has demand.

Clawup combines all three: OpenClaw's agent architecture, ClickUp's execution platform, Claude's reasoning — packaged as a managed service for the people who actually run businesses on ClickUp.

**No terminal. No configuration. No skill hunting. No security anxiety.**

Connect your workspace. Create a task. The work gets done.
