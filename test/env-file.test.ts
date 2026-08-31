// Tests for env-file.ts — the append/update-in-place helpers that let
// --setup and --init add clawdup settings to a .env.local that may also
// belong to the project's own tooling, without rewriting it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasClawdupConfig, mergeEnvContent } from "../src/env-file.js";

const HEADER = "# clawdup configuration";

describe("hasClawdupConfig", () => {
  it("detects an uncommented CLICKUP_API_TOKEN line", () => {
    assert.equal(hasClawdupConfig("CLICKUP_API_TOKEN=pk_x\n"), true);
    assert.equal(hasClawdupConfig("FOO=1\n  CLICKUP_API_TOKEN = pk_x\n"), true);
  });

  it("treats commented or absent tokens as not configured", () => {
    assert.equal(hasClawdupConfig(""), false);
    assert.equal(hasClawdupConfig("# CLICKUP_API_TOKEN=pk_x\n"), false);
    assert.equal(hasClawdupConfig("MY_CLICKUP_API_TOKEN=pk_x\n"), false);
  });
});

describe("mergeEnvContent", () => {
  it("appends all pairs under the header when none exist", () => {
    const merged = mergeEnvContent(
      "DATABASE_URL=postgres://x\n",
      [["CLICKUP_API_TOKEN", "pk_x"], ["CLICKUP_LIST_ID", "123"]],
      HEADER,
      false,
    );
    assert.equal(
      merged,
      "DATABASE_URL=postgres://x\n\n" +
        `${HEADER}\nCLICKUP_API_TOKEN=pk_x\nCLICKUP_LIST_ID=123\n`,
    );
  });

  it("adds a blank line before the block when the file lacks a trailing newline", () => {
    const merged = mergeEnvContent("FOO=1", [["BAR", "2"]], HEADER, false);
    assert.equal(merged, `FOO=1\n\n${HEADER}\nBAR=2\n`);
  });

  it("starts with the header when the existing content is empty", () => {
    const merged = mergeEnvContent("", [["FOO", "1"]], HEADER, false);
    assert.equal(merged, `${HEADER}\nFOO=1\n`);
  });

  it("leaves existing keys untouched in append mode and never duplicates them", () => {
    const existing = "LOG_LEVEL=debug\nDATABASE_URL=postgres://x\n";
    const merged = mergeEnvContent(
      existing,
      [["LOG_LEVEL", "info"], ["CLICKUP_API_TOKEN", "pk_x"]],
      HEADER,
      false,
    );
    assert.equal(
      merged,
      "LOG_LEVEL=debug\nDATABASE_URL=postgres://x\n\n" +
        `${HEADER}\nCLICKUP_API_TOKEN=pk_x\n`,
    );
  });

  it("replaces existing keys in place when replaceExisting is true", () => {
    const existing =
      "# app settings\nDATABASE_URL=postgres://x\nCLICKUP_API_TOKEN=pk_old\nLOG_LEVEL=debug\n";
    const merged = mergeEnvContent(
      existing,
      [["CLICKUP_API_TOKEN", "pk_new"], ["CLICKUP_LIST_ID", "123"]],
      HEADER,
      true,
    );
    assert.equal(
      merged,
      "# app settings\nDATABASE_URL=postgres://x\nCLICKUP_API_TOKEN=pk_new\nLOG_LEVEL=debug\n\n" +
        `${HEADER}\nCLICKUP_LIST_ID=123\n`,
    );
  });

  it("appends nothing when every pair already exists in append mode", () => {
    const existing = "CLICKUP_API_TOKEN=pk_old\n";
    const merged = mergeEnvContent(
      existing,
      [["CLICKUP_API_TOKEN", "pk_new"]],
      HEADER,
      false,
    );
    assert.equal(merged, existing);
  });

  it("treats commented-out keys as absent", () => {
    const merged = mergeEnvContent(
      "# CLICKUP_API_TOKEN=pk_old\n",
      [["CLICKUP_API_TOKEN", "pk_new"]],
      HEADER,
      true,
    );
    assert.equal(
      merged,
      `# CLICKUP_API_TOKEN=pk_old\n\n${HEADER}\nCLICKUP_API_TOKEN=pk_new\n`,
    );
  });

  it("only rewrites the first occurrence of a duplicated key", () => {
    // config.ts gives the first occurrence precedence, so that is the one
    // that must carry the new value.
    const merged = mergeEnvContent(
      "FOO=1\nFOO=2\n",
      [["FOO", "9"]],
      HEADER,
      true,
    );
    assert.equal(merged, "FOO=9\nFOO=2\n");
  });
});
