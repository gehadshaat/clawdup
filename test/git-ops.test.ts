// Tests for git-ops.ts pure functions, plus fixture-backed tests for the
// branch-recovery helpers (real git repos in a temp dir, with a local bare
// repo standing in for origin — no network).
//
// Note: like the other test files, this imports a module that pulls in
// config.ts, so dummy config env vars are required to run the suite, e.g.
// CLICKUP_API_TOKEN=x CLICKUP_LIST_ID=1 npm test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterCommentsSince,
  rebaseBranchOnto,
  deleteRemoteBranch,
  branchHasBeenPushed,
  pushBranch,
  isAncestor,
} from "../src/git-ops.js";

// ---------------------------------------------------------------------------
// filterCommentsSince
// ---------------------------------------------------------------------------
describe("filterCommentsSince", () => {
  const t = (iso: string) => new Date(iso).getTime();

  it("keeps only comments created strictly after the boundary", () => {
    const comments = [
      { author: "alice", body: "old", createdAt: "2024-01-01T10:00:00Z" },
      { author: "bob", body: "boundary", createdAt: "2024-01-02T10:00:00Z" },
      { author: "carol", body: "new", createdAt: "2024-01-03T10:00:00Z" },
    ];
    const result = filterCommentsSince(comments, t("2024-01-02T10:00:00Z"));
    assert.equal(result.length, 1);
    assert.equal(result[0]!.body, "new");
  });

  it("returns everything for a zero boundary", () => {
    const comments = [
      { body: "a", createdAt: "2024-01-01T10:00:00Z" },
      { body: "b", createdAt: "2024-01-02T10:00:00Z" },
    ];
    assert.equal(filterCommentsSince(comments, 0).length, 2);
  });

  it("returns an empty array when nothing is newer", () => {
    const comments = [
      { body: "a", createdAt: "2024-01-01T10:00:00Z" },
    ];
    assert.equal(filterCommentsSince(comments, t("2024-06-01T00:00:00Z")).length, 0);
  });

  it("returns an empty array for an empty input", () => {
    assert.equal(filterCommentsSince([], 0).length, 0);
  });

  it("drops comments with missing or unparsable createdAt", () => {
    const comments = [
      { body: "no date", createdAt: "" },
      { body: "bad date", createdAt: "not-a-date" },
      { body: "good", createdAt: "2024-01-03T10:00:00Z" },
    ];
    const result = filterCommentsSince(comments, 0);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.body, "good");
  });

  it("preserves extra fields on the filtered comments", () => {
    const comments = [
      {
        author: "alice",
        body: "inline note",
        path: "src/app.ts",
        line: 42,
        createdAt: "2024-01-03T10:00:00Z",
      },
    ];
    const result = filterCommentsSince(comments, 0);
    assert.equal(result[0]!.path, "src/app.ts");
    assert.equal(result[0]!.line, 42);
  });
});

// ---------------------------------------------------------------------------
// Branch-recovery helpers (fixture-backed)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

interface Fixture {
  root: string;
  origin: string;
  clone: string;
}

/**
 * Build a temp fixture: a seeded repo with a `main` branch, cloned bare as
 * `origin.git`, and a working clone of it whose remote is that bare repo.
 */
async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "clawdup-gitops-"));
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");

  await execFileAsync("git", ["init", "-b", "main", seed]);
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await writeFile(join(seed, "base.txt"), "base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-m", "initial");

  await execFileAsync("git", ["clone", "--bare", seed, origin]);
  await execFileAsync("git", ["clone", origin, clone]);
  await git(clone, "config", "user.email", "test@example.com");
  await git(clone, "config", "user.name", "Test");

  return { root, origin, clone };
}

async function commitFile(
  cwd: string,
  name: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(cwd, name), content);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}

describe("rebaseBranchOnto", () => {
  it("replays a branch's own commits onto the target and reports success", async () => {
    const { root, clone } = await makeFixture();
    try {
      await git(clone, "checkout", "-b", "stack-base", "main");
      await commitFile(clone, "stack.txt", "stack\n", "stack work");
      await git(clone, "checkout", "-b", "task", "main");
      await commitFile(clone, "task.txt", "task\n", "task work");

      assert.equal(await isAncestor("stack-base", "task", clone), false);
      assert.equal(await rebaseBranchOnto("task", "stack-base", clone), true);
      assert.equal(await isAncestor("stack-base", "task", clone), true);

      const files = await git(clone, "ls-tree", "--name-only", "task");
      assert.ok(files.includes("task.txt"), "keeps the branch's own work");
      assert.ok(files.includes("stack.txt"), "sits on top of the target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts a conflicting rebase and leaves the branch at its old tip", async () => {
    const { root, clone } = await makeFixture();
    try {
      await git(clone, "checkout", "-b", "stack-base", "main");
      await commitFile(clone, "shared.txt", "stack version\n", "stack edit");
      await git(clone, "checkout", "-b", "task", "main");
      await commitFile(clone, "shared.txt", "task version\n", "task edit");
      const tipBefore = await git(clone, "rev-parse", "task");

      assert.equal(await rebaseBranchOnto("task", "stack-base", clone), false);

      assert.equal(await git(clone, "rev-parse", "task"), tipBefore);
      // No rebase left in progress, no dirty files
      assert.equal(await git(clone, "status", "--porcelain"), "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops commits whose changes the target already contains", async () => {
    // Restacking after the branch's old base was itself rebased: the shared
    // patches must not be replayed twice.
    const { root, clone } = await makeFixture();
    try {
      await git(clone, "checkout", "-b", "task", "main");
      await commitFile(clone, "stack.txt", "stack\n", "stack work (old copy)");
      await commitFile(clone, "task.txt", "task\n", "task work");
      // The same "stack work" patch lands on the new base as a different SHA
      await git(clone, "checkout", "-b", "stack-base", "main");
      await commitFile(clone, "stack.txt", "stack\n", "stack work (restacked)");

      assert.equal(await rebaseBranchOnto("task", "stack-base", clone), true);

      // Only the task's own commit sits on top of the new base
      const own = await git(clone, "rev-list", "stack-base..task", "--oneline");
      assert.equal(own.split("\n").length, 1);
      assert.ok(own.includes("task work"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the target ref via origin/ when it only exists remotely", async () => {
    const { root, clone } = await makeFixture();
    try {
      await git(clone, "checkout", "-b", "stack-base", "main");
      await commitFile(clone, "stack.txt", "stack\n", "stack work");
      await git(clone, "push", "-u", "origin", "stack-base");
      await git(clone, "checkout", "-b", "task", "main");
      await commitFile(clone, "task.txt", "task\n", "task work");
      await git(clone, "branch", "-D", "stack-base");

      assert.equal(await rebaseBranchOnto("task", "stack-base", clone), true);
      assert.equal(await isAncestor("stack-base", "task", clone), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("deleteRemoteBranch", () => {
  it("deletes the branch on origin and reports success", async () => {
    const { root, clone } = await makeFixture();
    try {
      await git(clone, "checkout", "-b", "doomed", "main");
      await commitFile(clone, "d.txt", "d\n", "doomed work");
      await git(clone, "push", "-u", "origin", "doomed");
      assert.equal(await branchHasBeenPushed("doomed", clone), true);

      assert.equal(await deleteRemoteBranch("doomed", clone), true);
      assert.equal(await branchHasBeenPushed("doomed", clone), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns false when the remote branch does not exist", async () => {
    const { root, clone } = await makeFixture();
    try {
      assert.equal(await deleteRemoteBranch("never-pushed", clone), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("pushBranch (force-with-lease)", () => {
  it("force-pushes a rewritten branch", async () => {
    const { root, origin, clone } = await makeFixture();
    try {
      await git(clone, "checkout", "-b", "rewrite", "main");
      await commitFile(clone, "r.txt", "one\n", "original");
      await git(clone, "push", "-u", "origin", "rewrite");
      await git(clone, "commit", "--amend", "-m", "rewritten");

      await pushBranch("rewrite", clone, { forceWithLease: true });

      assert.equal(
        await git(origin, "rev-parse", "refs/heads/rewrite"),
        await git(clone, "rev-parse", "rewrite"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
