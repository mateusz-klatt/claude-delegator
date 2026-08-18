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
const {
  killProcessTree,
  resolveCli,
  resolveWindowsShim,
  spawnTarget
} = require("../shared/bridge.js");
const { buildCalleeEnv } = require("../shared/environment.js");

const IS_WINDOWS = process.platform === "win32";
const OVERRIDE_ENV = "CODEX_DELEGATOR_CODEX_BIN";

function cliFallbacks({ environment = process.env, isWindows = IS_WINDOWS } = {}) {
  if (!isWindows) return [];

  const fallbacks = [];
  const localAppData = environment.LOCALAPPDATA;
  const localRoot = typeof localAppData === "string" ? localAppData.trim() : "";
  if (localRoot && path.win32.isAbsolute(localRoot)) {
    // Measured native installer location. Keep the stable product path, never a
    // version-stamped package directory.
    fallbacks.push(path.win32.join(
      localRoot, "Programs", "OpenAI", "Codex", "bin", "codex.exe"
    ));
  }

  const appData = environment.APPDATA;
  const roamingRoot = typeof appData === "string" ? appData.trim() : "";
  if (roamingRoot && path.win32.isAbsolute(roamingRoot)) {
    // npm's stable global shim. resolveCli expands it to its JS loader before
    // spawn, with shell:false.
    fallbacks.push(path.win32.join(roamingRoot, "npm", "codex.cmd"));
  }
  return fallbacks;
}

function resolveCodexBinary({
  environment = process.env,
  isWindows = IS_WINDOWS,
  resolver = resolveCli
} = {}) {
  const explicit = environment[OVERRIDE_ENV];
  if (typeof explicit === "string" && explicit.trim()) {
    const platformPath = isWindows ? path.win32 : path;
    const configured = explicit.trim();
    if (!platformPath.isAbsolute(configured)) {
      throw new Error(`${OVERRIDE_ENV} must be an absolute path`);
    }
    let candidate = platformPath.normalize(configured);
    if (!fs.statSync(candidate).isFile()) throw new Error("explicit Codex path is not a file");
    if (!isWindows && !/\.(?:c?m?js)$/i.test(candidate)) {
      fs.accessSync(candidate, fs.constants.X_OK);
    }
    if (isWindows && /\.(?:cmd|bat)$/i.test(candidate)) {
      candidate = resolveWindowsShim(candidate, "codex");
    }
    return candidate;
  }

  // The shared resolver scans PATH as data, validates POSIX X_OK, follows
  // Windows npm shims without a shell, and never executes `which`/`where`.
  return resolver("codex", { fallbacks: cliFallbacks({ environment, isWindows }) });
}

function main() {
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

  const invocation = spawnTarget(binary, process.argv.slice(2));
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
}

if (require.main === module) main();

module.exports = { cliFallbacks, resolveCodexBinary };
