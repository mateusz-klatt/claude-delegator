#!/usr/bin/env node

/**
 * Claude Delegator - Claude MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Claude Code CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { version: PACKAGE_VERSION } = require("../../package.json");
const modelCatalog = require("../../config/model-catalog.json");
const {
  appendCoordinationInstructions,
  coordinationMetadata,
  coordinationSchema,
  validateCoordination
} = require("../shared/coordination.js");
const { buildCalleeEnv } = require("../shared/environment.js");

const CLAUDE_CATALOG = modelCatalog.providers.claude;
const DEFAULT_MODEL = CLAUDE_CATALOG.defaultModel;
const DEFAULT_EFFORT = CLAUDE_CATALOG.defaultEffort;
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MIN_TIMEOUT_MS = 10_000;
const VALID_MODELS = new Set([
  ...CLAUDE_CATALOG.models,
  ...Object.keys(CLAUDE_CATALOG.aliases)
]);
const VALID_EFFORT_VALUES = new Set(CLAUDE_CATALOG.efforts);
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);
const IS_WINDOWS = process.platform === "win32";
// Delegation-loop guard. The bridge stamps this into every child environment, and the
// variable survives each further hop (see server/shared/environment.js), so a Claude
// session reached through this bridge cannot reach another one — directly, or via a
// round trip through Codex or any other provider that is configured to call back here.
const DEPTH_ENV_VAR = "CLAUDE_DELEGATOR_CLAUDE_DEPTH";
const MAX_DELEGATION_DEPTH = 1;
const activeChildren = new Set();
const activeRequests = new Map();
let shuttingDown = false;

// --- MCP Protocol Helpers ---

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  })}\n`);
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

function currentDelegationDepth(source = process.env) {
  const parsed = Number.parseInt(String(source[DEPTH_ENV_VAR] ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function validateCommonArguments(args) {
  if (args.sandbox !== undefined && !VALID_SANDBOX_VALUES.has(args.sandbox)) {
    throw new TypeError("'sandbox' must be 'read-only' or 'workspace-write'");
  }
  if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
    throw new TypeError("'cwd' must be a non-empty string when provided");
  }
  if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
    throw new TypeError("'effort' must be 'low', 'medium', 'high', 'xhigh', or 'max'");
  }
  if (args.timeout !== undefined && (
    typeof args.timeout !== "number" ||
    !Number.isFinite(args.timeout) ||
    args.timeout < MIN_TIMEOUT_MS ||
    args.timeout > MAX_TIMEOUT_MS
  )) {
    throw new TypeError(`'timeout' must be from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return validateCoordination(args.coordination);
}

// --- Claude CLI Wrapper ---

function commandForBinary(binary, args) {
  if (/\.(?:c?m?js)$/i.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  return { command: binary, args };
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

function parseClaudeOutput(stdout, fallbackThreadId) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Claude CLI returned no JSON output");
  }

  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  let data;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed) && (
        Object.hasOwn(parsed, "result") ||
        Object.hasOwn(parsed, "session_id")
      )) {
        data = parsed;
        break;
      }
    } catch (_error) {
      // Ignore terminal noise and try the next complete JSON candidate.
    }
  }

  if (!data) {
    throw new Error(`no Claude result object found\nRaw output was: ${stdout}`);
  }
  if (data.is_error === true || data.subtype === "error") {
    throw new Error(typeof data.result === "string" ? data.result : "Claude session failed");
  }

  const response = typeof data.result === "string" && data.result.trim()
    ? data.result.trim()
    : "(No output)";
  const threadId = isNonEmptyString(data.session_id)
    ? data.session_id.trim()
    : (fallbackThreadId || "unknown");

  return { response, threadId };
}

async function runClaude(args, cwd, timeoutMs, fallbackThreadId, abortSignal) {
  const requestedTimeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  const effectiveTimeout = Math.max(requestedTimeout, MIN_TIMEOUT_MS);
  const invocation = commandForBinary(CLAUDE_BIN, args);
  const childEnv = buildCalleeEnv(process.env);
  childEnv[DEPTH_ENV_VAR] = String(currentDelegationDepth() + 1);

  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(invocation.command, invocation.args, {
      cwd: cwd || process.cwd(),
      detached: !IS_WINDOWS,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChildren.add(child);

    function removeAbortListener() {
      if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
    }

    function forceKillLater() {
      const forceKillTimer = setTimeout(() => {
        if (!exited) killProcessTree(child, "SIGKILL");
      }, 3_000);
      forceKillTimer.unref();
    }

    function handleAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child, "SIGTERM");
      forceKillLater();
      reject(new Error("Claude CLI call cancelled"));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      killProcessTree(child, "SIGTERM");
      forceKillLater();
      reject(new Error(`Claude CLI timed out after ${effectiveTimeout / 1000}s`));
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
        reject(new Error(`Claude CLI not found or invalid working directory${cwdNote}. Install Claude Code first.`));
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

      if (code !== 0) {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
        return;
      }

      try {
        resolve(parseClaudeOutput(stdout, fallbackThreadId));
      } catch (error) {
        reject(new Error(`Parse error: ${error.message}`));
      }
    });
  });
}

function sandboxArguments(sandbox) {
  if (sandbox === "read-only") return ["--permission-mode", "plan"];
  return ["--dangerously-skip-permissions"];
}

// --- Request Handlers ---

const timeoutSchema = {
  type: "number",
  minimum: MIN_TIMEOUT_MS,
  maximum: MAX_TIMEOUT_MS,
  default: DEFAULT_TIMEOUT_MS,
  description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)"
};

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-claude", version: PACKAGE_VERSION }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: [
        {
          name: "claude",
          description: "Start a new Claude Code expert session",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              prompt: { type: "string", minLength: 1, description: "The delegation prompt" },
              "developer-instructions": { type: "string", description: "Expert system instructions" },
              sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: "read-only uses Claude plan mode; workspace-write bypasses prompts for unattended full-tool execution" },
              cwd: { type: "string", minLength: 1, description: "Current working directory" },
              model: { type: "string", enum: [...VALID_MODELS], default: DEFAULT_MODEL },
              effort: { type: "string", enum: [...VALID_EFFORT_VALUES], default: DEFAULT_EFFORT },
              timeout: timeoutSchema,
              coordination: coordinationSchema
            },
            required: ["prompt"]
          }
        },
        {
          name: "claude-reply",
          description: "Continue an existing Claude Code session",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              threadId: { type: "string", minLength: 1, description: "Session ID returned by a previous claude call" },
              prompt: { type: "string", minLength: 1, description: "Follow-up prompt" },
              sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: "read-only uses Claude plan mode; workspace-write bypasses prompts for unattended full-tool execution" },
              cwd: { type: "string", minLength: 1, description: "Current working directory" },
              effort: { type: "string", enum: [...VALID_EFFORT_VALUES], description: "Optional effort override; omit to let the resumed session keep its current setting" },
              timeout: timeoutSchema,
              coordination: coordinationSchema
            },
            required: ["threadId", "prompt"]
          }
        }
      ]
    });
  },

  "tools/call": async (id, params, shouldRespond) => {
    if (!isObject(params)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: expected an object");
      return;
    }

    const { name, arguments: args } = params;
    if (!isNonEmptyString(name)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'name' must be a non-empty string");
      return;
    }
    if (!isObject(args)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'arguments' must be an object");
      return;
    }

    if ((name === "claude" || name === "claude-reply") &&
        currentDelegationDepth() >= MAX_DELEGATION_DEPTH) {
      if (shouldRespond) {
        sendError(id, -32603, `Refusing to delegate: this bridge is already running inside a delegated Claude session (${DEPTH_ENV_VAR}=${currentDelegationDepth()}). Complete the work here instead of delegating further.`);
      }
      return;
    }

    let coordination;
    try {
      coordination = validateCommonArguments(args);
    } catch (error) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: ${error.message}`);
      return;
    }

    const claudeArgs = ["-p", "--output-format", "json"];
    let fallbackThreadId;

    if (name === "claude") {
      if (!isNonEmptyString(args.prompt)) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
        return;
      }
      if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
        return;
      }
      if (args.model !== undefined && !VALID_MODELS.has(args.model)) {
        if (shouldRespond) sendError(id, -32602, `Invalid params: 'model' must be one of: ${[...VALID_MODELS].join(", ")}`);
        return;
      }

      claudeArgs.push(
        "--model", args.model || DEFAULT_MODEL,
        "--effort", args.effort || DEFAULT_EFFORT,
        ...sandboxArguments(args.sandbox)
      );
      if (args["developer-instructions"]) {
        claudeArgs.push("--append-system-prompt", args["developer-instructions"]);
      }
      claudeArgs.push(appendCoordinationInstructions(args.prompt, coordination));
    } else if (name === "claude-reply") {
      if (!isNonEmptyString(args.threadId)) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for claude-reply");
        return;
      }
      const threadId = args.threadId.trim();
      if (threadId === "latest" || threadId === "unknown") {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' must be an explicit session id");
        return;
      }
      if (!isNonEmptyString(args.prompt)) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
        return;
      }

      fallbackThreadId = threadId;
      claudeArgs.push(
        "--resume", threadId,
        ...(args.effort !== undefined ? ["--effort", args.effort] : []),
        ...sandboxArguments(args.sandbox),
        appendCoordinationInstructions(args.prompt, coordination)
      );
    } else {
      if (shouldRespond) sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }

    const abortController = new AbortController();
    if (shouldRespond) activeRequests.set(id, abortController);
    try {
      const { response, threadId } = await runClaude(
        claudeArgs,
        args.cwd,
        args.timeout,
        fallbackThreadId,
        abortController.signal
      );
      if (!shouldRespond) return;

      const warning = threadId === "unknown"
        ? "\n\n(Warning: no session ID returned — multi-turn reply will not be available)"
        : "";
      sendResponse(id, {
        content: [{ type: "text", text: response + warning }],
        threadId,
        ...coordinationMetadata(coordination)
      });
    } catch (error) {
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
          ...coordinationMetadata(coordination)
        });
      }
    } finally {
      if (shouldRespond) activeRequests.delete(id);
    }
  },

  "notifications/cancelled": (_id, params) => {
    if (!isObject(params) || !Object.hasOwn(params, "requestId")) return;
    activeRequests.get(params.requestId)?.abort();
  },
  "notifications/initialized": () => {}
};

// --- Main Loop ---

async function dispatchRequest(request) {
  const shouldRespond = hasRequestId(request);
  if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    if (shouldRespond) sendError(request.id, -32600, "Invalid Request");
    return;
  }

  const handler = handlers[request.method];
  if (!handler) {
    if (shouldRespond) sendError(request.id, -32601, `Method not found: ${request.method}`);
    return;
  }

  try {
    await handler(request.id, request.params, shouldRespond);
  } catch (error) {
    if (shouldRespond) sendError(request.id, -32603, `Internal error: ${error.message}`);
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch (_error) {
      sendError(null, -32700, "Parse error");
      continue;
    }
    // Do not await here: a cancellation notification can share this stdin
    // chunk with the long-running call it is cancelling.
    void dispatchRequest(request);
  }
});

function shutdown(exitCode) {
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
}

process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(130));
process.stdin.once("end", () => shutdown(0));

// --- Startup: resolve Claude binary path ---

function resolveWindowsShim(shimPath) {
  const shimContent = fs.readFileSync(shimPath, "utf8");
  const match = shimContent.match(/["']([^"'\r\n]*(?:claude|@anthropic-ai)[^"'\r\n]*\.(?:c?m?js|exe))["']/i);
  if (!match) {
    throw new Error("Could not resolve Claude binary from .cmd shim");
  }

  const shimDirectory = `${path.dirname(shimPath)}${path.sep}`;
  const expanded = match[1]
    .replace(/%dp0%[\\/]?/gi, shimDirectory)
    .replace(/%~dp0[\\/]?/gi, shimDirectory);
  return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(shimPath), expanded);
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

function resolveClaudeBinary() {
  const candidates = IS_WINDOWS
    ? findWindowsCommandCandidates("claude")
    : execFileSync("which", ["claude"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  if (candidates.length === 0) throw new Error("Claude CLI not found");

  let resolved = IS_WINDOWS
    ? (candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ||
       candidates.find((candidate) => candidate.toLowerCase().endsWith(".cmd")) ||
       candidates.find((candidate) => candidate.toLowerCase().endsWith(".bat")) ||
       candidates[0])
    : candidates[0];
  if (IS_WINDOWS && /\.(?:cmd|bat)$/i.test(resolved)) {
    resolved = resolveWindowsShim(resolved);
  }

  const validation = commandForBinary(resolved, ["--version"]);
  execFileSync(validation.command, validation.args, { stdio: "pipe" });
  return resolved;
}

let CLAUDE_BIN;
try {
  CLAUDE_BIN = resolveClaudeBinary();
} catch (_error) {
  console.error("Claude CLI not found. Please install Claude Code first.");
  process.exit(1);
}
