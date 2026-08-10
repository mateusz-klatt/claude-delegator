#!/usr/bin/env node

/**
 * Claude Delegator - Copilot MCP Bridge
 *
 * A zero-dependency MCP server that wraps the GitHub Copilot CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

const { spawn, execSync } = require("node:child_process");
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

const COPILOT_CATALOG = modelCatalog.providers.copilot;
const DEFAULT_MODEL = COPILOT_CATALOG.defaultModel;
const DEFAULT_EFFORT = COPILOT_CATALOG.defaultEffort;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);
const VALID_EFFORT_VALUES = new Set(COPILOT_CATALOG.efforts);
const VALID_MODELS = new Set(COPILOT_CATALOG.models);
// Models known to reject the --effort flag entirely. The CLI advertises effort
// values globally, but individual model/value combinations can still be rejected
// by the backend; the catalog records only combinations actually called live.
const MODELS_WITHOUT_EFFORT = new Set([]);

// Per-model effort ceilings override the catalog fallback. Only gpt-5.6-sol is
// verified to accept --effort max (2026-08-10); every other model stays capped
// at xhigh until individually verified — the CLI parser takes "max" for any
// model, but backend support is per-model. The fallback is conservative rather
// than a claim that every listed model was called live at xhigh.
const MAX_EFFORT_BY_MODEL = COPILOT_CATALOG.maxEffortByModel;
const MIN_EFFORT_BY_MODEL = COPILOT_CATALOG.minEffortByModel || {};
const FALLBACK_MAX_EFFORT = COPILOT_CATALOG.fallbackMaxEffort;

function resolveEffort(model, requestedEffort) {
  const effort = requestedEffort || DEFAULT_EFFORT;
  const maxEffort = MAX_EFFORT_BY_MODEL[model] || FALLBACK_MAX_EFFORT;
  const minEffort = MIN_EFFORT_BY_MODEL[model];
  const maxIdx = COPILOT_CATALOG.efforts.indexOf(maxEffort);
  const reqIdx = COPILOT_CATALOG.efforts.indexOf(effort);
  if (minEffort && reqIdx < COPILOT_CATALOG.efforts.indexOf(minEffort)) return minEffort;
  if (reqIdx > maxIdx) return maxEffort;
  return effort;
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

// --- Copilot CLI Wrapper ---

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour hard cap

const IS_WINDOWS = process.platform === "win32";
const activeChildren = new Set();
const activeRequests = new Map();
let COPILOT_BIN;
let shuttingDown = false;

function killProcessTree(child, signal) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" }); } catch (_error) { /* already dead */ }
    return;
  }
  try { process.kill(-child.pid, signal); } catch (_error) { /* already dead */ }
}

async function runCopilot(args, cwd, timeoutMs, abortSignal) {
  const t = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const effectiveTimeout = Math.min(Math.max(t, 10_000), MAX_TIMEOUT_MS);
  // Always force JSON output, non-interactive mode (no stdin approval prompts)
  const fullArgs = [...args, "--output-format", "json", "--silent", "--no-ask-user", "--no-custom-instructions"];

  return new Promise((resolve, reject) => {
    let settled = false;
    const isJsFile = COPILOT_BIN.toLowerCase().endsWith(".js");
    const spawnCmd = isJsFile ? process.execPath : COPILOT_BIN;
    const spawnArgs = isJsFile ? [COPILOT_BIN, ...fullArgs] : fullArgs;
    const copilotProcess = spawn(spawnCmd, spawnArgs, {
      env: buildCalleeEnv(process.env),
      shell: false,
      cwd: cwd || process.cwd(),
      detached: !IS_WINDOWS
    });
    activeChildren.add(copilotProcess);

    function removeAbortListener() {
      if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
    }

    function forceKillLater() {
      const killTimer = setTimeout(() => {
        if (!exited) killProcessTree(copilotProcess, "SIGKILL");
      }, 3000);
      killTimer.unref();
    }

    function handleAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(copilotProcess, "SIGTERM");
      forceKillLater();
      reject(new Error("Copilot CLI call cancelled"));
    }

    let exited = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        removeAbortListener();
        killProcessTree(copilotProcess, "SIGTERM");
        forceKillLater();
        reject(new Error(`Copilot CLI timed out after ${effectiveTimeout / 1000}s`));
      }
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

    copilotProcess.on("error", (err) => {
      activeChildren.delete(copilotProcess);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      if (err.code === "ENOENT") {
        const cwdNote = cwd ? ` (cwd: ${cwd})` : "";
        reject(new Error(`Copilot CLI not found or invalid working directory${cwdNote}. Install with 'npm install -g @github/copilot'.`));
      } else {
        reject(err);
      }
    });

    copilotProcess.stdout.on("data", (data) => { stdout += data.toString(); });
    copilotProcess.stderr.on("data", (data) => { stderr += data.toString(); });

    copilotProcess.on("close", (code) => {
      activeChildren.delete(copilotProcess);
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();

      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Copilot exited with code ${code}`));
      }

      try {
        // Copilot --output-format json emits JSONL events. Key events:
        //   {type:"assistant.message", data:{content:"..."}} → response text (may repeat)
        //   {type:"result", sessionId:"uuid", exitCode:0}   → session ID at top level
        const lines = stdout.trim().split("\n").filter(l => l.trim());
        const chunks = [];
        let sessionId = "unknown";
        let resultExitCode = 0;

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.type === "assistant.message" && data.data?.content) {
              chunks.push(data.data.content);
            }
            if (data.type === "result") {
              if (data.sessionId) sessionId = data.sessionId;
              if (data.exitCode !== undefined) resultExitCode = data.exitCode;
            }
          } catch (e) {
            // Not JSON — ignore terminal noise
          }
        }

        if (resultExitCode !== 0) {
          return reject(new Error(`Copilot session failed with exitCode ${resultExitCode}`));
        }

        const response = chunks.join("") || "(No output)";

        resolve({
          response: response.trim(),
          threadId: sessionId
        });
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}\nRaw output was: ${stdout}`));
      }
    });
  });
}

// --- Request Handlers ---

const COPILOT_TOOLS = [
  {
    name: "copilot",
    description: "Start a new Copilot expert session (GPT, Claude, Gemini, and other Copilot models)",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The delegation prompt" },
        "developer-instructions": { type: "string", description: "Expert system instructions" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: "read-only denies shell/write/edit; workspace-write enables all tools for unattended execution" },
        cwd: { type: "string", description: "Current working directory" },
        model: { type: "string", enum: COPILOT_CATALOG.models, default: DEFAULT_MODEL, description: "Model to use" },
        effort: { type: "string", enum: COPILOT_CATALOG.efforts, default: DEFAULT_EFFORT, description: "Reasoning effort level (max verified on gpt-5.6-sol only; other models cap at xhigh)" },
        timeout: { type: "number", minimum: 10_000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" },
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "copilot-reply",
    description: "Continue an existing Copilot session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Session ID returned by a previous copilot call" },
        prompt: { type: "string", description: "Follow-up prompt" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: "read-only denies shell/write/edit; workspace-write enables all tools for unattended execution" },
        cwd: { type: "string" },
        effort: { type: "string", enum: COPILOT_CATALOG.efforts, description: "Optional reasoning effort override (max is capped to xhigh because a resumed session's model is unknown)" },
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
      serverInfo: { name: "claude-delegator-copilot", version: PACKAGE_VERSION }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: COPILOT_TOOLS
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
    if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: 'effort' must be one of: ${COPILOT_CATALOG.efforts.join(", ")}`);
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

    try {
      const copilotArgs = [];
      if (name === "copilot") {
        if (args.model !== undefined && !VALID_MODELS.has(args.model)) {
          if (shouldRespond) sendError(id, -32602, `Invalid params: 'model' must be one of: ${[...VALID_MODELS].join(", ")}`);
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

        const model = args.model || DEFAULT_MODEL;
        copilotArgs.push("--model", model);
        if (!MODELS_WITHOUT_EFFORT.has(model)) {
          copilotArgs.push("--effort", resolveEffort(model, args.effort));
        }

        if (args.sandbox === "read-only") {
          copilotArgs.push("--deny-tool=shell", "--deny-tool=write", "--deny-tool=edit");
        } else {
          copilotArgs.push("--allow-all-tools");
        }

        let prompt = args.prompt;
        if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
        prompt = appendCoordinationInstructions(prompt, coordination);
        copilotArgs.push("-p", prompt);
      } else if (name === "copilot-reply") {
        if (!isNonEmptyString(args.threadId)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for copilot-reply");
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

        copilotArgs.push("--resume", threadId);
        // The resumed session already carries its model and effort; only forward
        // --effort when the caller explicitly asks for a change. The model is not
        // known at resume time, so max uses the conservative catalog fallback cap.
        if (args.effort !== undefined) {
          copilotArgs.push("--effort", args.effort === "max" ? FALLBACK_MAX_EFFORT : args.effort);
        }
        if (args.sandbox === "read-only") {
          copilotArgs.push("--deny-tool=shell", "--deny-tool=write", "--deny-tool=edit");
        } else {
          copilotArgs.push("--allow-all-tools");
        }
        copilotArgs.push("-p", appendCoordinationInstructions(args.prompt, coordination));
      } else {
        if (shouldRespond) sendError(id, -32602, `Unknown tool: ${name}`);
        return;
      }

      const abortController = new AbortController();
      if (shouldRespond) activeRequests.set(id, abortController);
      let result;
      try {
        result = await runCopilot(copilotArgs, args.cwd, args.timeout, abortController.signal);
      } finally {
        if (shouldRespond) activeRequests.delete(id);
      }
      const { response, threadId } = result;

      if (threadId === "unknown" && name === "copilot") {
        if (shouldRespond) {
          sendResponse(id, {
            content: [{ type: "text", text: resultText(threadId, response + "\n\n(Warning: no session ID returned — multi-turn reply will not be available)") }],
            threadId: threadId,
            ...coordinationMetadata(coordination)
          });
        }
      } else if (shouldRespond) {
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

// Startup: resolve copilot binary path
// On Windows, npm shims are .cmd files that cannot be spawned with shell: false.
// Follow the shim to find the real executable.
try {
  const cmd = IS_WINDOWS ? "where copilot" : "which copilot";
  const candidates = execSync(cmd, { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  // On Windows, prefer .exe (e.g. winget copilot.exe) over the npm .cmd shim — the
  // shim points to a .js loader that triggers the "Open with..." dialog when spawned
  // without shell. .cmd is the fallback.
  let resolved = IS_WINDOWS
    ? (candidates.find(c => c.toLowerCase().endsWith(".exe"))
        || candidates.find(c => c.toLowerCase().endsWith(".cmd"))
        || candidates[0])
    : candidates[0];
  if (IS_WINDOWS && resolved.toLowerCase().endsWith(".cmd")) {
    const fs = require("node:fs");
    const path = require("node:path");
    const shimContent = fs.readFileSync(resolved, "utf8");
    const match = shimContent.match(/"([^"]+copilot[^"]*\.js)"/i) ||
                  shimContent.match(/"([^"]+copilot[^"]*\.exe)"/i);
    if (match) {
      // Expand %dp0% (cmd-shell variable for .cmd's directory, with trailing slash)
      const dp0 = path.dirname(resolved) + path.sep;
      resolved = match[1].replace(/%dp0%\\?/gi, dp0);
    } else {
      console.error("Could not resolve copilot binary from .cmd shim. Falling back to shell mode.");
      process.exit(1);
    }
  }
  COPILOT_BIN = resolved;
  // stdio: "pipe" (not "ignore") — winget copilot.exe crashes with stdio:ignore.
  const validateCmd = COPILOT_BIN.toLowerCase().endsWith(".js")
    ? `"${process.execPath}" "${COPILOT_BIN}" --version`
    : `"${COPILOT_BIN}" --version`;
  execSync(validateCmd, { stdio: "pipe" });
} catch (e) {
  console.error("Copilot CLI not found. Please install it first.");
  process.exit(1);
}
}

module.exports = {
  handlers,
  resolveEffort,
  toolDefinitions: COPILOT_TOOLS
};
