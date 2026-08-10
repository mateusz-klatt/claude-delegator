#!/usr/bin/env node

/**
 * Claude Delegator - Gemini MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Gemini CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

const { spawn, execFileSync, execSync } = require("node:child_process");
const { version: PACKAGE_VERSION } = require("../../package.json");
const modelCatalog = require("../../config/model-catalog.json");
const {
  appendCoordinationInstructions,
  coordinationMetadata,
  coordinationSchema,
  validateCoordination
} = require("../shared/coordination");
const { buildCalleeEnv } = require("../shared/environment");
const { resultText } = require("../shared/result");

const GEMINI_CATALOG = modelCatalog.providers.gemini;
const DEFAULT_MODEL = GEMINI_CATALOG.defaultModel;
const MODEL_EXAMPLES = [
  ...GEMINI_CATALOG.models,
  ...Object.keys(GEMINI_CATALOG.aliases).filter((alias) => !GEMINI_CATALOG.models.includes(alias))
];
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 3_600_000;
const TRUST_WORKSPACE_ENV = "GEMINI_CLI_TRUST_WORKSPACE";
const IS_WINDOWS = process.platform === "win32";
const activeChildren = new Set();
const activeRequests = new Map();
let shuttingDown = false;
let GEMINI_BIN;

function sandboxArguments(sandbox) {
  if (sandbox === "read-only") return ["--approval-mode", "plan"];
  return ["--approval-mode", "yolo"];
}

/**
 * Gemini gates every run behind folder trust. In an untrusted directory it overrides
 * the requested approval mode back to "default" and then fails, because a headless
 * child has nobody to answer the interactive trust prompt — which defeats both bridge
 * sandbox modes, not just workspace-write. Default the escape hatch Gemini documents
 * for automated environments to on; an operator who wants the gate back sets the
 * variable explicitly in the MCP server env and that value is preserved.
 */
function buildGeminiEnv(source = process.env) {
  const env = buildCalleeEnv(source);
  if (env[TRUST_WORKSPACE_ENV] === undefined) {
    env[TRUST_WORKSPACE_ENV] = "true";
  }
  return env;
}

// --- MCP Protocol Helpers ---

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result
  }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  }) + "\n");
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

// --- Gemini CLI Wrapper ---

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

function parseGeminiOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("No JSON response found");

  // Try the whole payload first, then each line newest-first. A greedy
  // brace match would span from the first '{' of any diagnostic line to the
  // last '}' of the payload and fail to parse, and it backtracks quadratically
  // on large noisy output. stdout and stderr are captured separately, so a
  // complete JSON candidate always occupies whole lines.
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed) && (
        Object.hasOwn(parsed, "response") ||
        Object.hasOwn(parsed, "session_id")
      )) {
        return parsed;
      }
    } catch {
      // Ignore terminal noise and try the next complete JSON candidate.
    }
  }

  throw new Error("No JSON response found");
}

async function runGemini(args, cwd, timeoutMs, abortSignal) {
  const effectiveTimeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    // Force JSON output for reliable parsing
    const geminiArgs = [...args, "-o", "json"];
    const isJsFile = GEMINI_BIN.toLowerCase().endsWith(".js");
    const spawnCmd = isJsFile ? process.execPath : GEMINI_BIN;
    const spawnArgs = isJsFile ? [GEMINI_BIN, ...geminiArgs] : geminiArgs;
    const geminiProcess = spawn(spawnCmd, spawnArgs, {
      env: buildGeminiEnv(process.env),
      shell: false,
      cwd: cwd || process.cwd(),
      detached: !IS_WINDOWS
    });
    activeChildren.add(geminiProcess);

    function removeAbortListener() {
      if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
    }

    function forceKillLater() {
      const forceKillTimer = setTimeout(() => {
        if (!exited) killProcessTree(geminiProcess, "SIGKILL");
      }, 3_000);
      forceKillTimer.unref();
    }

    function handleAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(geminiProcess, "SIGTERM");
      forceKillLater();
      reject(new Error("Gemini CLI call cancelled"));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      killProcessTree(geminiProcess, "SIGTERM");
      forceKillLater();
      reject(new Error(`Gemini CLI timed out after ${effectiveTimeout / 1000}s`));
    }, effectiveTimeout);

    if (abortSignal) {
      if (abortSignal.aborted) {
        handleAbort();
      } else {
        abortSignal.addEventListener("abort", handleAbort, { once: true });
      }
    }

    let stdout = "";
    let stderr = "";

    geminiProcess.on("error", (err) => {
      activeChildren.delete(geminiProcess);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      if (err.code === "ENOENT") {
        reject(new Error("Gemini CLI not found. Please install it with 'npm install -g @google/gemini-cli'."));
      } else {
        reject(err);
      }
    });

    geminiProcess.stdout.on("data", (data) => { stdout += data.toString(); });
    geminiProcess.stderr.on("data", (data) => { stderr += data.toString(); });

    geminiProcess.on("close", (code) => {
      activeChildren.delete(geminiProcess);
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Gemini exited with code ${code}`));
      }

      try {
        const data = parseGeminiOutput(stdout);
        resolve({
          response: data.response || "(No output)",
          threadId: data.session_id || "unknown"
        });
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}\nRaw output was: ${stdout}`));
      }
    });
  });
}

// --- Request Handlers ---

const GEMINI_TOOLS = [
  {
    name: "gemini",
    description: "Start a new Gemini expert session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The delegation prompt" },
        "developer-instructions": { type: "string", description: "Expert system instructions" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: "read-only maps to plan; workspace-write maps to yolo for unattended execution" },
        cwd: { type: "string", description: "Current working directory" },
        model: {
          type: "string",
          default: DEFAULT_MODEL,
          examples: MODEL_EXAMPLES,
          description: "Free-form model id or alias accepted by the installed Gemini CLI; examples reflect the verified registry"
        },
        timeout: { type: "number", minimum: 10_000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" },
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "gemini-reply",
    description: "Continue an existing Gemini session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Session ID returned by a previous gemini call" },
        prompt: { type: "string", description: "Follow-up prompt" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: "read-only maps to plan; workspace-write maps to yolo for unattended execution" },
        cwd: { type: "string" },
        timeout: { type: "number", minimum: 10_000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" },
        coordination: coordinationSchema
      },
      required: ["threadId", "prompt"]
    }
  }
];

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-gemini", version: PACKAGE_VERSION }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: GEMINI_TOOLS
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
    if (args.sandbox !== undefined && !VALID_SANDBOX_VALUES.has(args.sandbox)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'sandbox' must be 'read-only' or 'workspace-write'");
      return;
    }
    if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'cwd' must be a non-empty string when provided");
      return;
    }
    if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout < 10_000 || args.timeout > MAX_TIMEOUT_MS)) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: 'timeout' must be from 10000 to ${MAX_TIMEOUT_MS} milliseconds`);
      return;
    }

    let coordination;
    try {
      coordination = validateCoordination(args.coordination);
    } catch (e) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: ${e.message}`);
      return;
    }

    let abortController;
    try {
      const geminiArgs = [];
      if (name === "gemini") {
        if (args.model !== undefined && !isNonEmptyString(args.model)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'model' must be a non-empty string when provided");
          return;
        }
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }
        if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
          return;
        }

        geminiArgs.push("-m", args.model || DEFAULT_MODEL, ...sandboxArguments(args.sandbox));
        let prompt = args.prompt;
        if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
        prompt = appendCoordinationInstructions(prompt, coordination);
        geminiArgs.push("-p", prompt);
      } else if (name === "gemini-reply") {
        if (!isNonEmptyString(args.threadId)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for gemini-reply");
          return;
        }
        const threadId = args.threadId.trim();
        if (threadId === "latest") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' must be an explicit session id, not 'latest'");
          return;
        }
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }

        geminiArgs.push(
          "--resume",
          threadId,
          ...sandboxArguments(args.sandbox),
          "-p",
          appendCoordinationInstructions(args.prompt, coordination)
        );
      } else {
        if (shouldRespond) sendError(id, -32602, `Unknown tool: ${name}`);
        return;
      }

      abortController = new AbortController();
      if (shouldRespond) activeRequests.set(id, abortController);
      const { response, threadId } = await runGemini(
        geminiArgs,
        args.cwd,
        args.timeout,
        abortController.signal
      );

      // Embed threadId in the text envelope (clients strip sibling result
      // fields before the model sees them) and keep it at the top level for
      // orchestration rules and probes.
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: resultText(threadId, response) }],
          threadId: threadId,
          ...coordinationMetadata(coordination)
        });
      }
    } catch (e) {
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
          ...coordinationMetadata(coordination)
        });
      }
    } finally {
      if (shouldRespond && abortController) activeRequests.delete(id);
    }
  },

  "notifications/cancelled": (_id, params) => {
    if (!isObject(params) || !Object.hasOwn(params, "requestId")) return;
    activeRequests.get(params.requestId)?.abort();
  },
  "notifications/initialized": () => {}
};

// --- Main Loop (Robust JSON-RPC stream handling) ---

if (require.main === module) {
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let lines = buffer.split("\n");
  buffer = lines.pop(); // Keep partial line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
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

// Startup: resolve gemini binary path
// On Windows, npm shims are .cmd files that cannot be spawned with shell: false.
// Prefer .exe → .cmd shim (parsed for real .js); .js is spawned via node.
try {
  const cmd = IS_WINDOWS ? "where gemini" : "which gemini";
  const candidates = execSync(cmd, { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  let resolved = IS_WINDOWS
    ? (candidates.find(c => c.toLowerCase().endsWith(".exe"))
        || candidates.find(c => c.toLowerCase().endsWith(".cmd"))
        || candidates[0])
    : candidates[0];
  if (IS_WINDOWS && resolved.toLowerCase().endsWith(".cmd")) {
    const fs = require("node:fs");
    const path = require("node:path");
    const shimContent = fs.readFileSync(resolved, "utf8");
    const match = shimContent.match(/"([^"]+gemini[^"]*\.js)"/i) ||
                  shimContent.match(/"([^"]+gemini[^"]*\.exe)"/i);
    if (match) {
      // Expand %dp0% (cmd-shell variable for .cmd's directory, with trailing slash)
      const dp0 = path.dirname(resolved) + path.sep;
      resolved = match[1].replace(/%dp0%\\?/gi, dp0);
    } else {
      console.error("Could not resolve gemini binary from .cmd shim.");
      process.exit(1);
    }
  }
  GEMINI_BIN = resolved;
  const validateCmd = GEMINI_BIN.toLowerCase().endsWith(".js")
    ? `"${process.execPath}" "${GEMINI_BIN}" --version`
    : `"${GEMINI_BIN}" --version`;
  execSync(validateCmd, { stdio: "pipe" });
} catch {
  console.error("Gemini CLI not found. Please install it first.");
  process.exit(1);
}
}

module.exports = {
  buildGeminiEnv,
  handlers,
  sandboxArguments,
  toolDefinitions: GEMINI_TOOLS
};
