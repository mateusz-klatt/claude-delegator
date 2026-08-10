#!/usr/bin/env node

/**
 * Transparent Codex MCP launcher.
 *
 * Keeps Codex's native `codex` / `codex-reply` protocol unchanged while
 * removing the caller's Agent Mail identity and credentials at the process
 * boundary. Works with native executables and npm-style shims on Windows.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { buildCalleeEnv } = require("../shared/environment.js");

const IS_WINDOWS = process.platform === "win32";
const OVERRIDE_ENV = "CODEX_DELEGATOR_CODEX_BIN";

function commandForBinary(binary, args) {
  if (/\.(?:c?m?js)$/i.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
}

function findWindowsCommandCandidates(commandName) {
  const candidates = [];
  const extensions = [".exe", ".cmd", ".bat", ".com", ".js", ".cjs", ".mjs", ""];
  for (const rawDirectory of (process.env.PATH || "").split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${commandName}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) candidates.push(candidate);
      } catch (_error) {
        // Missing or inaccessible PATH entry.
      }
    }
  }
  return candidates;
}

function resolveWindowsShim(shimPath) {
  const shimContent = fs.readFileSync(shimPath, "utf8");
  const match = shimContent.match(/['"]([^'"\r\n]*codex[^'"\r\n]*\.(?:c?m?js|exe))['"]/i);
  if (!match) throw new Error("Could not resolve Codex binary from Windows shim");

  const shimDirectory = `${path.dirname(shimPath)}${path.sep}`;
  const expanded = match[1]
    .replace(/%dp0%[\\/]?/gi, shimDirectory)
    .replace(/%~dp0[\\/]?/gi, shimDirectory);
  return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(shimPath), expanded);
}

function resolveCodexBinary() {
  const explicit = process.env[OVERRIDE_ENV];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const candidates = IS_WINDOWS
    ? findWindowsCommandCandidates("codex")
    : execFileSync("which", ["codex"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  if (candidates.length === 0) throw new Error("Codex CLI not found");

  let resolved = IS_WINDOWS
    ? (candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ||
       candidates.find((candidate) => candidate.toLowerCase().endsWith(".cmd")) ||
       candidates.find((candidate) => candidate.toLowerCase().endsWith(".bat")) ||
       candidates[0])
    : candidates[0];
  if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(resolved)) resolved = resolveWindowsShim(resolved);
  return resolved;
}

function killProcessTree(child, signal) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch (_error) {
      // The process may already have exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (_error) {
    // The process group may already have exited.
  }
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
