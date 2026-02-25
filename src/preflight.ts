// Preflight environment health checks.
// Validates git state, remote connectivity, lock file status, and ClickUp
// connectivity before the main runner proceeds. Can also be invoked manually
// via `clawdup --doctor`.

import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { BASE_BRANCH, GIT_ROOT, PROJECT_ROOT, CLICKUP_API_TOKEN, DRY_RUN } from "./config.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

const LOCK_FILE_PATH = resolve(PROJECT_ROOT, ".clawdup.lock");

/**
 * Check whether a given PID belongs to a running Clawdup/Node process.
 * Returns `true` if the process is alive and appears to be clawdup (or we
 * cannot tell because we're not on Linux). Returns `false` if the process
 * is dead or is alive but clearly not a node/clawdup process (PID reuse).
 */
function isClawdupProcess(pid: number): boolean {
  // Self-check: if the lock was written by this process, it's ours.
  if (pid === process.pid) return true;

  // Is the process alive at all?
  try {
    process.kill(pid, 0);
  } catch {
    return false; // process is dead
  }

  // Process is alive — try to verify it's actually node/clawdup on Linux.
  if (process.platform === "linux") {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").toLowerCase();
      return cmdline.includes("node") || cmdline.includes("clawdup");
    } catch {
      // Can't read /proc entry (permissions, race) — assume it could be clawdup.
      return true;
    }
  }

  // Non-Linux: no /proc, so assume it could be clawdup.
  return true;
}

export interface PreflightCheckResult {
  name: string;
  ok: boolean;
  message: string;
  fix?: string;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheckResult[];
}

/**
 * Run a git command in the repo root. Returns stdout or throws.
 */
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: GIT_ROOT,
    timeout: 15000,
  });
  return stdout.trim();
}

/**
 * Check that the git working tree is clean (no uncommitted changes).
 */
async function checkCleanWorkingTree(): Promise<PreflightCheckResult> {
  try {
    const status = await git("status", "--porcelain");
    if (status.length > 0) {
      const fileCount = status.split("\n").filter(Boolean).length;
      return {
        name: "Clean working tree",
        ok: false,
        message: `${fileCount} uncommitted change(s) detected.`,
        fix: `Commit or stash your changes: git stash or git add -A && git commit -m "WIP"`,
      };
    }
    return { name: "Clean working tree", ok: true, message: "Working tree is clean." };
  } catch (err) {
    return {
      name: "Clean working tree",
      ok: false,
      message: `Could not check working tree: ${(err as Error).message}`,
      fix: "Ensure you are inside a git repository.",
    };
  }
}

/**
 * Check for in-progress git operations (merge, rebase, cherry-pick).
 */
async function checkNoInProgressOps(): Promise<PreflightCheckResult> {
  const gitDir = resolve(GIT_ROOT, ".git");
  const ops: { name: string; indicator: string; abort: string }[] = [
    { name: "merge", indicator: resolve(gitDir, "MERGE_HEAD"), abort: "git merge --abort" },
    { name: "rebase", indicator: resolve(gitDir, "rebase-merge"), abort: "git rebase --abort" },
    { name: "rebase (apply)", indicator: resolve(gitDir, "rebase-apply"), abort: "git rebase --abort" },
    { name: "cherry-pick", indicator: resolve(gitDir, "CHERRY_PICK_HEAD"), abort: "git cherry-pick --abort" },
  ];

  const active: string[] = [];
  const fixes: string[] = [];

  for (const op of ops) {
    if (existsSync(op.indicator)) {
      active.push(op.name);
      fixes.push(op.abort);
    }
  }

  if (active.length > 0) {
    return {
      name: "No in-progress git operations",
      ok: false,
      message: `In-progress operation(s): ${active.join(", ")}.`,
      fix: `Abort or complete the operation(s): ${fixes.join(" or ")}`,
    };
  }

  return { name: "No in-progress git operations", ok: true, message: "No in-progress operations." };
}

/**
 * Check that the remote is reachable and the base branch exists.
 */
async function checkRemoteAndBaseBranch(): Promise<PreflightCheckResult> {
  try {
    await git("fetch", "origin", "--dry-run");
  } catch (err) {
    return {
      name: "Remote reachable",
      ok: false,
      message: `Cannot reach remote "origin": ${(err as Error).message}`,
      fix: "Check your network connection and git remote configuration: git remote -v",
    };
  }

  try {
    await git("rev-parse", "--verify", `origin/${BASE_BRANCH}`);
  } catch {
    return {
      name: "Remote reachable",
      ok: false,
      message: `Base branch "origin/${BASE_BRANCH}" does not exist on remote.`,
      fix: `Ensure the branch "${BASE_BRANCH}" exists on the remote, or set BASE_BRANCH in .clawdup.env.`,
    };
  }

  return {
    name: "Remote reachable",
    ok: true,
    message: `Remote "origin" is reachable and "${BASE_BRANCH}" exists.`,
  };
}

/**
 * Check for a stale or conflicting .clawdup.lock file.
 *
 * Auto-cleans stale locks (dead PID, PID reuse, self-owned) so that
 * `acquireLock()` in the runner doesn't need a separate cleanup path.
 */
function checkLockFile(): PreflightCheckResult {
  if (!existsSync(LOCK_FILE_PATH)) {
    return { name: "Lock file", ok: true, message: "No lock file present." };
  }

  try {
    const raw = readFileSync(LOCK_FILE_PATH, "utf-8");
    const data = JSON.parse(raw) as { pid: number; startedAt: string };

    if (!isClawdupProcess(data.pid)) {
      // Process is either dead or alive-but-not-clawdup (PID reuse).
      // Either way the lock is stale — clean it up.
      unlinkSync(LOCK_FILE_PATH);

      let reason: string;
      try {
        process.kill(data.pid, 0);
        // Process is alive but not clawdup → PID reuse
        reason = `PID ${data.pid} is alive but is not a Clawdup process (PID reuse)`;
      } catch {
        reason = `PID ${data.pid} is no longer running`;
      }

      return {
        name: "Lock file",
        ok: true,
        message: `Stale lock removed (${reason}).`,
      };
    }

    // isClawdupProcess returned true — the lock owner is (or might be) a
    // live Clawdup instance.
    if (data.pid === process.pid) {
      return {
        name: "Lock file",
        ok: true,
        message: "Lock file belongs to the current process.",
      };
    }

    return {
      name: "Lock file",
      ok: false,
      message: `Another Clawdup instance is running (PID ${data.pid}, started ${data.startedAt}).`,
      fix: `Wait for the other instance to finish, or stop it and remove ${LOCK_FILE_PATH}`,
    };
  } catch {
    // Corrupted lock file — auto-clean it.
    try { unlinkSync(LOCK_FILE_PATH); } catch { /* already gone */ }
    return {
      name: "Lock file",
      ok: true,
      message: "Removed corrupted lock file.",
    };
  }
}

/**
 * Check basic ClickUp API connectivity by making a lightweight request.
 */
async function checkClickUpConnectivity(): Promise<PreflightCheckResult> {
  try {
    const res = await fetch("https://api.clickup.com/api/v2/user", {
      method: "GET",
      headers: {
        Authorization: CLICKUP_API_TOKEN,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        name: "ClickUp connectivity",
        ok: false,
        message: `ClickUp API returned ${res.status}: ${text.slice(0, 200)}`,
        fix: res.status === 401
          ? "Check your CLICKUP_API_TOKEN in .clawdup.env — it may be expired or invalid."
          : "Check your CLICKUP_API_TOKEN and network connection.",
      };
    }

    return { name: "ClickUp connectivity", ok: true, message: "ClickUp API is accessible." };
  } catch (err) {
    return {
      name: "ClickUp connectivity",
      ok: false,
      message: `Cannot reach ClickUp API: ${(err as Error).message}`,
      fix: "Check your network connection and CLICKUP_API_TOKEN in .clawdup.env.",
    };
  }
}

/**
 * Run all preflight checks and return a summary.
 */
export async function runPreflightChecks(): Promise<PreflightResult> {
  log("info", "Running preflight environment checks...");

  const checks: PreflightCheckResult[] = [];

  // Run git checks in parallel (they're independent)
  const [cleanTree, noOps, remote] = await Promise.all([
    checkCleanWorkingTree(),
    checkNoInProgressOps(),
    checkRemoteAndBaseBranch(),
  ]);

  checks.push(cleanTree, noOps, remote);

  // Lock file check is synchronous
  checks.push(checkLockFile());

  // ClickUp connectivity
  checks.push(await checkClickUpConnectivity());

  const passed = checks.every((c) => c.ok);

  return { passed, checks };
}

/**
 * Print preflight results in a human-readable format.
 */
export function printPreflightResults(result: PreflightResult): void {
  console.log("\nPreflight Environment Checks");
  console.log("============================\n");

  for (const check of result.checks) {
    const icon = check.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${check.name}: ${check.message}`);
    if (!check.ok && check.fix) {
      console.log(`         Fix: ${check.fix}`);
    }
  }

  console.log("");
  if (result.passed) {
    console.log("All preflight checks passed. Environment is ready.");
  } else {
    const failCount = result.checks.filter((c) => !c.ok).length;
    console.log(`${failCount} check(s) failed. Please fix the issues above before running.`);
  }
}

/**
 * Run preflight checks and abort if any fail.
 * Used by the runner before starting the main loop.
 * In dry-run mode, failures are logged as warnings but don't abort.
 */
export async function runPreflightOrAbort(): Promise<void> {
  const result = await runPreflightChecks();

  for (const check of result.checks) {
    if (check.ok) {
      log("debug", `Preflight [PASS] ${check.name}: ${check.message}`);
    } else {
      log("warn", `Preflight [FAIL] ${check.name}: ${check.message}`);
      if (check.fix) {
        log("warn", `  Fix: ${check.fix}`);
      }
    }
  }

  if (!result.passed) {
    if (DRY_RUN) {
      log("warn", "Preflight checks failed but continuing in dry-run mode.");
      return;
    }

    log("error", "Preflight checks failed. Aborting run.");
    log("error", "Run 'clawdup --doctor' for details, or fix the issues above.");
    process.exit(1);
  }

  log("info", "Preflight checks passed.");
}
