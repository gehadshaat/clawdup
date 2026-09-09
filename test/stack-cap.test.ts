// Tests for the stack cap (MAX_STACKED_PRS): the pure cap decision and the
// run-summary comment's deferred-task reporting.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStackSummaryComment,
  isStackCapReached,
  type StackLeafRecord,
} from "../src/runner.js";
import type { ClickUpTask } from "../src/types.js";

function makeTask(id: string, name = `Task ${id}`): ClickUpTask {
  return { id, name, url: `https://app.clickup.com/t/${id}` };
}

function record(
  id: string,
  disposition: StackLeafRecord["disposition"],
  extra: Partial<StackLeafRecord> = {},
): StackLeafRecord {
  return { leaf: makeTask(id), disposition, ...extra };
}

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;

// ---------------------------------------------------------------------------
// isStackCapReached
// ---------------------------------------------------------------------------
describe("isStackCapReached", () => {
  it("is not reached while fewer PRs are stacked than the cap allows", () => {
    assert.equal(isStackCapReached(0, 5), false);
    assert.equal(isStackCapReached(4, 5), false);
  });

  it("is reached once the stack holds the capped number of PRs", () => {
    assert.equal(isStackCapReached(5, 5), true);
  });

  it("stays reached when a resumed run adopted more PRs than a lowered cap", () => {
    assert.equal(isStackCapReached(7, 5), true);
  });

  it("treats a cap of 0 as unlimited", () => {
    assert.equal(isStackCapReached(0, 0), false);
    assert.equal(isStackCapReached(5, 0), false);
    assert.equal(isStackCapReached(1000, 0), false);
  });

  it("caps at a single PR when the cap is 1", () => {
    assert.equal(isStackCapReached(0, 1), false);
    assert.equal(isStackCapReached(1, 1), true);
  });
});

// ---------------------------------------------------------------------------
// buildStackSummaryComment — deferred tasks
// ---------------------------------------------------------------------------
describe("buildStackSummaryComment with deferred tasks", () => {
  const records: StackLeafRecord[] = [
    record("a1", "adopted", { branchName: "clickup/CU-a1-x", prUrl: pr(1) }),
    record("b2", "completed", { branchName: "clickup/CU-b2-y", prUrl: pr(2) }),
    record("c3", "deferred"),
    record("d4", "deferred"),
  ];

  it("reports the deferred count in the headline", () => {
    const comment = buildStackSummaryComment(records, null, null, 2);
    const headline = comment.split("\n")[0]!;
    assert.ok(headline.startsWith("✅"), headline);
    assert.ok(headline.includes("1 new PR(s) created"), headline);
    assert.ok(headline.includes("2 task(s) deferred"), headline);
    assert.ok(headline.includes("stack cap reached"), headline);
  });

  it("lists each deferred task with the cap that stopped it", () => {
    const comment = buildStackSummaryComment(records, null, null, 2);
    assert.ok(comment.includes("3. Task c3 (CU-c3) — ⏸️ deferred (stack cap of 2 open PR(s) reached)"), comment);
    assert.ok(comment.includes("4. Task d4 (CU-d4) — ⏸️ deferred (stack cap of 2 open PR(s) reached)"), comment);
    // Earlier dispositions are untouched
    assert.ok(comment.includes(`1. Task a1 (CU-a1) — 🔁 already in review: ${pr(1)}`), comment);
    assert.ok(comment.includes(`2. Task b2 (CU-b2) — ✅ PR: ${pr(2)}`), comment);
  });

  it("explains the cap and how to continue", () => {
    const comment = buildStackSummaryComment(records, null, null, 2);
    assert.ok(comment.includes("MAX_STACKED_PRS"), comment);
    assert.ok(comment.includes("at most 2 open PR(s)"), comment);
    assert.ok(comment.includes("still-open PRs from earlier runs count"), comment);
    assert.ok(comment.includes("re-run `--stack` to continue with the 2 deferred task(s)"), comment);
    // A cap pause is not a failure — no abort guidance
    assert.ok(!comment.includes("Resolve the failure"), comment);
  });

  it("keeps the native-stack note when the open PRs were linked", () => {
    const comment = buildStackSummaryComment(
      records,
      null,
      { outcome: "extended", stackNumber: 42, prNumbers: [2] },
      2,
    );
    assert.ok(comment.includes("linked as a native GitHub stack #42"), comment);
    assert.ok(comment.includes("2 task(s) deferred"), comment);
  });
});

describe("buildStackSummaryComment without deferred tasks", () => {
  it("reports a plain finished run exactly as before", () => {
    const records = [
      record("a1", "completed", { prUrl: pr(1) }),
      record("b2", "completed", { prUrl: pr(2) }),
    ];
    const comment = buildStackSummaryComment(records, null, null, 5);
    assert.equal(comment.split("\n")[0], "✅ Automation stack run finished: 2 new PR(s) created.");
    assert.ok(!comment.includes("deferred"), comment);
    assert.ok(!comment.includes("MAX_STACKED_PRS"), comment);
  });

  it("does not mention the cap for an aborted run", () => {
    const records = [
      record("a1", "completed", { prUrl: pr(1) }),
      record("b2", "failed", { detail: "ended with error" }),
      record("c3", "not_attempted"),
    ];
    const comment = buildStackSummaryComment(records, "ended with error", null, 5);
    assert.equal(comment.split("\n")[0], "⚠️ Automation stack run aborted after 1 new PR(s).");
    assert.ok(comment.includes("3. Task c3 (CU-c3) — ⏸️ not attempted (stack aborted earlier)"), comment);
    assert.ok(comment.includes("Resolve the failure and re-run `--stack` to resume"), comment);
    assert.ok(!comment.includes("MAX_STACKED_PRS"), comment);
  });

  it("does not mention the cap when it is disabled", () => {
    const records = [record("a1", "completed", { prUrl: pr(1) })];
    const comment = buildStackSummaryComment(records, null, null, 0);
    assert.ok(!comment.includes("cap"), comment);
  });
});
