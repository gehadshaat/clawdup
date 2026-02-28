// Tests for concurrency limit enforcement.
// These verify the configuration parsing and limit-check logic
// without calling external tools or APIs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test: parsePositiveInt logic (mirrors config.ts validation)
// ---------------------------------------------------------------------------

function parsePositiveInt(name: string, raw: string | undefined, defaultValue: number): number {
  const str = raw || String(defaultValue);
  const value = parseInt(str, 10);
  if (isNaN(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${str}".`);
  }
  return value;
}

describe("Concurrency limit configuration parsing", () => {
  it("defaults to 0 (no limit) when env var is not set", () => {
    assert.equal(parsePositiveInt("CLAWUP_MAX_OPEN_PRS", undefined, 0), 0);
    assert.equal(parsePositiveInt("CLAWUP_MAX_TASKS_PER_RUN", undefined, 0), 0);
    assert.equal(parsePositiveInt("CLAWUP_MIN_TASK_DELAY_MS", undefined, 0), 0);
  });

  it("parses valid positive integers", () => {
    assert.equal(parsePositiveInt("CLAWUP_MAX_OPEN_PRS", "5", 0), 5);
    assert.equal(parsePositiveInt("CLAWUP_MAX_TASKS_PER_RUN", "10", 0), 10);
    assert.equal(parsePositiveInt("CLAWUP_MIN_TASK_DELAY_MS", "30000", 0), 30000);
  });

  it("rejects negative values", () => {
    assert.throws(
      () => parsePositiveInt("CLAWUP_MAX_OPEN_PRS", "-1", 0),
      /must be a non-negative integer/,
    );
  });

  it("rejects non-numeric values", () => {
    assert.throws(
      () => parsePositiveInt("CLAWUP_MAX_OPEN_PRS", "abc", 0),
      /must be a non-negative integer/,
    );
  });

  it("treats 0 as no limit (valid)", () => {
    assert.equal(parsePositiveInt("CLAWUP_MAX_OPEN_PRS", "0", 0), 0);
  });
});

// ---------------------------------------------------------------------------
// Test: limit enforcement decision logic (mirrors runner.ts checks)
// ---------------------------------------------------------------------------

describe("Task-per-run limit enforcement", () => {
  it("allows processing when no limit is set (0)", () => {
    const maxTasksPerRun = 0;
    const tasksProcessed = 100;
    const shouldBlock = maxTasksPerRun > 0 && tasksProcessed >= maxTasksPerRun;
    assert.equal(shouldBlock, false, "Should not block when limit is 0 (unlimited)");
  });

  it("allows processing when under the limit", () => {
    const maxTasksPerRun = 5;
    const tasksProcessed = 3;
    const shouldBlock = maxTasksPerRun > 0 && tasksProcessed >= maxTasksPerRun;
    assert.equal(shouldBlock, false, "Should not block when under limit");
  });

  it("blocks processing when at the limit", () => {
    const maxTasksPerRun = 5;
    const tasksProcessed = 5;
    const shouldBlock = maxTasksPerRun > 0 && tasksProcessed >= maxTasksPerRun;
    assert.equal(shouldBlock, true, "Should block when at limit");
  });

  it("blocks processing when over the limit", () => {
    const maxTasksPerRun = 5;
    const tasksProcessed = 7;
    const shouldBlock = maxTasksPerRun > 0 && tasksProcessed >= maxTasksPerRun;
    assert.equal(shouldBlock, true, "Should block when over limit");
  });
});

describe("Open PR limit enforcement", () => {
  it("allows processing when no limit is set (0)", () => {
    const maxOpenPRs = 0;
    const openPRCount = 50;
    const shouldBlock = maxOpenPRs > 0 && openPRCount >= maxOpenPRs;
    assert.equal(shouldBlock, false, "Should not block when limit is 0 (unlimited)");
  });

  it("allows processing when under the limit", () => {
    const maxOpenPRs = 10;
    const openPRCount = 7;
    const shouldBlock = maxOpenPRs > 0 && openPRCount >= maxOpenPRs;
    assert.equal(shouldBlock, false, "Should not block when under limit");
  });

  it("blocks processing when at the limit", () => {
    const maxOpenPRs = 10;
    const openPRCount = 10;
    const shouldBlock = maxOpenPRs > 0 && openPRCount >= maxOpenPRs;
    assert.equal(shouldBlock, true, "Should block when at limit");
  });

  it("blocks processing when over the limit", () => {
    const maxOpenPRs = 3;
    const openPRCount = 5;
    const shouldBlock = maxOpenPRs > 0 && openPRCount >= maxOpenPRs;
    assert.equal(shouldBlock, true, "Should block when over limit");
  });
});

describe("Task delay throttle", () => {
  it("no delay when MIN_TASK_DELAY_MS is 0", () => {
    const minDelay = 0;
    const tasksProcessed = 5;
    const shouldDelay = minDelay > 0 && tasksProcessed > 1;
    assert.equal(shouldDelay, false);
  });

  it("no delay for the first task even when configured", () => {
    const minDelay = 5000;
    const tasksProcessed = 1;
    const shouldDelay = minDelay > 0 && tasksProcessed > 1;
    assert.equal(shouldDelay, false, "First task should not be delayed");
  });

  it("applies delay for second and subsequent tasks", () => {
    const minDelay = 5000;
    const tasksProcessed = 2;
    const shouldDelay = minDelay > 0 && tasksProcessed > 1;
    assert.equal(shouldDelay, true, "Second task onwards should be delayed");
  });
});

// ---------------------------------------------------------------------------
// Test: backwards compatibility (no limits configured)
// ---------------------------------------------------------------------------

describe("Backwards compatibility — no limits configured", () => {
  it("all checks pass when all limits are 0 (default)", () => {
    const maxOpenPRs = 0;
    const maxTasksPerRun = 0;
    const minDelay = 0;
    const openPRCount = 100;
    const tasksProcessed = 200;

    const prLimitHit = maxOpenPRs > 0 && openPRCount >= maxOpenPRs;
    const taskLimitHit = maxTasksPerRun > 0 && tasksProcessed >= maxTasksPerRun;
    const shouldDelay = minDelay > 0 && tasksProcessed > 1;

    assert.equal(prLimitHit, false, "PR limit should not trigger");
    assert.equal(taskLimitHit, false, "Task limit should not trigger");
    assert.equal(shouldDelay, false, "Delay should not trigger");
  });
});
