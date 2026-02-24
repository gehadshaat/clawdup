#!/usr/bin/env node

// Wrapper that spawns the CLI as a child process and handles relaunch.
// When the CLI exits with code 75, it means "rebuild succeeded, restart me"
// so the wrapper spawns a fresh process that loads the newly compiled code.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RELAUNCH_EXIT_CODE = 75;
const __dirname = dirname(fileURLToPath(import.meta.url));
const cliScript = resolve(__dirname, "../dist/cli.js");

function launch() {
  const child = spawn(process.execPath, [cliScript, ...process.argv.slice(2)], {
    stdio: "inherit",
  });

  // Let the child handle terminal signals; wrapper just waits
  const noop = () => {};
  process.on("SIGINT", noop);
  process.on("SIGTERM", noop);

  child.on("exit", (code, signal) => {
    process.removeListener("SIGINT", noop);
    process.removeListener("SIGTERM", noop);

    if (code === RELAUNCH_EXIT_CODE) {
      launch();
      return;
    }
    if (signal) {
      // Re-raise so the parent exits with the correct signal status
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

launch();
