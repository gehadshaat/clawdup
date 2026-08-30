// Tests for native-stack linking's pure helpers: PR-number parsing,
// linkable-series selection, and the create/extend/skip planning logic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePRNumber,
  planStackLink,
  selectLinkablePrUrls,
} from "../src/git-ops.js";

// ---------------------------------------------------------------------------
// parsePRNumber
// ---------------------------------------------------------------------------
describe("parsePRNumber", () => {
  it("parses a standard PR URL", () => {
    assert.equal(parsePRNumber("https://github.com/owner/repo/pull/123"), 123);
  });

  it("parses URLs with trailing paths, queries, and fragments", () => {
    assert.equal(parsePRNumber("https://github.com/o/r/pull/7/files"), 7);
    assert.equal(parsePRNumber("https://github.com/o/r/pull/7?w=1"), 7);
    assert.equal(parsePRNumber("https://github.com/o/r/pull/7#discussion"), 7);
  });

  it("returns null for non-PR URLs", () => {
    assert.equal(parsePRNumber("https://github.com/o/r/issues/7"), null);
    assert.equal(parsePRNumber("https://github.com/o/r"), null);
    assert.equal(parsePRNumber("not a url"), null);
    assert.equal(parsePRNumber("https://github.com/o/r/pull/abc"), null);
  });
});

// ---------------------------------------------------------------------------
// selectLinkablePrUrls
// ---------------------------------------------------------------------------
describe("selectLinkablePrUrls", () => {
  const pr = (n: number) => `https://github.com/o/r/pull/${n}`;

  it("returns all URLs when every entry has a PR", () => {
    const entries = [{ prUrl: pr(1) }, { prUrl: pr(2) }, { prUrl: pr(3) }];
    assert.deepEqual(selectLinkablePrUrls(entries), [pr(1), pr(2), pr(3)]);
  });

  it("returns only the trailing run after a gap", () => {
    const entries = [{ prUrl: pr(1) }, {}, { prUrl: pr(3) }, { prUrl: pr(4) }];
    assert.deepEqual(selectLinkablePrUrls(entries), [pr(3), pr(4)]);
  });

  it("returns an empty list when the last entry has no PR", () => {
    const entries = [{ prUrl: pr(1) }, { prUrl: pr(2) }, {}];
    assert.deepEqual(selectLinkablePrUrls(entries), []);
  });

  it("returns an empty list for an empty series", () => {
    assert.deepEqual(selectLinkablePrUrls([]), []);
  });
});

// ---------------------------------------------------------------------------
// planStackLink
// ---------------------------------------------------------------------------
describe("planStackLink", () => {
  const unstacked = (prNumber: number) => ({ prNumber, stackNumber: null });
  const inStack = (prNumber: number, stackNumber: number) => ({ prNumber, stackNumber });

  it("skips an empty series", () => {
    const plan = planStackLink([]);
    assert.equal(plan.action, "skip");
  });

  it("skips a single unstacked PR (a stack needs two layers)", () => {
    const plan = planStackLink([unstacked(1)]);
    assert.equal(plan.action, "skip");
  });

  it("creates a stack from two or more unstacked PRs", () => {
    const plan = planStackLink([unstacked(1), unstacked(2), unstacked(3)]);
    assert.deepEqual(plan, { action: "create", prNumbers: [1, 2, 3] });
  });

  it("extends an existing stack with the new suffix (resumed run)", () => {
    const plan = planStackLink([inStack(1, 42), inStack(2, 42), unstacked(3)]);
    assert.deepEqual(plan, { action: "extend", stackNumber: 42, prNumbers: [3] });
  });

  it("extends even when only one new PR sits on a one-PR stack", () => {
    const plan = planStackLink([inStack(1, 42), unstacked(2)]);
    assert.deepEqual(plan, { action: "extend", stackNumber: 42, prNumbers: [2] });
  });

  it("reports an already fully linked series", () => {
    const plan = planStackLink([inStack(1, 42), inStack(2, 42)]);
    assert.deepEqual(plan, {
      action: "already-linked",
      stackNumber: 42,
      prNumbers: [1, 2],
    });
  });

  it("skips when the series spans multiple stacks", () => {
    const plan = planStackLink([inStack(1, 42), inStack(2, 43)]);
    assert.equal(plan.action, "skip");
  });

  it("skips when a stacked PR sits above an unstacked one", () => {
    const plan = planStackLink([unstacked(1), inStack(2, 42)]);
    assert.equal(plan.action, "skip");
  });
});
