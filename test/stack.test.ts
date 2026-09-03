// Tests for stack mode's pure helpers: leaf-subtask collection, dependency
// ordering, and the stacked-PR text builders.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareSubtaskOrder,
  getLeafSubtasks,
  getLeafListTasks,
  orderTasksByDependencies,
} from "../src/clickup-api.js";
import {
  generateStackPRNote,
  generateStackPromptContext,
} from "../src/claude-worker.js";
import { describeStackBaseVerdict, evaluateStackBase } from "../src/git-ops.js";
import type { ClickUpDependency, ClickUpTask, StackInfo } from "../src/types.js";

function makeTask(id: string, overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id,
    name: `Task ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    ...overrides,
  };
}

function dep(blockedId: string, blockerId: string): ClickUpDependency {
  return { task_id: blockedId, depends_on: blockerId, type: 1 };
}

// ---------------------------------------------------------------------------
// orderTasksByDependencies
// ---------------------------------------------------------------------------
describe("orderTasksByDependencies", () => {
  it("preserves input order when there are no dependencies", () => {
    const tasks = [makeTask("b"), makeTask("a"), makeTask("c")];
    const ordered = orderTasksByDependencies(tasks);
    assert.deepEqual(ordered.map((t) => t.id), ["b", "a", "c"]);
  });

  it("reorders a chain so blockers come first", () => {
    const tasks = [
      makeTask("b", { dependencies: [dep("b", "a")] }),
      makeTask("a"),
    ];
    const ordered = orderTasksByDependencies(tasks);
    assert.deepEqual(ordered.map((t) => t.id), ["a", "b"]);
  });

  it("breaks ties deterministically by input order (diamond)", () => {
    // b and c both wait on a; d waits on b and c
    const tasks = [
      makeTask("d", { dependencies: [dep("d", "b"), dep("d", "c")] }),
      makeTask("c", { dependencies: [dep("c", "a")] }),
      makeTask("b", { dependencies: [dep("b", "a")] }),
      makeTask("a"),
    ];
    const ordered = orderTasksByDependencies(tasks);
    // After a, both c and b are ready; c comes first in the input order
    assert.deepEqual(ordered.map((t) => t.id), ["a", "c", "b", "d"]);
  });

  it("ignores dependencies on tasks outside the set", () => {
    const tasks = [
      makeTask("b", { dependencies: [dep("b", "external")] }),
      makeTask("a"),
    ];
    const ordered = orderTasksByDependencies(tasks);
    assert.deepEqual(ordered.map((t) => t.id), ["b", "a"]);
  });

  it("ignores rows where the task is on the blocker side", () => {
    // ClickUp includes the same dependency row on both tasks. The row
    // {task_id: b, depends_on: a} must only block b, never a.
    const row = dep("b", "a");
    const tasks = [
      makeTask("b", { dependencies: [row] }),
      makeTask("a", { dependencies: [row] }),
    ];
    const ordered = orderTasksByDependencies(tasks);
    assert.deepEqual(ordered.map((t) => t.id), ["a", "b"]);
  });

  it("ignores self-referencing dependency rows", () => {
    const tasks = [makeTask("a", { dependencies: [dep("a", "a")] })];
    const ordered = orderTasksByDependencies(tasks);
    assert.deepEqual(ordered.map((t) => t.id), ["a"]);
  });

  it("throws on a dependency cycle, naming the tasks involved", () => {
    const tasks = [
      makeTask("a", { dependencies: [dep("a", "b")] }),
      makeTask("b", { dependencies: [dep("b", "a")] }),
    ];
    assert.throws(
      () => orderTasksByDependencies(tasks),
      (err: Error) =>
        /Dependency cycle/.test(err.message) &&
        err.message.includes("a") &&
        err.message.includes("b"),
    );
  });
});

// ---------------------------------------------------------------------------
// compareSubtaskOrder
// ---------------------------------------------------------------------------
describe("compareSubtaskOrder", () => {
  it("compares orderindex numerically, not lexicographically", () => {
    const a = makeTask("a", { orderindex: "10" });
    const b = makeTask("b", { orderindex: "9" });
    assert.ok(compareSubtaskOrder(a, b) > 0);
    assert.ok(compareSubtaskOrder(b, a) < 0);
  });

  it("falls back to date_created when orderindex is missing", () => {
    const a = makeTask("a", { date_created: "200" });
    const b = makeTask("b", { date_created: "100" });
    assert.ok(compareSubtaskOrder(a, b) > 0);
  });

  it("falls back to id comparison when nothing else is available", () => {
    const a = makeTask("a");
    const b = makeTask("b");
    assert.ok(compareSubtaskOrder(a, b) < 0);
  });
});

// ---------------------------------------------------------------------------
// getLeafSubtasks
// ---------------------------------------------------------------------------
describe("getLeafSubtasks", () => {
  function makeFetcher(tree: Record<string, ClickUpTask>) {
    const fetched: string[] = [];
    const fetchTask = async (id: string): Promise<ClickUpTask> => {
      fetched.push(id);
      const task = tree[id];
      if (!task) throw new Error(`fixture missing task ${id}`);
      return task;
    };
    return { fetchTask, fetched };
  }

  it("returns direct subtasks ordered by orderindex", async () => {
    const tree: Record<string, ClickUpTask> = {
      parent: makeTask("parent", {
        subtasks: [
          makeTask("c2", { orderindex: "2" }),
          makeTask("c1", { orderindex: "1" }),
        ],
      }),
      c1: makeTask("c1"),
      c2: makeTask("c2"),
    };
    const { fetchTask, fetched } = makeFetcher(tree);
    const leaves = await getLeafSubtasks("parent", fetchTask);
    assert.deepEqual(leaves.map((t) => t.id), ["c1", "c2"]);
    // Each node fetched exactly once
    assert.deepEqual(fetched, ["parent", "c1", "c2"]);
  });

  it("excludes non-leaf subtasks and recurses into their children", async () => {
    const tree: Record<string, ClickUpTask> = {
      parent: makeTask("parent", {
        subtasks: [
          makeTask("a", { orderindex: "1" }),
          makeTask("b", { orderindex: "2" }),
        ],
      }),
      a: makeTask("a", {
        subtasks: [
          makeTask("a1", { orderindex: "1" }),
          makeTask("a2", { orderindex: "2" }),
        ],
      }),
      a1: makeTask("a1"),
      a2: makeTask("a2"),
      b: makeTask("b"),
    };
    const { fetchTask } = makeFetcher(tree);
    const leaves = await getLeafSubtasks("parent", fetchTask);
    assert.deepEqual(leaves.map((t) => t.id), ["a1", "a2", "b"]);
  });

  it("returns an empty array for a task with no subtasks", async () => {
    const tree: Record<string, ClickUpTask> = { parent: makeTask("parent") };
    const { fetchTask } = makeFetcher(tree);
    const leaves = await getLeafSubtasks("parent", fetchTask);
    assert.deepEqual(leaves, []);
  });

  it("terminates on cyclic subtask links", async () => {
    const tree: Record<string, ClickUpTask> = {
      parent: makeTask("parent", { subtasks: [makeTask("a")] }),
      a: makeTask("a", { subtasks: [makeTask("parent"), makeTask("b")] }),
      b: makeTask("b"),
    };
    const { fetchTask, fetched } = makeFetcher(tree);
    const leaves = await getLeafSubtasks("parent", fetchTask);
    assert.deepEqual(leaves.map((t) => t.id), ["b"]);
    // parent must not be re-fetched via the cycle
    assert.deepEqual(fetched, ["parent", "a", "b"]);
  });

  it("skips subtasks with invalid task IDs without fetching them", async () => {
    const tree: Record<string, ClickUpTask> = {
      parent: makeTask("parent", {
        subtasks: [makeTask("ok1", { orderindex: "1" }), makeTask("bad-id!", { orderindex: "2" })],
      }),
      ok1: makeTask("ok1"),
    };
    const { fetchTask, fetched } = makeFetcher(tree);
    const leaves = await getLeafSubtasks("parent", fetchTask);
    assert.deepEqual(leaves.map((t) => t.id), ["ok1"]);
    assert.ok(!fetched.includes("bad-id!"));
  });
});

// ---------------------------------------------------------------------------
// getLeafListTasks
// ---------------------------------------------------------------------------
describe("getLeafListTasks", () => {
  function makeFetcher(tree: Record<string, ClickUpTask>) {
    const fetched: string[] = [];
    const fetchTask = async (id: string): Promise<ClickUpTask> => {
      fetched.push(id);
      const task = tree[id];
      if (!task) throw new Error(`fixture missing task ${id}`);
      return task;
    };
    return { fetchTask, fetched };
  }

  it("returns childless top-level tasks as leaves, in list order", async () => {
    const tree: Record<string, ClickUpTask> = {
      t1: makeTask("t1"),
      t2: makeTask("t2"),
    };
    const { fetchTask, fetched } = makeFetcher(tree);
    const topLevel = [
      makeTask("t2", { orderindex: "2" }),
      makeTask("t1", { orderindex: "1" }),
    ];
    const leaves = await getLeafListTasks(fetchTask, async () => topLevel);
    assert.deepEqual(leaves.map((t) => t.id), ["t1", "t2"]);
    // Each task fetched exactly once, in walk order
    assert.deepEqual(fetched, ["t1", "t2"]);
  });

  it("recurses into top-level tasks with subtasks, excluding the containers", async () => {
    const tree: Record<string, ClickUpTask> = {
      group: makeTask("group", {
        subtasks: [
          makeTask("g2", { orderindex: "2" }),
          makeTask("g1", { orderindex: "1" }),
        ],
      }),
      g1: makeTask("g1"),
      g2: makeTask("g2"),
      solo: makeTask("solo"),
    };
    const { fetchTask } = makeFetcher(tree);
    const topLevel = [
      makeTask("group", { orderindex: "1" }),
      makeTask("solo", { orderindex: "2" }),
    ];
    const leaves = await getLeafListTasks(fetchTask, async () => topLevel);
    assert.deepEqual(leaves.map((t) => t.id), ["g1", "g2", "solo"]);
  });

  it("returns an empty array for an empty list", async () => {
    const { fetchTask, fetched } = makeFetcher({});
    const leaves = await getLeafListTasks(fetchTask, async () => []);
    assert.deepEqual(leaves, []);
    assert.deepEqual(fetched, []);
  });

  it("skips top-level tasks with invalid IDs and duplicates without fetching them", async () => {
    const tree: Record<string, ClickUpTask> = { ok1: makeTask("ok1") };
    const { fetchTask, fetched } = makeFetcher(tree);
    const topLevel = [
      makeTask("ok1", { orderindex: "1" }),
      makeTask("bad-id!", { orderindex: "2" }),
      makeTask("ok1", { orderindex: "3" }),
    ];
    const leaves = await getLeafListTasks(fetchTask, async () => topLevel);
    assert.deepEqual(leaves.map((t) => t.id), ["ok1"]);
    assert.deepEqual(fetched, ["ok1"]);
  });

  it("does not re-visit a task reachable from two containers", async () => {
    const tree: Record<string, ClickUpTask> = {
      a: makeTask("a", { subtasks: [makeTask("shared")] }),
      b: makeTask("b", { subtasks: [makeTask("shared"), makeTask("b1")] }),
      shared: makeTask("shared"),
      b1: makeTask("b1"),
    };
    const { fetchTask, fetched } = makeFetcher(tree);
    const topLevel = [
      makeTask("a", { orderindex: "1" }),
      makeTask("b", { orderindex: "2" }),
    ];
    const leaves = await getLeafListTasks(fetchTask, async () => topLevel);
    assert.deepEqual(leaves.map((t) => t.id), ["shared", "b1"]);
    assert.deepEqual(fetched, ["a", "shared", "b", "b1"]);
  });
});

// ---------------------------------------------------------------------------
// generateStackPRNote / generateStackPromptContext
// ---------------------------------------------------------------------------
describe("stack text builders", () => {
  const info: StackInfo = {
    sourceKind: "task",
    sourceName: "Big Feature",
    sourceUrl: "https://app.clickup.com/t/parent1",
    position: 2,
    total: 3,
    baseBranch: "clickup/CU-a1-first-task",
    previousPrUrl: "https://github.com/owner/repo/pull/41",
    completedInSeries: [
      {
        name: "First task",
        branchName: "clickup/CU-a1-first-task",
        prUrl: "https://github.com/owner/repo/pull/41",
      },
    ],
  };

  it("generateStackPRNote includes position, base, previous PR, and merge order", () => {
    const note = generateStackPRNote(info);
    assert.ok(note.includes("Stacked PR (2 of 3)"));
    assert.ok(note.includes("clickup/CU-a1-first-task"));
    assert.ok(note.includes("https://github.com/owner/repo/pull/41"));
    assert.ok(note.includes("https://app.clickup.com/t/parent1"));
    assert.ok(note.toLowerCase().includes("bottom-up"));
  });

  it("generateStackPromptContext describes the series and prior work", () => {
    const context = generateStackPromptContext(info);
    assert.ok(context.includes("part 2 of 3"));
    assert.ok(context.includes("Big Feature"));
    assert.ok(context.includes("First task"));
    assert.ok(context.includes("clickup/CU-a1-first-task"));
    assert.ok(context.includes("do NOT re-implement"));
    assert.ok(context.includes("Later tasks"));
  });

  it("generateStackPromptContext omits prior work and later tasks when not applicable", () => {
    const first: StackInfo = {
      ...info,
      position: 3,
      total: 3,
      completedInSeries: [],
    };
    const context = generateStackPromptContext(first);
    assert.ok(!context.includes("already contains"));
    assert.ok(!context.includes("Later tasks"));
  });

  it("handles a list source without a URL in both builders", () => {
    const listInfo: StackInfo = {
      ...info,
      sourceKind: "list",
      sourceName: "Backlog",
      sourceUrl: undefined,
    };

    const note = generateStackPRNote(listInfo);
    assert.ok(note.includes("Stacked PR (2 of 3)"));
    assert.ok(note.includes('ClickUp list: "Backlog"'));
    assert.ok(!note.includes("]("));

    const context = generateStackPromptContext(listInfo);
    assert.ok(context.includes('tasks of the "Backlog" list'));
    assert.ok(!context.includes("subtasks of"));
  });
});

// ---------------------------------------------------------------------------
// evaluateStackBase — can an existing branch be the next stack base?
// ---------------------------------------------------------------------------
describe("evaluateStackBase", () => {
  const usable = { prState: "open", pushed: true, containedInBase: false, onStack: true };

  it("accepts an open, pushed branch that descends from the current base", () => {
    assert.deepEqual(evaluateStackBase(usable), { usable: true });
  });

  it("accepts a pushed branch with no PR yet when it is on the stack", () => {
    assert.deepEqual(evaluateStackBase({ ...usable, prState: null }), { usable: true });
  });

  it("rejects a branch whose PR has already merged, even if it still exists on origin", () => {
    assert.deepEqual(evaluateStackBase({ ...usable, prState: "merged" }), {
      usable: false,
      reason: "merged",
    });
  });

  it("rejects a merged branch before any other reason", () => {
    // The user-reported case: every PR in the stack merged, GitHub deleted the
    // remote branches, and only the stale local branches remain.
    assert.deepEqual(
      evaluateStackBase({ prState: "merged", pushed: false, containedInBase: false, onStack: true }),
      { usable: false, reason: "merged" },
    );
  });

  it("rejects a branch whose commits are already in the current base", () => {
    assert.deepEqual(evaluateStackBase({ ...usable, containedInBase: true }), {
      usable: false,
      reason: "contained",
    });
  });

  it("rejects a local-only branch — GitHub cannot target it", () => {
    assert.deepEqual(evaluateStackBase({ ...usable, pushed: false }), {
      usable: false,
      reason: "unpushed",
    });
  });

  it("rejects a pushed branch that does not contain the current base", () => {
    assert.deepEqual(evaluateStackBase({ ...usable, onStack: false }), {
      usable: false,
      reason: "off-stack",
    });
  });

  it("does not treat a closed (unmerged) PR as merged", () => {
    assert.deepEqual(evaluateStackBase({ ...usable, prState: "closed" }), { usable: true });
  });
});

describe("describeStackBaseVerdict", () => {
  it("names the branch and base in each reason", () => {
    const b = "clickup/CU-1-x";
    assert.match(describeStackBaseVerdict({ usable: false, reason: "merged" }, b, "main"), /already merged/);
    assert.match(describeStackBaseVerdict({ usable: false, reason: "contained" }, b, "main"), /contained in main/);
    assert.match(describeStackBaseVerdict({ usable: false, reason: "unpushed" }, b, "main"), /only locally/);
    assert.match(describeStackBaseVerdict({ usable: false, reason: "off-stack" }, b, "main"), /does not contain main/);
    assert.match(describeStackBaseVerdict({ usable: true }, b, "main"), /can be stacked on/);
  });
});
