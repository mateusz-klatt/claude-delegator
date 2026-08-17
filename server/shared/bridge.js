"use strict";

/**
 * Shared core for the provider bridges.
 *
 * Every bridge speaks the same JSON-RPC 2.0 dialect over stdio, supervises a
 * child CLI the same way, and resolves that CLI's executable the same way. Only
 * four things genuinely differ per provider, and those stay in the provider
 * file: the tool schemas, the argv it builds, how it parses the CLI's output,
 * and how it classifies failure.
 *
 * Keeping the rest here is not tidiness. The same Windows .cmd defect had to be
 * fixed twice in two files on the same day, and a fifth copy of the shim logic
 * sat inline in the Copilot bridge where a grep for the function name could not
 * find it.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";

// House timeout contract, asserted by test/provider-config.test.js against the
// rules file: every bridge advertises exactly these bounds.
const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour hard cap
const MIN_TIMEOUT_MS = 10_000;

const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

// --- MCP protocol helpers ---

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRequestId(request) {
  return isObject(request) && Object.hasOwn(request, "id");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clampTimeout(timeoutMs) {
  const t = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(t, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// --- Process lifecycle ---

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

// --- Delegation-depth guard ---

/**
 * Defence in depth, not a security boundary: under workspace-write the child can
 * still invoke any CLI itself. The variable survives every further hop, so it
 * also closes indirect loops.
 */
function createDepthGuard(envVar, maxDepth = 1) {
  const current = (source = process.env) => {
    const parsed = Number.parseInt(String(source[envVar] ?? "").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    envVar,
    current,
    exceeded: (source = process.env) => current(source) >= maxDepth,
    stamp: (env, source = process.env) => {
      env[envVar] = String(current(source) + 1);
      return env;
    }
  };
}

// --- CLI resolution ---

/**
 * A Windows .cmd shim cannot be spawned with shell: false, so follow it to the
 * loader it wraps. `readShim` is injectable because this is the one code path
 * that no test on Linux or macOS can otherwise reach — it went unverified
 * through three releases exactly that way.
 */
function resolveWindowsShim(candidate, command, readShim = (p) => fs.readFileSync(p, "utf8"), aliases = []) {
  if (!/\.(?:cmd|bat)$/i.test(candidate)) return candidate;
  const shim = readShim(candidate);

  // Match the Claude bridge's shape, which was the most capable of the five
  // copies this replaces: either quote style, .cjs/.mjs as well as .js/.exe, and
  // an alias list because npm shims name the package rather than the command
  // (@anthropic-ai/... for `claude`).
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [command, ...aliases].map(escape).join("|");
  const match = new RegExp(
    `["']([^"'\\r\\n]*(?:${names})[^"'\\r\\n]*\\.(?:c?m?js|exe))["']`,
    "i"
  ).exec(shim);
  if (!match) throw new Error(`could not resolve ${command} from its .cmd shim`);

  // Both spellings occur in the wild: modern npm shims do `@SET "dp0=%~dp0"` and
  // then use %dp0%, older ones use %~dp0 directly. Use the win32 parser
  // explicitly — posix path.dirname returns "." for a backslash path, which
  // would silently resolve the loader to the wrong place, and did until a test
  // running on Linux caught it.
  const shimDirectory = path.win32.dirname(candidate) + path.win32.sep;
  const expanded = match[1]
    .replace(/%dp0%[\\/]?/gi, shimDirectory)
    .replace(/%~dp0[\\/]?/gi, shimDirectory);
  // Normalise either way: %dp0% expansion makes the path absolute *before* any
  // "..\" in the shim has been collapsed, so the absolute branch would otherwise
  // return C:\...\npm\..\lib\cli.js. Windows spawns that happily, but it is not a
  // path anything else can usefully compare or log.
  return path.win32.isAbsolute(expanded)
    ? path.win32.normalize(expanded)
    : path.win32.resolve(path.win32.dirname(candidate), expanded);
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ".com", ".js", ".cjs", ".mjs", ""];

/**
 * Pick the first usable candidate, honouring group order above extension order.
 *
 * `groups` is ordered by *provenance*: each PATH directory in PATH order, then
 * each fallback guess. Extension preference applies only **within** a group.
 *
 * That distinction is the whole point. Preferring `.exe` across the flattened
 * list let a hard-coded fallback that happens to exist outrank a real PATH hit
 * that happens to be a `.cmd` — measured on Windows, where it silently ran the
 * user's installed kimi.exe instead of the kimi.cmd first on PATH, then hung
 * with no stderr, no child process and no exit until the timeout. In production
 * it means a stale install beats a current one, and a deliberately shimmed PATH
 * is ignored without a word.
 */
function selectCandidate(groups, isUsable, isWindows = IS_WINDOWS) {
  for (const group of groups) {
    const present = group.filter(isUsable);
    if (present.length === 0) continue;
    if (!isWindows) return present[0];
    const byExtension = (extension) => present.find((c) => c.toLowerCase().endsWith(extension));
    return byExtension(".exe") || byExtension(".cmd") || byExtension(".bat") || present[0];
  }
  return undefined;
}

/**
 * Locate a provider CLI. `fallbacks` are guesses for install locations that are
 * often missing from the minimal PATH an MCP server inherits; they are only ever
 * a last resort, because a guess must never outrank a real hit from
 * `where`/`which` — neither by not existing, nor by carrying a better extension.
 */
function resolveCli(command, { fallbacks = [], readShim, aliases = [] } = {}) {
  const groups = [];
  if (IS_WINDOWS) {
    // Walk PATH directly rather than shelling out to where.exe: this depends on
    // neither that binary nor on PATHEXT being set as expected. One group per
    // directory, so the user's PATH order decides before extension preference.
    for (const rawDirectory of (process.env.PATH || "").split(path.delimiter)) {
      const directory = rawDirectory.trim().replace(/^"|"$/g, "");
      if (!directory) continue;
      groups.push(WINDOWS_EXTENSIONS.map((extension) => path.join(directory, `${command}${extension}`)));
    }
  } else {
    try {
      const listed = execFileSync("which", [command], { encoding: "utf8" });
      groups.push(...listed.trim().split(/\r?\n/).filter(Boolean).map((hit) => [hit]));
    } catch {
      // Not on PATH; fall through to the explicit candidates below.
    }
  }
  groups.push(...fallbacks.map((fallback) => [fallback]));

  const isUsable = (candidate) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      if (IS_WINDOWS) return true;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  let resolved = selectCandidate(groups, isUsable);

  if (!resolved) throw new Error(`${command} not found`);
  if (IS_WINDOWS) resolved = resolveWindowsShim(resolved, command, readShim, aliases);

  // Say which binary won. Choosing the wrong one produced no stderr, no exit and
  // no clue at all — the same silent class the Copilot error path was fixed for.
  console.error(`[claude-delegator] ${command} resolved to ${resolved}`);

  const validation = spawnTarget(resolved, ["--version"]);
  execFileSync(validation.command, validation.args, { stdio: "pipe" });
  return resolved;
}

/** Spawn arguments for a resolved binary, running a .js loader under node. */
function spawnTarget(binary, args) {
  // .cjs and .mjs loaders exist in the wild too; the Claude bridge already
  // matched all three and the other four only matched .js.
  if (/\.(?:c?m?js)$/i.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
}

// --- Child supervision ---

/**
 * Run a provider CLI to completion under the house lifecycle: a hard timeout, an
 * MCP cancellation signal, SIGTERM followed by SIGKILL over the whole process
 * group, and stdin closed so the child cannot block on a prompt headless mode can
 * never answer.
 *
 * Only the tail differs per provider, so `onClose` receives the exit code and both
 * streams and either returns the result or throws. That is deliberately the one
 * seam: `agy` cannot classify a run by exit code at all, `copilot` reports failure
 * inside its JSON, and both had that logic buried in an otherwise identical 70-line
 * block that no one was diffing.
 */
function superviseChild({
  abortSignal, activeChildren, args, binary, cwd, env, label,
  notFoundHint, onClose, onTimeout, timeoutMs
}) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  const target = spawnTarget(binary, args);

  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(target.command, target.args, {
      cwd: cwd || process.cwd(),
      detached: !IS_WINDOWS,
      env,
      shell: false,
      // stdin is never written to; give the child nothing to block on if it tries
      // to drop into an interactive OAuth or trust prompt.
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChildren.add(child);

    const removeAbortListener = () => {
      if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
    };

    const forceKillLater = () => {
      const forceKillTimer = setTimeout(() => {
        if (!exited) killProcessTree(child, "SIGKILL");
      }, 3_000);
      forceKillTimer.unref();
    };

    const terminate = (error) => {
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      killProcessTree(child, "SIGTERM");
      forceKillLater();
      reject(error);
    };

    function handleAbort() {
      if (settled) return;
      terminate(new Error(`${label} CLI call cancelled`));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      const seconds = effectiveTimeout / 1000;
      terminate(new Error(onTimeout ? onTimeout(seconds) : `${label} CLI timed out after ${seconds}s`));
    }, effectiveTimeout);

    if (abortSignal) {
      if (abortSignal.aborted) {
        handleAbort();
      } else {
        abortSignal.addEventListener("abort", handleAbort, { once: true });
      }
    }

    child.on("error", (error) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      if (error.code === "ENOENT") {
        const cwdNote = cwd ? ` (cwd: ${cwd})` : "";
        reject(new Error(`${label} CLI not found or invalid working directory${cwdNote}. ${notFoundHint}`));
      } else {
        reject(error);
      }
    });

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      activeChildren.delete(child);
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      try {
        resolve(onClose({ code, stderr, stdout }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

// --- Common request validation ---

/**
 * The checks every bridge performs before it touches provider-specific
 * arguments. Returns an error message, or null when the arguments are usable.
 */
function validateCommonArgs(args, { sandboxValues = VALID_SANDBOX_VALUES } = {}) {
  if (args.sandbox !== undefined && !sandboxValues.has(args.sandbox)) {
    return `Invalid params: 'sandbox' must be ${[...sandboxValues].map((v) => `'${v}'`).join(" or ")}`;
  }
  if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
    return "Invalid params: 'cwd' must be a non-empty string when provided";
  }
  if (args.timeout !== undefined && (
    typeof args.timeout !== "number" ||
    !Number.isFinite(args.timeout) ||
    args.timeout < MIN_TIMEOUT_MS ||
    args.timeout > MAX_TIMEOUT_MS
  )) {
    return `Invalid params: 'timeout' must be from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds`;
  }
  return null;
}

/** The timeout property every tool schema advertises, with the house bounds. */
function timeoutSchema() {
  return {
    type: "number",
    minimum: MIN_TIMEOUT_MS,
    maximum: MAX_TIMEOUT_MS,
    default: DEFAULT_TIMEOUT_MS,
    description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)"
  };
}

// --- Stdio loop ---

/**
 * Read newline-framed JSON-RPC from stdin and dispatch it, then shut the child
 * process group down on stdin end, SIGTERM and SIGINT.
 */
function runStdioLoop({ handlers, activeRequests, activeChildren }) {
  let buffer = "";
  let shuttingDown = false;

  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep the partial line.

    for (const line of lines) {
      if (!line.trim()) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        sendError(null, -32700, "Parse error");
        continue;
      }

      const shouldRespond = hasRequestId(request);
      if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        if (shouldRespond) sendError(request.id, -32600, "Invalid Request");
        continue;
      }

      const handler = handlers[request.method];
      if (!handler) {
        if (shouldRespond) sendError(request.id, -32601, `Method not found: ${request.method}`);
        continue;
      }

      try {
        Promise.resolve(handler(request.id, request.params, shouldRespond)).catch((e) => {
          if (shouldRespond) sendError(request.id, -32603, `Internal error: ${e.message}`);
        });
      } catch (e) {
        if (shouldRespond) sendError(request.id, -32603, `Internal error: ${e.message}`);
      }
    }
  });

  const shutdown = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const controller of activeRequests.values()) controller.abort();
    for (const child of activeChildren) killProcessTree(child, "SIGTERM");
    if (activeChildren.size === 0) {
      process.exit(exitCode);
      return;
    }
    setTimeout(() => {
      for (const child of activeChildren) killProcessTree(child, "SIGKILL");
      process.exit(exitCode);
    }, 500);
  };

  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(130));
  process.stdin.once("end", () => shutdown(0));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  IS_WINDOWS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  VALID_SANDBOX_VALUES,
  clampTimeout,
  createDepthGuard,
  hasRequestId,
  homedir: os.homedir,
  isNonEmptyString,
  isObject,
  killProcessTree,
  resolveCli,
  resolveWindowsShim,
  runStdioLoop,
  selectCandidate,
  sendError,
  sendResponse,
  spawnTarget,
  superviseChild,
  timeoutSchema,
  validateCommonArgs
};
