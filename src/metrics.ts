// Lightweight metrics/telemetry for Clawup runs.
// Persists run records to a JSON file and provides aggregation utilities.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { PROJECT_ROOT } from "./config.js";
import { log } from "./logger.js";
import type { RunOutcome, RunRecord, MetricsSummary } from "./types.js";

const METRICS_FILE_PATH = resolve(PROJECT_ROOT, ".clawdup.metrics.json");
const MAX_RECORDS = 1000;

/**
 * Read all run records from the metrics file.
 */
function readRecords(): RunRecord[] {
  if (!existsSync(METRICS_FILE_PATH)) return [];
  try {
    const raw = readFileSync(METRICS_FILE_PATH, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) return data as RunRecord[];
    return [];
  } catch {
    log("warn", "Could not read metrics file, starting fresh");
    return [];
  }
}

/**
 * Write run records to the metrics file, keeping at most MAX_RECORDS.
 */
function writeRecords(records: RunRecord[]): void {
  const trimmed = records.length > MAX_RECORDS
    ? records.slice(records.length - MAX_RECORDS)
    : records;
  writeFileSync(METRICS_FILE_PATH, JSON.stringify(trimmed, null, 2));
}

/**
 * Categorize an error message into a short category string.
 */
function categorizeError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const lower = error.toLowerCase();
  if (lower.includes("merge conflict")) return "merge_conflict";
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("needs input") || lower.includes("needs more info")) return "needs_input";
  if (lower.includes("no changes") || lower.includes("no file changes")) return "no_changes";
  if (lower.includes("api") || lower.includes("fetch")) return "api_error";
  if (lower.includes("git")) return "git_error";
  if (lower.includes("claude")) return "claude_error";
  return "unknown";
}

/**
 * Record a completed run. Call this after each task processing attempt.
 */
export function recordRun(params: {
  taskId: string;
  taskName: string;
  outcome: RunOutcome;
  durationMs: number;
  error?: string;
}): void {
  try {
    const record: RunRecord = {
      id: randomUUID(),
      taskId: params.taskId,
      taskName: params.taskName,
      timestamp: new Date().toISOString(),
      outcome: params.outcome,
      errorCategory: params.outcome === "failure" || params.outcome === "partial"
        ? categorizeError(params.error)
        : undefined,
      durationMs: params.durationMs,
    };

    const records = readRecords();
    records.push(record);
    writeRecords(records);

    log("debug", `Metrics recorded: ${params.outcome} for task ${params.taskId}`, {
      taskId: params.taskId,
      elapsed: params.durationMs,
    });
  } catch (err) {
    log("warn", `Failed to record metrics: ${(err as Error).message}`);
  }
}

/**
 * Get aggregated metrics summary for a given time window.
 * Defaults to the last 24 hours.
 */
export function getMetricsSummary(hoursBack: number = 24): MetricsSummary {
  const records = readRecords();
  const now = new Date();
  const cutoff = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

  const filtered = records.filter((r) => new Date(r.timestamp) >= cutoff);

  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastErrorCategory: string | null = null;

  let success = 0;
  let partial = 0;
  let failure = 0;
  let needsInput = 0;

  for (const r of filtered) {
    switch (r.outcome) {
      case "success":
        success++;
        if (!lastSuccessAt || r.timestamp > lastSuccessAt) {
          lastSuccessAt = r.timestamp;
        }
        break;
      case "partial":
        partial++;
        if (!lastFailureAt || r.timestamp > lastFailureAt) {
          lastFailureAt = r.timestamp;
          lastErrorCategory = r.errorCategory || null;
        }
        break;
      case "failure":
        failure++;
        if (!lastFailureAt || r.timestamp > lastFailureAt) {
          lastFailureAt = r.timestamp;
          lastErrorCategory = r.errorCategory || null;
        }
        break;
      case "needs_input":
        needsInput++;
        break;
    }
  }

  return {
    totalRuns: filtered.length,
    success,
    partial,
    failure,
    needsInput,
    lastSuccessAt,
    lastFailureAt,
    lastErrorCategory,
    periodStart: cutoff.toISOString(),
    periodEnd: now.toISOString(),
  };
}

/**
 * Get all raw run records, optionally filtered by hours.
 */
export function getRunRecords(hoursBack?: number): RunRecord[] {
  const records = readRecords();
  if (hoursBack === undefined) return records;
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  return records.filter((r) => new Date(r.timestamp) >= cutoff);
}

/**
 * Format a metrics summary as a human-readable string.
 */
export function formatMetricsSummary(summary: MetricsSummary): string {
  const lines: string[] = [];

  lines.push("Clawup Status");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`Period: ${formatTime(summary.periodStart)} - ${formatTime(summary.periodEnd)}`);
  lines.push("");
  lines.push(`Total runs:    ${summary.totalRuns}`);
  lines.push(`  Success:     ${summary.success}`);
  lines.push(`  Partial:     ${summary.partial}`);
  lines.push(`  Failure:     ${summary.failure}`);
  lines.push(`  Needs input: ${summary.needsInput}`);

  if (summary.totalRuns > 0) {
    const successRate = ((summary.success / summary.totalRuns) * 100).toFixed(1);
    lines.push("");
    lines.push(`Success rate:  ${successRate}%`);
  }

  if (summary.lastSuccessAt) {
    lines.push("");
    lines.push(`Last success:  ${formatTime(summary.lastSuccessAt)}`);
  }

  if (summary.lastFailureAt) {
    lines.push(`Last failure:  ${formatTime(summary.lastFailureAt)}`);
    if (summary.lastErrorCategory) {
      lines.push(`Last error:    ${summary.lastErrorCategory}`);
    }
  }

  if (summary.totalRuns === 0) {
    lines.push("");
    lines.push("No runs recorded in this period.");
  }

  return lines.join("\n");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}
