#!/usr/bin/env node

/**
 * Claude Delegator - Copilot MCP Bridge
 *
 * A zero-dependency MCP server that wraps the GitHub Copilot CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

const { spawn, execSync } = require("node:child_process");

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_EFFORT = "xhigh";
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);
const VALID_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const VALID_MODELS = new Set(["gpt-5.4", "gpt-5.3-codex", "claude-opus-4.6", "claude-sonnet-4.6"]);

const MAX_EFFORT_BY_FAMILY = {
  "gpt": "xhigh",
  "claude": "high"
};

function resolveEffort(model, requestedEffort) {
  const effort = requestedEffort || DEFAULT_EFFORT;
  const family = model.startsWith("claude") ? "claude" : "gpt";
  const maxEffort = MAX_EFFORT_BY_FAMILY[family];
  const ranking = ["low", "medium", "high", "xhigh"];
  const maxIdx = ranking.indexOf(maxEffort);
  const reqIdx = ranking.indexOf(effort);
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
  return isObject(request) && Object.prototype.hasOwnProperty.call(request, "id");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// --- Copilot CLI Wrapper ---

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour hard cap

const IS_WINDOWS = process.platform === "win32";

async function runCopilot(args, cwd, timeoutMs) {
  const t = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const effectiveTimeout = Math.min(Math.max(t, 10_000), MAX_TIMEOUT_MS);
  // Always force JSON output, non-interactive mode (no stdin approval prompts)
  const fullArgs = [...args, "--output-format", "json", "--silent", "--no-ask-user", "--no-custom-instructions"];

  return new Promise((resolve, reject) => {
    let settled = false;
    const copilotProcess = spawn(COPILOT_BIN, fullArgs, {
      env: process.env,
      shell: false,
      cwd: cwd || process.cwd(),
      detached: !IS_WINDOWS
    });

    function killTree(signal) {
      if (IS_WINDOWS) {
        try { execSync(`taskkill /F /T /PID ${copilotProcess.pid}`, { stdio: "ignore" }); } catch (e) { /* already dead */ }
      } else {
        try { process.kill(-copilotProcess.pid, signal); } catch (e) { /* already dead */ }
      }
    }

    let exited = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killTree("SIGTERM");
        const killTimer = setTimeout(() => { if (!exited) killTree("SIGKILL"); }, 3000);
        killTimer.unref();
        reject(new Error(`Copilot CLI timed out after ${effectiveTimeout / 1000}s`));
      }
    }, effectiveTimeout);

    let stdout = "";
    let stderr = "";

    copilotProcess.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);

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
            if (data.type === "assistant.message" && data.data && data.data.content) {
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

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-copilot", version: "1.2.0" }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: [
        {
          name: "copilot",
          description: "Start a new Copilot expert session (GPT or Claude models via GitHub Copilot)",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The delegation prompt" },
              "developer-instructions": { type: "string", description: "Expert system instructions" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
              cwd: { type: "string", description: "Current working directory" },
              model: { type: "string", enum: [...VALID_MODELS], default: DEFAULT_MODEL, description: "Model to use" },
              effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], default: DEFAULT_EFFORT, description: "Reasoning effort level" },
              timeout: { type: "number", description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" }
            },
            required: ["prompt"]
          }
        },
        {
          name: "copilot-reply",
          description: "Continue an existing Copilot session",
          inputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string", description: "Session ID returned by a previous copilot call" },
              prompt: { type: "string", description: "Follow-up prompt" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
              cwd: { type: "string" },
              effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], default: DEFAULT_EFFORT, description: "Reasoning effort level" },
              timeout: { type: "number", description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" }
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
    if (args.sandbox !== undefined && !VALID_SANDBOX_VALUES.has(args.sandbox)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'sandbox' must be 'read-only' or 'workspace-write'");
      return;
    }
    if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'cwd' must be a non-empty string when provided");
      return;
    }
    if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'effort' must be 'low', 'medium', 'high', or 'xhigh'");
      return;
    }
    if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout < 0)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'timeout' must be a non-negative number (milliseconds)");
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
        copilotArgs.push("--effort", resolveEffort(model, args.effort));

        if (args.sandbox === "workspace-write") {
          copilotArgs.push("--allow-all-tools");
        } else {
          copilotArgs.push("--deny-tool=shell", "--deny-tool=write", "--deny-tool=edit");
        }

        let prompt = args.prompt;
        if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
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
        copilotArgs.push("--effort", resolveEffort(DEFAULT_MODEL, args.effort));
        if (args.sandbox === "workspace-write") {
          copilotArgs.push("--allow-all-tools");
        } else {
          copilotArgs.push("--deny-tool=shell", "--deny-tool=write", "--deny-tool=edit");
        }
        copilotArgs.push("-p", args.prompt);
      } else {
        if (shouldRespond) sendError(id, -32601, `Tool not found: ${name}`);
        return;
      }

      const { response, threadId } = await runCopilot(copilotArgs, args.cwd, args.timeout);

      if (threadId === "unknown" && name === "copilot") {
        if (shouldRespond) {
          sendResponse(id, {
            content: [{ type: "text", text: response + "\n\n(Warning: no session ID returned — multi-turn reply will not be available)" }],
            threadId: threadId
          });
        }
      } else if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: response }],
          threadId: threadId
        });
      }
    } catch (e) {
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true
        });
      }
    }
  },

  "notifications/initialized": () => {}
};

// --- Main Loop (Robust JSON-RPC stream handling) ---

let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString();
  let lines = buffer.split("\n");
  buffer = lines.pop(); // Keep partial line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      continue;
    }

    const shouldRespond = hasRequestId(request);
    if (!isObject(request) || typeof request.method !== "string") {
      if (shouldRespond) sendError(request.id, -32600, "Invalid Request");
      continue;
    }

    const handler = handlers[request.method];
    if (!handler) {
      if (shouldRespond) sendError(request.id, -32601, `Method not found: ${request.method}`);
      continue;
    }

    try {
      await handler(request.id, request.params, shouldRespond);
    } catch (e) {
      if (shouldRespond) sendError(request.id, -32603, `Internal error: ${e.message}`);
    }
  }
});

// Startup: resolve copilot binary path
// On Windows, npm shims are .cmd files that cannot be spawned with shell: false.
// Follow the shim to find the real executable.
let COPILOT_BIN;
try {
  const cmd = IS_WINDOWS ? "where copilot" : "which copilot";
  let resolved = execSync(cmd, { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  if (IS_WINDOWS && resolved.toLowerCase().endsWith(".cmd")) {
    const fs = require("node:fs");
    const shimContent = fs.readFileSync(resolved, "utf8");
    const match = shimContent.match(/"([^"]+copilot[^"]*\.js)"/i) ||
                  shimContent.match(/"([^"]+copilot[^"]*\.exe)"/i);
    if (match) {
      resolved = match[1];
    } else {
      console.error("Could not resolve copilot binary from .cmd shim. Falling back to shell mode.");
      process.exit(1);
    }
  }
  COPILOT_BIN = resolved;
  execSync(`"${COPILOT_BIN}" --version`, { stdio: "ignore" });
} catch (e) {
  console.error("Copilot CLI not found. Please install it first.");
  process.exit(1);
}
