// Helpers for the repo-root .env.local file, shared by `--setup` and
// `--init`. .env.local may also belong to the project's own tooling (e.g. a
// framework), so clawdup never rewrites it wholesale: existing content is
// preserved and clawdup's settings are appended or updated in place.
// No config.ts dependency — both callers run before config exists.

/** True when env-file content already carries clawdup configuration. */
export function hasClawdupConfig(content: string): boolean {
  return /^\s*CLICKUP_API_TOKEN\s*=/m.test(content);
}

/**
 * Merge KEY=VALUE pairs into existing env-file content without touching
 * unrelated lines. Keys missing from the content are appended under `header`;
 * a key already present (uncommented) is replaced in place when
 * `replaceExisting` is true and left untouched otherwise (its pair is
 * dropped, never appended as a duplicate). Commented-out keys count as
 * absent. Only the first occurrence of a duplicated key is considered — the
 * loader in config.ts gives the first occurrence precedence too.
 */
export function mergeEnvContent(
  existing: string,
  pairs: ReadonlyArray<readonly [string, string]>,
  header: string,
  replaceExisting: boolean,
): string {
  const remaining = new Map(pairs);
  const lines = existing.split("\n").map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) return line;
    const key = match[1]!;
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return replaceExisting ? `${key}=${value}` : line;
  });

  let content = lines.join("\n");
  if (remaining.size > 0) {
    const separator =
      content.trim().length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    const block =
      `${header}\n` +
      [...remaining].map(([key, value]) => `${key}=${value}`).join("\n") +
      "\n";
    content = content + separator + block;
  }
  return content;
}
