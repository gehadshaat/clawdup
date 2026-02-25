// Interactive setup wizard for clawdup.
// Writes .clawdup.env in the current working directory.

import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Extracts a ClickUp list ID from a URL or returns the input as-is if it's already a raw ID.
 * Supports URLs like: https://app.clickup.com/{workspace}/v/li/{list_id}
 */
function extractListId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/li\/(\d+)/);
  if (match) return match[1];
  return trimmed;
}

function ask(question: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((res) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      res(answer.trim() || defaultValue);
    });
  });
}

interface ListResponse {
  id: string;
  name: string;
  statuses: { status: string }[];
}

interface TaskResponse {
  id: string;
  name: string;
  url: string;
  list?: { id: string };
  subtasks?: { id: string; name: string; status: { status: string } }[];
}

interface TeamResponse {
  teams: { id: string; name: string }[];
}

interface SpaceResponse {
  spaces: { id: string; name: string }[];
}

const DEFAULT_STATUSES = [
  { status: "to do", color: "#d3d3d3" },
  { status: "in progress", color: "#4194f6" },
  { status: "in review", color: "#a875ff" },
  { status: "approved", color: "#2ecd6f" },
  { status: "require input", color: "#f9d900" },
  { status: "blocked", color: "#f44336" },
  { status: "complete", color: "#6bc950" },
];

/**
 * Extract a space ID from a ClickUp space URL.
 * Example: https://app.clickup.com/12345678/v/s/90123456 -> 90123456
 */
function extractSpaceIdFromUrl(url: string): string | null {
  const match = url.match(/\/s\/(\d+)/);
  return match ? match[1]! : null;
}

/**
 * Fetch workspaces/teams for the given API token.
 */
async function fetchTeams(apiToken: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch("https://api.clickup.com/api/v2/team", {
    headers: { Authorization: apiToken },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as TeamResponse;
  return data.teams || [];
}

/**
 * Fetch spaces in a workspace.
 */
async function fetchSpaces(apiToken: string, teamId: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`https://api.clickup.com/api/v2/team/${teamId}/space`, {
    headers: { Authorization: apiToken },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as SpaceResponse;
  return data.spaces || [];
}

/**
 * Create a folderless list in a space with the default statuses.
 */
async function createListInSpace(
  apiToken: string,
  spaceId: string,
  listName: string,
): Promise<ListResponse> {
  const res = await fetch(`https://api.clickup.com/api/v2/space/${spaceId}/list`, {
    method: "POST",
    headers: {
      Authorization: apiToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: listName,
      statuses: DEFAULT_STATUSES,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return (await res.json()) as ListResponse;
}

/**
 * Prompt to select a space, either by choosing from the list or pasting a URL.
 */
async function selectSpace(apiToken: string): Promise<string> {
  console.log("\nHow do you want to specify the space?");
  console.log("  1. Select from your workspaces");
  console.log("  2. Paste a space URL or ID\n");

  const method = await ask("Choose (1 or 2)", "1");

  if (method === "2") {
    const input = await ask("Space URL or ID");
    if (!input) {
      throw new Error("Space URL or ID is required.");
    }
    const extracted = extractSpaceIdFromUrl(input);
    return extracted || input;
  }

  // Fetch teams
  console.log("\nFetching your workspaces...");
  const teams = await fetchTeams(apiToken);
  if (teams.length === 0) {
    throw new Error("No workspaces found for this API token.");
  }

  let teamId: string;
  if (teams.length === 1) {
    teamId = teams[0]!.id;
    console.log(`  Workspace: ${teams[0]!.name}`);
  } else {
    console.log("\nSelect a workspace:");
    for (let i = 0; i < teams.length; i++) {
      console.log(`  ${i + 1}. ${teams[i]!.name}`);
    }
    const choice = await ask(`Choose (1-${teams.length})`, "1");
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= teams.length) {
      throw new Error("Invalid selection.");
    }
    teamId = teams[idx]!.id;
  }

  // Fetch spaces
  console.log("\nFetching spaces...");
  const spaces = await fetchSpaces(apiToken, teamId);
  if (spaces.length === 0) {
    throw new Error("No spaces found in this workspace.");
  }

  console.log("\nSelect a space:");
  for (let i = 0; i < spaces.length; i++) {
    console.log(`  ${i + 1}. ${spaces[i]!.name}`);
  }
  const spaceChoice = await ask(`Choose (1-${spaces.length})`, "1");
  const spaceIdx = parseInt(spaceChoice) - 1;
  if (spaceIdx < 0 || spaceIdx >= spaces.length) {
    throw new Error("Invalid selection.");
  }

  return spaces[spaceIdx]!.id;
}

/**
 * Check that required CLI tools (git, gh, claude) are installed and configured.
 * Prints warnings for missing tools but does not block setup.
 */
async function checkCliDependencies(): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  console.log("Checking CLI dependencies...\n");

  interface DepCheck {
    name: string;
    command: string;
    args: string[];
    installHint: string;
    format?: (stdout: string) => string;
  }

  const deps: DepCheck[] = [
    {
      name: "Git",
      command: "git",
      args: ["--version"],
      installHint: "https://git-scm.com/downloads",
      format: (s) => s.trim(),
    },
    {
      name: "GitHub CLI (gh)",
      command: "gh",
      args: ["--version"],
      installHint: "https://cli.github.com/",
      format: (s) => s.trim().split("\n")[0] || s.trim(),
    },
    {
      name: "Claude Code (claude)",
      command: "claude",
      args: ["--version"],
      installHint: "npm install -g @anthropic-ai/claude-code",
      format: (s) => s.trim(),
    },
  ];

  let allFound = true;
  for (const dep of deps) {
    try {
      const { stdout } = await execFileAsync(dep.command, dep.args, {
        timeout: 5000,
      });
      const version = dep.format ? dep.format(stdout) : stdout.trim();
      console.log(`  OK  ${dep.name}: ${version}`);
    } catch {
      console.log(`  MISSING  ${dep.name}`);
      console.log(`           Install: ${dep.installHint}`);
      allFound = false;
    }
  }

  // Check gh auth status if gh is available
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 10000 });
    console.log("  OK  GitHub CLI auth: authenticated");
  } catch (err) {
    const msg = (err as Error).message || "";
    if (!msg.includes("not found") && !msg.includes("ENOENT")) {
      console.log("  WARN  GitHub CLI auth: not authenticated");
      console.log("           Run: gh auth login");
    }
  }

  console.log("");
  if (!allFound) {
    console.log("  Some tools are missing. You can continue setup, but");
    console.log("  clawdup requires all of them to run. Install them later.\n");
  }
}

/**
 * Read clawdup's own version from its package.json.
 */
function getClawdupVersion(): string {
  try {
    const pkgPath = resolve(
      new URL(".", import.meta.url).pathname,
      "../package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "latest";
  }
}

/**
 * Add clawdup as a devDependency and convenience npm scripts to the
 * target project's package.json.  Safe to call multiple times — existing
 * scripts are not overwritten.
 */
export function addPackageJsonScripts(): boolean {
  const cwd = process.cwd();
  const pkgPath = resolve(cwd, "package.json");

  if (!existsSync(pkgPath)) {
    console.log("  No package.json found. Skipping package.json setup.");
    console.log("  Run 'npm init' first to create a package.json.\n");
    return false;
  }

  const raw = readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;

  let changed = false;

  // --- devDependencies ---
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  if (!devDeps.clawdup) {
    const version = getClawdupVersion();
    devDeps.clawdup = `^${version}`;
    pkg.devDependencies = devDeps;
    console.log(`  Added clawdup@^${version} to devDependencies`);
    changed = true;
  } else {
    console.log("  SKIP  clawdup already in devDependencies");
  }

  // --- npm scripts ---
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;

  const SCRIPTS_TO_ADD: [string, string][] = [
    ["cook", "clawdup"],
    ["cook:once", "clawdup --once"],
    ["vibe-check", "clawdup --doctor"],
    ["clawdup:check", "clawdup --check"],
    ["clawdup:setup", "clawdup --setup"],
    ["clawdup:init", "clawdup --init"],
  ];

  for (const [name, cmd] of SCRIPTS_TO_ADD) {
    if (!scripts[name]) {
      scripts[name] = cmd;
      console.log(`  Added script: "${name}" → "${cmd}"`);
      changed = true;
    } else {
      console.log(`  SKIP  script "${name}" already exists`);
    }
  }

  pkg.scripts = scripts;

  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`\n  Updated: ${pkgPath}`);
  } else {
    console.log("\n  package.json already up to date.");
  }

  return changed;
}

export async function runSetup(): Promise<void> {
  const cwd = process.cwd();
  const envPath = resolve(cwd, ".clawdup.env");

  console.log(`
╔══════════════════════════════════════════════╗
║   clawdup - Setup Wizard          ║
╚══════════════════════════════════════════════╝
`);

  console.log(`Project directory: ${cwd}\n`);

  await checkCliDependencies();

  if (existsSync(envPath)) {
    const overwrite = await ask(
      ".clawdup.env already exists. Overwrite? (y/N)",
      "N",
    );
    if (overwrite.toLowerCase() !== "y") {
      console.log("Setup cancelled. Existing config preserved.");
      rl.close();
      return;
    }
  }

  console.log("Step 1: ClickUp Configuration");
  console.log("─".repeat(40));
  console.log("Get your API token from: ClickUp Settings > Apps > API Token\n");

  const apiToken = await ask("ClickUp API Token");
  if (!apiToken) {
    console.error("API token is required. Aborting.");
    rl.close();
    process.exit(1);
  }

  console.log("\nHow do you want to organize tasks?");
  console.log("  1. Use an existing ClickUp list");
  console.log("  2. Create a new list with default statuses");
  console.log("  3. Poll subtasks of a parent task\n");

  const sourceMode = await ask("Choose (1, 2, or 3)", "1");
  const useParentTask = sourceMode === "3";

  let listId = "";
  let parentTaskId = "";

  if (useParentTask) {
    console.log(
      "\nFind your parent task ID: Open the task in ClickUp > the ID is in the URL.",
    );
    console.log("Example: https://app.clickup.com/t/abc123 -> ID is abc123\n");

    parentTaskId = await ask("ClickUp Parent Task ID");
    if (!parentTaskId) {
      console.error("Parent Task ID is required. Aborting.");
      rl.close();
      process.exit(1);
    }

    // Validate the API token and parent task
    console.log("\nValidating ClickUp connection...");
    try {
      const res = await fetch(
        `https://api.clickup.com/api/v2/task/${parentTaskId}?include_subtasks=true`,
        { headers: { Authorization: apiToken } },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const task = (await res.json()) as TaskResponse;
      console.log(`  Connected to parent task: "${task.name}"`);
      const subtaskCount = task.subtasks?.length || 0;
      console.log(`  Current subtasks: ${subtaskCount}`);

      if (task.list?.id) {
        listId = task.list.id;
        // Validate statuses from the parent task's list
        const listRes = await fetch(
          `https://api.clickup.com/api/v2/list/${listId}`,
          { headers: { Authorization: apiToken } },
        );
        if (listRes.ok) {
          const list = (await listRes.json()) as ListResponse;
          console.log(
            `  List: "${list.name}" (statuses: ${list.statuses.map((s) => s.status).join(", ")})`,
          );

          const existing = list.statuses.map((s) => s.status.toLowerCase());
          const recommended = [
            "to do",
            "in progress",
            "in review",
            "approved",
            "require input",
            "blocked",
            "complete",
          ];
          const missing = recommended.filter((s) => !existing.includes(s));

          if (missing.length > 0) {
            console.log(
              `\n  Missing recommended statuses: ${missing.join(", ")}`,
            );
            console.log(
              '  Run "clawdup --statuses" to see the full recommended setup.',
            );
          } else {
            console.log("  All recommended statuses found!");
          }
        }
      }
    } catch (err) {
      console.error(`  Failed to validate: ${(err as Error).message}`);
      const cont = await ask("Continue anyway? (y/N)", "N");
      if (cont.toLowerCase() !== "y") {
        rl.close();
        process.exit(1);
      }
    }
  } else if (sourceMode === "2") {
    // Create a new list with default statuses
    console.log("\nCreate a new ClickUp list with the recommended statuses.");
    console.log("Statuses: " + DEFAULT_STATUSES.map((s) => s.status).join(", "));

    try {
      const spaceId = await selectSpace(apiToken);
      const listName = await ask("List name", "clawdup Tasks");
      if (!listName) {
        console.error("List name is required. Aborting.");
        rl.close();
        process.exit(1);
      }

      console.log(`\nCreating list "${listName}" in space ${spaceId}...`);
      const newList = await createListInSpace(apiToken, spaceId, listName);
      listId = newList.id;
      console.log(`  Created list: "${newList.name}" (ID: ${listId})`);
      console.log(
        `  Statuses: ${newList.statuses.map((s) => s.status).join(", ")}`,
      );
      console.log("  All recommended statuses configured!");
    } catch (err) {
      console.error(`  Failed to create list: ${(err as Error).message}`);
      const cont = await ask("Continue anyway with a manual List ID? (y/N)", "N");
      if (cont.toLowerCase() !== "y") {
        rl.close();
        process.exit(1);
      }
      listId = await ask("ClickUp List ID");
      if (!listId) {
        console.error("List ID is required. Aborting.");
        rl.close();
        process.exit(1);
      }
    }
  } else {
    console.log(
      '\nFind your List ID: Open the list in ClickUp > click "..." > "Copy Link"',
    );
    console.log("You can paste the full link or just the list ID.\n");

    const listInput = await ask("ClickUp List ID or link");
    if (!listInput) {
      console.error("List ID is required. Aborting.");
      rl.close();
      process.exit(1);
    }
    listId = extractListId(listInput);

    // Validate the API token and list
    console.log("\nValidating ClickUp connection...");
    try {
      const res = await fetch(
        `https://api.clickup.com/api/v2/list/${listId}`,
        { headers: { Authorization: apiToken } },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const list = (await res.json()) as ListResponse;
      console.log(`  Connected to list: "${list.name}"`);
      console.log(
        `  Current statuses: ${list.statuses.map((s) => s.status).join(", ")}`,
      );

      const existing = list.statuses.map((s) => s.status.toLowerCase());
      const recommended = [
        "to do",
        "in progress",
        "in review",
        "approved",
        "require input",
        "blocked",
        "complete",
      ];
      const missing = recommended.filter((s) => !existing.includes(s));

      if (missing.length > 0) {
        console.log(
          `\n  Missing recommended statuses: ${missing.join(", ")}`,
        );
        console.log(
          '  Run "clawdup --statuses" to see the full recommended setup.',
        );
      } else {
        console.log("  All recommended statuses found!");
      }
    } catch (err) {
      console.error(`  Failed to validate: ${(err as Error).message}`);
      const cont = await ask("Continue anyway? (y/N)", "N");
      if (cont.toLowerCase() !== "y") {
        rl.close();
        process.exit(1);
      }
    }
  }

  console.log("\n\nStep 2: Optional Configuration");
  console.log("─".repeat(40));

  const baseBranch = await ask("Base git branch", "main");
  const branchPrefix = await ask("Branch prefix for task branches", "clickup");
  const pollInterval = await ask("Poll interval in seconds", "30");
  const claudeTimeout = await ask("Claude timeout per task in seconds", "600");
  const maxTurns = await ask("Max Claude turns per task", "50");

  const clickupSourceLines = useParentTask
    ? `CLICKUP_PARENT_TASK_ID=${parentTaskId}`
    : `CLICKUP_LIST_ID=${listId}`;

  const envContent = `# clawdup Configuration
# Generated by setup wizard on ${new Date().toISOString()}

# ClickUp
CLICKUP_API_TOKEN=${apiToken}
${clickupSourceLines}

# Git
BASE_BRANCH=${baseBranch}
BRANCH_PREFIX=${branchPrefix}

# Polling
POLL_INTERVAL_MS=${parseInt(pollInterval) * 1000}

# Claude Code
CLAUDE_TIMEOUT_MS=${parseInt(claudeTimeout) * 1000}
CLAUDE_MAX_TURNS=${maxTurns}

# Log level (debug | info | warn | error)
LOG_LEVEL=info
`;

  writeFileSync(envPath, envContent);
  console.log(`\n.clawdup.env written to: ${envPath}`);

  // Remind about .gitignore
  const gitignorePath = resolve(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".clawdup.env")) {
      console.log("\n  Remember to add .clawdup.env to your .gitignore!");
    }
  }

  // Add clawdup to package.json with convenience scripts
  console.log("\nStep 3: Package.json Integration");
  console.log("─".repeat(40));
  addPackageJsonScripts();

  console.log(`
╔══════════════════════════════════════════════╗
║              Setup Complete!                  ║
╚══════════════════════════════════════════════╝

Next steps:
  1. Install dependencies:
     npm install

  2. Run a health check:
     npm run vibe-check

  3. Start the automation:
     npm run cook

  4. Or process a single task:
     npm run cook:once -- <task-id>

  5. Set up the recommended statuses in your ClickUp list:
     npx clawdup --statuses
`);

  rl.close();
}
