// Package manager detection utility.
// Detects whether a project uses npm or pnpm based on lock files
// and the packageManager field in package.json.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export type PackageManager = "npm" | "pnpm";

/**
 * Detect the package manager used in the given directory.
 * Checks (in order):
 *   1. pnpm-lock.yaml presence → pnpm
 *   2. packageManager field in package.json → extract PM name
 *   3. Default → npm
 */
export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(resolve(dir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  try {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        packageManager?: string;
      };
      if (pkg.packageManager?.startsWith("pnpm")) {
        return "pnpm";
      }
    }
  } catch {
    // ignore parse errors
  }

  return "npm";
}

/**
 * Return the command to install a package globally.
 *   npm  → "npm install -g <pkg>"
 *   pnpm → "pnpm add -g <pkg>"
 */
export function globalInstallCommand(pm: PackageManager, pkg: string): string {
  if (pm === "pnpm") return `pnpm add -g ${pkg}`;
  return `npm install -g ${pkg}`;
}

/**
 * Return the command to install project dependencies.
 *   npm  → "npm install"
 *   pnpm → "pnpm install"
 */
export function installCommand(pm: PackageManager): string {
  return `${pm} install`;
}

/**
 * Return the command to run a package.json script.
 *   npm  → "npm run <script>"
 *   pnpm → "pnpm run <script>"
 */
export function runScriptCommand(pm: PackageManager, script: string): string {
  return `${pm} run ${script}`;
}

/**
 * Return the command to initialize a new package.json.
 *   npm  → "npm init"
 *   pnpm → "pnpm init"
 */
export function initCommand(pm: PackageManager): string {
  return `${pm} init`;
}
