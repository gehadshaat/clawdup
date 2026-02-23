// Tests for claude-worker.ts pure functions.
//
// Motivating tasks:
//   - CU-86afmfwce: Add automated tests for critical edge cases
//   - CU-86afmf42h: Handle returning tasks (needs input detection)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractNeedsInputReason, generateCommitMessage, generateWorkSummary, generatePRBody, } from "../src/claude-worker.js";
// ---------------------------------------------------------------------------
// extractNeedsInputReason
// ---------------------------------------------------------------------------
describe("extractNeedsInputReason", () => {
    it("extracts reason after NEEDS_MORE_INFO marker", () => {
        const output = "I analyzed the code.\nNEEDS_MORE_INFO: The task doesn't specify which database to use.\nPlease clarify.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("NEEDS_MORE_INFO"));
        assert.ok(reason.includes("database"));
    });
    it("extracts reason after REQUIRE_INPUT marker", () => {
        const output = "Looking at the codebase...\nREQUIRE_INPUT: I need the API endpoint URL.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("REQUIRE_INPUT"));
    });
    it("extracts reason after 'I need more information' marker", () => {
        const output = "I've reviewed the task. I need more information about the expected output format.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("need more information"));
    });
    it("extracts reason after 'could you clarify' marker", () => {
        const output = "The description is ambiguous. Could you clarify which component should be modified?";
        const reason = extractNeedsInputReason(output);
        // extractNeedsInputReason preserves original case from the output
        assert.ok(reason.toLowerCase().includes("could you clarify"));
    });
    it("extracts reason after 'I cannot proceed without' marker", () => {
        const output = "I cannot proceed without knowing the authentication method to use.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("cannot proceed without"));
    });
    it("extracts reason after BLOCKED marker", () => {
        const output = "BLOCKED: The required dependency is not installed.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("BLOCKED"));
    });
    it("returns default message when no marker found", () => {
        const output = "I completed the task successfully. All changes committed.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("needs more information"));
    });
    it("limits extracted reason to 5 lines", () => {
        const output = "NEEDS_MORE_INFO: line1\nline2\nline3\nline4\nline5\nline6\nline7";
        const reason = extractNeedsInputReason(output);
        const lines = reason.split("\n").filter((l) => l.trim());
        assert.ok(lines.length <= 5, `Expected <= 5 lines, got ${lines.length}`);
    });
    it("is case-insensitive when matching markers", () => {
        const output = "needs_more_info: Please provide the config file format.";
        const reason = extractNeedsInputReason(output);
        assert.ok(reason.includes("needs_more_info"));
    });
});
// ---------------------------------------------------------------------------
// generateCommitMessage
// ---------------------------------------------------------------------------
describe("generateCommitMessage", () => {
    const baseTask = {
        id: "abc123",
        name: "Add login feature",
        url: "https://app.clickup.com/t/abc123",
    };
    it("includes task reference and name", () => {
        const msg = generateCommitMessage(baseTask, "I added the login page.");
        assert.ok(msg.startsWith("[CU-abc123] Add login feature"));
    });
    it("includes summary from Claude output when available", () => {
        const output = "Short line\nAnother short\nI implemented the login form with email and password validation.";
        const msg = generateCommitMessage(baseTask, output);
        assert.ok(msg.includes("[CU-abc123]"));
        assert.ok(msg.includes("login form with email and password validation"));
    });
    it("skips summary lines starting with # or ``` or -", () => {
        const output = "# Header line that is longer than twenty chars\n```code block line that is longer than twenty chars```\n- List item that is longer than twenty chars";
        const msg = generateCommitMessage(baseTask, output);
        // Should not include any of these as summary
        assert.ok(!msg.includes("Header line"));
        assert.ok(!msg.includes("code block"));
        assert.ok(!msg.includes("List item"));
    });
    it("handles empty output", () => {
        const msg = generateCommitMessage(baseTask, "");
        assert.equal(msg, "[CU-abc123] Add login feature");
    });
    it("handles output with only short lines", () => {
        const msg = generateCommitMessage(baseTask, "OK\nDone\nDone!");
        // Short lines (< 20 chars) are skipped as summaries
        assert.equal(msg, "[CU-abc123] Add login feature");
    });
    it("skips summary lines longer than 200 chars", () => {
        const longLine = "x".repeat(250);
        const msg = generateCommitMessage(baseTask, longLine);
        // The long summary line should be excluded because summary > 200 chars
        assert.equal(msg, "[CU-abc123] Add login feature");
    });
});
// ---------------------------------------------------------------------------
// generateWorkSummary
// ---------------------------------------------------------------------------
describe("generateWorkSummary", () => {
    it("includes what was done section", () => {
        const output = "I implemented the login feature with email validation and password strength checking.";
        const summary = generateWorkSummary(output, "2 files changed", ["src/login.ts", "src/auth.ts"]);
        assert.ok(summary.includes("**What was done:**"));
        assert.ok(summary.includes("login feature"));
    });
    it("includes files changed section", () => {
        const summary = generateWorkSummary("Did some work", "2 files changed", ["src/a.ts", "src/b.ts"]);
        assert.ok(summary.includes("**Files changed:**"));
        assert.ok(summary.includes("`src/a.ts`"));
        assert.ok(summary.includes("`src/b.ts`"));
    });
    it("includes diff stats", () => {
        const stat = " 2 files changed, 15 insertions(+), 3 deletions(-)";
        const summary = generateWorkSummary("Work done", stat, ["src/a.ts"]);
        assert.ok(summary.includes("**Diff stats:**"));
        assert.ok(summary.includes("15 insertions"));
    });
    it("filters out code blocks from summary", () => {
        const output = "Here's what I did:\n```typescript\nconst x = 1;\n```\nI added a constant for configuration.";
        const summary = generateWorkSummary(output, "", []);
        // Should not include the code block content
        assert.ok(!summary.includes("const x = 1"));
    });
    it("filters out tool markers", () => {
        const output = "[Edit]\n[Read]\nI updated the configuration file with the new setting.";
        const summary = generateWorkSummary(output, "", []);
        assert.ok(!summary.includes("[Edit]"));
        assert.ok(!summary.includes("[Read]"));
    });
    it("handles empty output", () => {
        const summary = generateWorkSummary("", "", []);
        // Should not crash, may be empty
        assert.ok(typeof summary === "string");
    });
    it("handles empty changed files", () => {
        const summary = generateWorkSummary("Work done", "0 files changed", []);
        assert.ok(!summary.includes("**Files changed:**"));
    });
});
// ---------------------------------------------------------------------------
// generatePRBody
// ---------------------------------------------------------------------------
describe("generatePRBody", () => {
    const baseTask = {
        id: "abc123",
        name: "Add login feature",
        url: "https://app.clickup.com/t/abc123",
    };
    it("includes summary with task link", () => {
        const body = generatePRBody(baseTask, "output", ["src/a.ts"]);
        assert.ok(body.includes("## Summary"));
        assert.ok(body.includes("[Add login feature](https://app.clickup.com/t/abc123)"));
    });
    it("includes task description when present", () => {
        const task = {
            ...baseTask,
            text_content: "Implement a login form with validation.",
        };
        const body = generatePRBody(task, "output", []);
        assert.ok(body.includes("## Task Description"));
        assert.ok(body.includes("Implement a login form"));
    });
    it("truncates long descriptions to 500 chars", () => {
        const task = {
            ...baseTask,
            text_content: "x".repeat(600),
        };
        const body = generatePRBody(task, "output", []);
        assert.ok(body.includes("..."));
    });
    it("includes files changed section", () => {
        const body = generatePRBody(baseTask, "output", ["src/login.ts", "src/auth.ts"]);
        assert.ok(body.includes("## Files Changed"));
        assert.ok(body.includes("`src/login.ts`"));
        assert.ok(body.includes("`src/auth.ts`"));
    });
    it("includes test plan checklist", () => {
        const body = generatePRBody(baseTask, "output", []);
        assert.ok(body.includes("## Test Plan"));
        assert.ok(body.includes("Review the changes manually"));
        assert.ok(body.includes("Verify build succeeds"));
    });
    it("includes clickup task url at the bottom", () => {
        const body = generatePRBody(baseTask, "output", []);
        assert.ok(body.includes("ClickUp Task: https://app.clickup.com/t/abc123"));
    });
    it("includes automation attribution", () => {
        const body = generatePRBody(baseTask, "output", []);
        assert.ok(body.includes("clawup"));
    });
});
// ---------------------------------------------------------------------------
// NEEDS_INPUT_MARKERS detection
// (Tests the same markers used in runClaudeOnTask to detect needsInput)
// ---------------------------------------------------------------------------
describe("needs input marker detection", () => {
    const NEEDS_INPUT_MARKERS = [
        "NEEDS_MORE_INFO",
        "REQUIRE_INPUT",
        "NEED_CLARIFICATION",
        "BLOCKED:",
        "I need more information",
        "I need clarification",
        "could you clarify",
        "could you provide",
        "I cannot proceed without",
        "insufficient information",
        "the task description is unclear",
    ];
    function detectNeedsInput(output) {
        return NEEDS_INPUT_MARKERS.some((marker) => output.toLowerCase().includes(marker.toLowerCase()));
    }
    it("detects NEEDS_MORE_INFO in output", () => {
        assert.ok(detectNeedsInput("NEEDS_MORE_INFO: Please specify the database."));
    });
    it("detects needs input markers case-insensitively", () => {
        assert.ok(detectNeedsInput("needs_more_info: something"));
        assert.ok(detectNeedsInput("I Need More Information about this."));
    });
    it("detects BLOCKED marker", () => {
        assert.ok(detectNeedsInput("BLOCKED: Missing dependency."));
    });
    it("does NOT flag normal completion output", () => {
        assert.ok(!detectNeedsInput("Task completed. All changes committed."));
        assert.ok(!detectNeedsInput("I implemented the feature successfully."));
    });
    it("detects 'insufficient information'", () => {
        assert.ok(detectNeedsInput("There is insufficient information to proceed."));
    });
    it("detects 'could you provide'", () => {
        assert.ok(detectNeedsInput("Could you provide the expected output format?"));
    });
    it("detects 'the task description is unclear'", () => {
        assert.ok(detectNeedsInput("The task description is unclear about which API to use."));
    });
    it("detects marker embedded in longer text", () => {
        const output = "I've read through the code and analyzed the requirements. " +
            "However, I need clarification on which authentication method to use. " +
            "The task mentions OAuth but doesn't specify the provider.";
        assert.ok(detectNeedsInput(output));
    });
});
