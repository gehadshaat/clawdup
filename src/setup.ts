// Interactive setup wizard for clawup.
// Writes .clawup.env in the current working directory.

import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((res) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      res(answer.trim() || defaultValue);
    });
  });
}

interface ListResponse {
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

export async function runSetup(): Promise<void> {
  const cwd = process.cwd();
  const envPath = resolve(cwd, ".clawup.env");

  console.log(`
╔══════════════════════════════════════════════╗
║   clawup - Setup Wizard          ║
╚══════════════════════════════════════════════╝
`);

  console.log(`Project directory: ${cwd}\n`);

  if (existsSync(envPath)) {
    const overwrite = await ask(
      ".clawup.env already exists. Overwrite? (y/N)",
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
  console.log("  1. Poll a ClickUp list (all tasks in a list)");
  console.log("  2. Poll subtasks of a parent task\n");

  const sourceMode = await ask("Choose (1 or 2)", "1");
  const useParentTask = sourceMode === "2";

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
              '  Run "clawup --statuses" to see the full recommended setup.',
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
  } else {
    console.log(
      '\nFind your List ID: Open the list in ClickUp > click "..." > "Copy Link"',
    );
    console.log("The list ID is the number at the end of the URL.\n");

    listId = await ask("ClickUp List ID");
    if (!listId) {
      console.error("List ID is required. Aborting.");
      rl.close();
      process.exit(1);
    }

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
          '  Run "clawup --statuses" to see the full recommended setup.',
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

  const envContent = `# clawup Configuration
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
  console.log(`\n.clawup.env written to: ${envPath}`);

  // Remind about .gitignore
  const gitignorePath = resolve(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".clawup.env")) {
      console.log("\n  Remember to add .clawup.env to your .gitignore!");
    }
  }

  console.log(`
╔══════════════════════════════════════════════╗
║              Setup Complete!                  ║
╚══════════════════════════════════════════════╝

Next steps:
  1. Set up the recommended statuses in your ClickUp list:
     clawup --statuses

  2. Validate your configuration:
     clawup --check

  3. Start the automation:
     clawup

  4. Or process a single task:
     clawup --once <task-id>
`);

  rl.close();
}
