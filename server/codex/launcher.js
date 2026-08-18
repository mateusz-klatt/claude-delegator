#!/usr/bin/env node

/**
 * Transparent Codex MCP launcher.
 *
 * Keeps Codex's native `codex` / `codex-reply` protocol unchanged while
 * removing the caller's Agent Mail identity and credentials at the process
 * boundary. It does not select or restrict models. Works with native
 * executables and npm-style shims on Windows.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { killProcessTree, resolveCli, resolveWindowsShim } = require("../shared/bridge.js");
const { buildCalleeEnv } = require("../shared/environment.js");

const IS_WINDOWS = process.platform === "win32";
const OVERRIDE_ENV = "CODEX_DELEGATOR_CODEX_BIN";

function commandForBinary(binary, args) {
  if (/\.(?:c?m?js)$/i.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
}

function resolveCodexBinary() {
  const explicit = process.env[OVERRIDE_ENV];
  if (typeof explicit === "string" && explicit.trim()) {
    let candidate = path.resolve(explicit.trim());
    if (!fs.statSync(candidate).isFile()) throw new Error("explicit Codex path is not a file");
    if (!IS_WINDOWS) fs.accessSync(candidate, fs.constants.X_OK);
    if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(candidate)) {
      candidate = resolveWindowsShim(candidate, "codex");
    }
    return candidate;
  }

  // The shared resolver scans PATH as data, validates POSIX X_OK, follows
  // Windows npm shims without a shell, and never executes `which`/`where`.
  return resolveCli("codex");
}

let binary;
try {
  binary = resolveCodexBinary();
} catch (error) {
  process.stderr.write(`Codex CLI not found: ${error.message}\n`);
  process.exit(1);
}

const childEnv = buildCalleeEnv(process.env);
for (const key of Object.keys(childEnv)) {
  if (key.toLowerCase() === OVERRIDE_ENV.toLowerCase()) delete childEnv[key];
}

const invocation = commandForBinary(binary, process.argv.slice(2));
const child = spawn(invocation.command, invocation.args, {
  detached: !IS_WINDOWS,
  env: childEnv,
  shell: false,
  stdio: "inherit",
  windowsHide: true
});

let shuttingDown = false;
function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  killProcessTree(child, signal);
  const forceTimer = setTimeout(() => {
    killProcessTree(child, "SIGKILL");
    process.exit(exitCode);
  }, 3_000);
  forceTimer.unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM", 0));
process.once("SIGINT", () => shutdown("SIGINT", 130));

child.once("error", (error) => {
  process.stderr.write(`Failed to start Codex CLI: ${error.message}\n`);
  process.exit(1);
});

child.once("close", (code, signal) => {
  if (shuttingDown) {
    process.exit(signal === "SIGINT" ? 130 : 0);
    return;
  }
  if (typeof code === "number") {
    process.exit(code);
    return;
  }
  process.stderr.write(`Codex CLI terminated by ${signal || "an unknown signal"}\n`);
  process.exit(1);
});
