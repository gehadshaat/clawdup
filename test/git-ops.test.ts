// Tests for git-ops.ts pure functions.
//
// Note: like the other test files, this imports a module that pulls in
// config.ts, so dummy config env vars are required to run the suite, e.g.
// CLICKUP_API_TOKEN=x CLICKUP_LIST_ID=1 npm test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterCommentsSince } from "../src/git-ops.js";

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
