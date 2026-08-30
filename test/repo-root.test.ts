// Tests for repo-root utilities — chiefly the .gitignore guarantee that
// keeps .clawdup.env (secrets) and runtime state files out of version control.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignoreEntries, GITIGNORE_ENTRIES } from "../src/repo-root.js";

function tempRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "clawdup-test-"));
}

describe("ensureGitignoreEntries", () => {
  it("creates .gitignore with all clawdup entries when missing", () => {
    const dir = tempRepoDir();
    const added = ensureGitignoreEntries(dir);

    assert.deepEqual(added, [...GITIGNORE_ENTRIES]);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    for (const entry of GITIGNORE_ENTRIES) {
      assert.ok(content.includes(entry), `missing entry: ${entry}`);
    }
  });

  it("appends only the missing entries to an existing .gitignore", () => {
    const dir = tempRepoDir();
    writeFileSync(
      join(dir, ".gitignore"),
      "node_modules/\n.clawdup.env\n",
    );

    const added = ensureGitignoreEntries(dir);

    assert.ok(!added.includes(".clawdup.env"));
    assert.ok(added.includes(".clawdup-worktrees/"));
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.ok(content.startsWith("node_modules/\n"));
    // .clawdup.env must not be duplicated
    assert.equal(content.split("\n").filter((l) => l.trim() === ".clawdup.env").length, 1);
  });

  it("is idempotent — a second run adds nothing", () => {
    const dir = tempRepoDir();
    ensureGitignoreEntries(dir);
    const before = readFileSync(join(dir, ".gitignore"), "utf-8");

    const added = ensureGitignoreEntries(dir);

    assert.deepEqual(added, []);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), before);
  });

  it("always covers the env file that holds secrets", () => {
    // Guard against the entry list ever losing the one file that must
    // absolutely never be committed.
    assert.ok(GITIGNORE_ENTRIES.includes(".clawdup.env"));
    const dir = tempRepoDir();
    ensureGitignoreEntries(dir);
    assert.ok(existsSync(join(dir, ".gitignore")));
  });
});
