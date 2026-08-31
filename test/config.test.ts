// Tests for config.ts pure helpers.
//
// config.ts is a module with load-time side effects (it validates required
// env vars), so like the other test files this relies on the dummy config
// env vars the test run is invoked with (see CLAUDE.md).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CLICKUP_API_BASE_URL,
  resolveApiBaseUrl,
} from "../src/config.js";

describe("resolveApiBaseUrl", () => {
  it("falls back to the public ClickUp API when unset or blank", () => {
    assert.equal(resolveApiBaseUrl(undefined), DEFAULT_CLICKUP_API_BASE_URL);
    assert.equal(resolveApiBaseUrl(""), DEFAULT_CLICKUP_API_BASE_URL);
    assert.equal(resolveApiBaseUrl("   "), DEFAULT_CLICKUP_API_BASE_URL);
  });

  it("returns a custom base URL as-is", () => {
    assert.equal(
      resolveApiBaseUrl("https://clickup-proxy.example.com/api/v2"),
      "https://clickup-proxy.example.com/api/v2",
    );
    assert.equal(
      resolveApiBaseUrl("http://localhost:8080"),
      "http://localhost:8080",
    );
  });

  it("strips trailing slashes so request paths join cleanly", () => {
    assert.equal(
      resolveApiBaseUrl("https://clickup-proxy.example.com/api/v2/"),
      "https://clickup-proxy.example.com/api/v2",
    );
    assert.equal(
      resolveApiBaseUrl("http://localhost:8080//"),
      "http://localhost:8080",
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(
      resolveApiBaseUrl("  https://clickup-proxy.example.com/api/v2 "),
      "https://clickup-proxy.example.com/api/v2",
    );
  });

  it("treats a value of only slashes as unset", () => {
    assert.equal(resolveApiBaseUrl("/"), DEFAULT_CLICKUP_API_BASE_URL);
  });
});
