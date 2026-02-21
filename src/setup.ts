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
  list: { id: string; name: string };
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

  console.log("\nHow do you want to select tasks?");
  console.log("  1. Poll an entire ClickUp list");
  console.log("  2. Poll subtasks of a specific parent task\n");

  const modeChoice = await ask("Choose mode (1 or 2)", "1");

  let listId = "";
  let parentTaskId = "";

  if (modeChoice === "2") {
    // Parent task mode
    console.log(
      '\nFind your task ID: Open the task in ClickUp > click "..." > "Copy Link"',
    );
    console.log("The task ID is the alphanumeric string at the end of the URL.\n");

    parentTaskId = await ask("ClickUp Parent Task ID");
    if (!parentTaskId) {
      console.error("Parent Task ID is required. Aborting.");
      rl.close();
      process.exit(1);
    }

    // Validate the parent task and derive the list
    console.log("\nValidating ClickUp connection...");
    try {
      const taskRes = await fetch(
        `https://api.clickup.com/api/v2/task/${parentTaskId}`,
        { headers: { Authorization: apiToken } },
      );
      if (!taskRes.ok) {
        const text = await taskRes.text();
        throw new Error(`API error ${taskRes.status}: ${text}`);
      }
      const task = (await taskRes.json()) as TaskResponse;
      console.log(`  Parent task: "${task.name}"`);
      console.log(`  In list: "${task.list.name}" (${task.list.id})`);
      listId = task.list.id;

      // Validate statuses on the derived list
      const listRes = await fetch(
        `https://api.clickup.com/api/v2/list/${listId}`,
        { headers: { Authorization: apiToken } },
      );
      if (listRes.ok) {
        const list = (await listRes.json()) as ListResponse;
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
    // List mode
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

  const clickupConfig = parentTaskId
    ? `CLICKUP_PARENT_TASK_ID=${parentTaskId}\n# List ID derived from parent task (can override if needed)\n# CLICKUP_LIST_ID=${listId}`
    : `CLICKUP_LIST_ID=${listId}`;

  const envContent = `# clawup Configuration
# Generated by setup wizard on ${new Date().toISOString()}

# ClickUp
CLICKUP_API_TOKEN=${apiToken}
${clickupConfig}

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
