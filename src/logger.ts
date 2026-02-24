// Structured logging module.
// Supports log levels (debug/info/warn/error), structured context fields,
// optional JSON output, and timing utilities.
//
// Log level is configured via:
//   - LOG_LEVEL env var (debug | info | warn | error)
//   - --debug CLI flag (sets level to debug)
//   - DEBUG=1 env var (sets level to debug)
//
// Output format is configured via:
//   - LOG_FORMAT=json env var (switches to JSON-line output)
//   - --json-log CLI flag

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  taskId?: string;
  branch?: string;
  command?: string;
  status?: string;
  prUrl?: string;
  elapsed?: number;
  [key: string]: unknown;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Initialize from environment
const envLevel = (
  process.env.LOG_LEVEL || (process.env.DEBUG === "1" ? "debug" : "info")
).toLowerCase();
let currentLevel: LogLevel =
  envLevel in LEVEL_VALUES ? (envLevel as LogLevel) : "info";
let jsonOutput = process.env.LOG_FORMAT === "json";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setJsonOutput(enabled: boolean): void {
  jsonOutput = enabled;
}

export function isDebug(): boolean {
  return currentLevel === "debug";
}

/**
 * Log a message at the specified level with optional structured context.
 *
 * In human-readable mode (default):
 *   [2024-01-15T12:00:00.000Z] [INFO] Processing task {taskId=abc123, elapsed=3200ms}
 *
 * In JSON mode (LOG_FORMAT=json):
 *   {"timestamp":"...","level":"info","message":"Processing task","taskId":"abc123","elapsed":3200}
 */
export function log(
  level: LogLevel,
  message: string,
  context?: LogContext,
): void {
  if (LEVEL_VALUES[level] < LEVEL_VALUES[currentLevel]) return;

  const timestamp = new Date().toISOString();

  if (jsonOutput) {
    const entry: Record<string, unknown> = { timestamp, level, message };
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined) entry[key] = value;
      }
    }
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    return;
  }

  // Human-readable format
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  let contextStr = "";
  if (context) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined) {
        parts.push(
          key === "elapsed" ? `${key}=${value}ms` : `${key}=${value}`,
        );
      }
    }
    if (parts.length > 0) {
      contextStr = ` {${parts.join(", ")}}`;
    }
  }

  const output = `${prefix} ${message}${contextStr}`;
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

/**
 * Create a timer that returns elapsed milliseconds when called.
 * Useful for measuring step durations.
 *
 * Usage:
 *   const elapsed = startTimer();
 *   // ... do work ...
 *   log("debug", "Step completed", { elapsed: elapsed() });
 */
export function startTimer(): () => number {
  const start = Date.now();
  return () => Date.now() - start;
}
