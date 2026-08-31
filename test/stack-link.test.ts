// Tests for native-stack linking's pure helpers: PR-number parsing,
// linkable-series selection, the create/extend/skip planning logic,
// gh-stack extension detection, and `gh stack link` argument building.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ghStackLinkArgs,
  parseGhStackInstalled,
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

// ---------------------------------------------------------------------------
// parseGhStackInstalled
// ---------------------------------------------------------------------------
describe("parseGhStackInstalled", () => {
  it("detects the official extension in tab-separated gh output", () => {
    assert.equal(parseGhStackInstalled("gh stack\tgithub/gh-stack\tv1.0.0"), true);
  });

  it("detects a fork of the extension (command name comes from the repo basename)", () => {
    assert.equal(parseGhStackInstalled("gh stack\tsomeuser/gh-stack\tv0.9.0"), true);
  });

  it("detects it among other extensions in space-aligned output with a header", () => {
    const out = [
      "NAME       REPO                 VERSION",
      "gh dash    dlvhdr/gh-dash       v4.0.0",
      "gh stack   github/gh-stack      v1.2.3",
    ].join("\n");
    assert.equal(parseGhStackInstalled(out), true);
  });

  it("ignores similarly named extensions", () => {
    const out = [
      "gh stacker\to/gh-stacker\tv1.0.0",
      "gh stack-tools\to/gh-stack-tools\tv1.0.0",
    ].join("\n");
    assert.equal(parseGhStackInstalled(out), false);
  });

  it("returns false when no extensions are listed", () => {
    assert.equal(parseGhStackInstalled(""), false);
    assert.equal(parseGhStackInstalled("no installed extensions found"), false);
  });
});

// ---------------------------------------------------------------------------
// ghStackLinkArgs
// ---------------------------------------------------------------------------
describe("ghStackLinkArgs", () => {
  const urls = [
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/2",
  ];

  it("creates with an explicit base and bottom-up PR URLs", () => {
    assert.deepEqual(ghStackLinkArgs({ action: "create", baseBranch: "main" }, urls), [
      "stack",
      "link",
      "--base",
      "main",
      ...urls,
    ]);
  });

  it("extends by passing the existing stack's number first", () => {
    assert.deepEqual(ghStackLinkArgs({ action: "extend", stackNumber: 42 }, urls), [
      "stack",
      "link",
      "42",
      ...urls,
    ]);
  });
});
