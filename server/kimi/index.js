#!/usr/bin/env node

/**
 * Claude Delegator - Kimi MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Kimi Code CLI (`kimi`).
 * Speaks JSON-RPC 2.0 over stdio.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
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

const KIMI_CATALOG = modelCatalog.providers.kimi;
const DEFAULT_MODEL = KIMI_CATALOG.defaultModel;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

// Delegation-depth guard, mirroring the Claude and Agy bridges. Defence in
// depth, not a security boundary: the child can still invoke any CLI itself.
const DEPTH_ENV_VAR = "CLAUDE_DELEGATOR_KIMI_DEPTH";
const MAX_DELEGATION_DEPTH = 1;

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

function currentDelegationDepth(source = process.env) {
  const parsed = Number.parseInt(String(source[DEPTH_ENV_VAR] ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// --- Kimi CLI Wrapper ---

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour hard cap
const MIN_TIMEOUT_MS = 10_000;

const IS_WINDOWS = process.platform === "win32";
const activeChildren = new Set();
const activeRequests = new Map();
let KIMI_BIN;
let shuttingDown = false;

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

function parseKimiOutput(stdout) {
  // kimi --output-format stream-json emits JSONL. Relevant events:
  //   {"role":"assistant","content":"..."}                       → response text (may repeat)
  //   {"role":"meta","type":"session.resume_hint","session_id":…} → session id, last line
  //   {"role":"meta","type":"system.version","version":"…"}       → ignored
  const chunks = [];
  let sessionId = "unknown";

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON — ignore terminal noise.
      continue;
    }
    if (!isObject(event)) continue;
    if (event.role === "assistant" && typeof event.content === "string") {
      chunks.push(event.content);
    }
    if (isNonEmptyString(event.session_id)) {
      sessionId = event.session_id.trim();
    }
  }

  return { response: chunks.join("").trim(), sessionId };
}

function buildKimiEnv(source = process.env) {
  const env = buildCalleeEnv(source);
  env[DEPTH_ENV_VAR] = String(currentDelegationDepth(source) + 1);
  return env;
}

async function runKimi(args, cwd, timeoutMs, abortSignal, expectedThreadId) {
  const t = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const effectiveTimeout = Math.min(Math.max(t, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  // kimi has no timeout flag of its own, so the bridge deadline is the only one.
  const fullArgs = [...args, "--output-format", "stream-json"];

  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    const isJsFile = KIMI_BIN.toLowerCase().endsWith(".js");
    const spawnCmd = isJsFile ? process.execPath : KIMI_BIN;
    const spawnArgs = isJsFile ? [KIMI_BIN, ...fullArgs] : fullArgs;
    const kimiProcess = spawn(spawnCmd, spawnArgs, {
      env: buildKimiEnv(process.env),
      shell: false,
      cwd: cwd || process.cwd(),
      detached: !IS_WINDOWS,
      // stdin is never written to; give the child nothing to block on.
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChildren.add(kimiProcess);

    function removeAbortListener() {
      if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
    }

    function forceKillLater() {
      const forceKillTimer = setTimeout(() => {
        if (!exited) killProcessTree(kimiProcess, "SIGKILL");
      }, 3_000);
      forceKillTimer.unref();
    }

    function handleAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      killProcessTree(kimiProcess, "SIGTERM");
      forceKillLater();
      reject(new Error("Kimi CLI call cancelled"));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      killProcessTree(kimiProcess, "SIGTERM");
      forceKillLater();
      reject(new Error(`Kimi CLI timed out after ${effectiveTimeout / 1000}s`));
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

    kimiProcess.on("error", (err) => {
      activeChildren.delete(kimiProcess);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();
      if (err.code === "ENOENT") {
        const cwdNote = cwd ? ` (cwd: ${cwd})` : "";
        reject(new Error(`Kimi CLI not found or invalid working directory${cwdNote}. Install Kimi Code and ensure 'kimi' is on PATH.`));
      } else {
        reject(err);
      }
    });

    kimiProcess.stdout.on("data", (data) => { stdout += data.toString(); });
    kimiProcess.stderr.on("data", (data) => { stderr += data.toString(); });

    kimiProcess.on("close", (code) => {
      activeChildren.delete(kimiProcess);
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener();

      // Unlike Agy, kimi failures are exit-code shaped: an unknown model exits 1
      // with the explanation on stderr and only the version banner on stdout.
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Kimi exited with code ${code}`));
      }

      const { response, sessionId } = parseKimiOutput(stdout);

      if (!response) {
        return reject(new Error(stderr.trim() || `Kimi produced no assistant output. Raw output was: ${stdout}`));
      }

      if (expectedThreadId && sessionId !== "unknown" && sessionId !== expectedThreadId) {
        return reject(new Error(
          `Kimi resumed a different session: requested ${expectedThreadId}, received ${sessionId}. The original session was not continued.`
        ));
      }

      resolve({ response, threadId: sessionId });
    });
  });
}

// --- Request Handlers ---

const SANDBOX_DESCRIPTION =
  "Only 'workspace-write' is supported. Kimi print mode has no permission tier at all — " +
  "--plan, --yolo and --auto are rejected outright when combined with a prompt, and tools run unattended. " +
  "'read-only' is refused rather than silently ignored. Carry advisory intent in developer-instructions.";

const KIMI_TOOLS = [
  {
    name: "kimi",
    description: "Start a new Kimi Code expert session (Moonshot Kimi models)",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The delegation prompt" },
        "developer-instructions": { type: "string", description: "Expert system instructions" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: SANDBOX_DESCRIPTION },
        cwd: { type: "string", description: "Working directory. Note that a repository-supplied AGENTS.md here is auto-loaded into the session and cannot be disabled." },
        model: {
          type: "string",
          default: DEFAULT_MODEL,
          examples: KIMI_CATALOG.models,
          description: "Model alias from ~/.kimi-code/config.toml. Free-form because the roster is user-extensible; kimi rejects an unknown alias before doing any work."
        },
        timeout: { type: "number", minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" },
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "kimi-reply",
    description: "Continue an existing Kimi Code session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "session_id returned by a previous kimi call" },
        prompt: { type: "string", description: "Follow-up prompt" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: SANDBOX_DESCRIPTION },
        cwd: { type: "string", description: "Working directory" },
        timeout: { type: "number", minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: "Timeout in milliseconds (default: 900000 = 15 min, max: 3600000 = 1 hour)" },
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
      serverInfo: { name: "claude-delegator-kimi", version: PACKAGE_VERSION }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: KIMI_TOOLS
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
    if ((name === "kimi" || name === "kimi-reply") && currentDelegationDepth() >= MAX_DELEGATION_DEPTH) {
      if (shouldRespond) {
        sendError(id, -32603, `Refusing to delegate: this bridge is already running inside a delegated Kimi session (${DEPTH_ENV_VAR}=${currentDelegationDepth()}). Complete the work here instead of delegating further.`);
      }
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
    if (args.sandbox === "read-only") {
      // Refuse rather than accept a value that would change nothing. kimi print
      // mode rejects --plan/--yolo/--auto outright and always runs tools, so
      // honouring read-only is impossible; silently ignoring it would advertise
      // a guarantee the caller could act on.
      if (shouldRespond) {
        sendError(id, -32602, "Invalid params: 'sandbox: read-only' is not supported by Kimi. Print mode has no permission tier — it rejects --plan, --yolo and --auto, and always runs tools unattended. Use 'workspace-write' and carry a do-not-modify instruction in developer-instructions, or delegate to a provider that can enforce denial.");
      }
      return;
    }
    if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'cwd' must be a non-empty string when provided");
      return;
    }
    if (args.model !== undefined && !isNonEmptyString(args.model)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'model' must be a non-empty string when provided");
      return;
    }
    if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout < MIN_TIMEOUT_MS || args.timeout > MAX_TIMEOUT_MS)) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: 'timeout' must be from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds`);
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
      const kimiArgs = [];
      let expectedThreadId;

      if (name === "kimi") {
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }
        if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
          return;
        }

        kimiArgs.push("-m", args.model || DEFAULT_MODEL);

        let prompt = args.prompt;
        if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
        prompt = appendCoordinationInstructions(prompt, coordination);
        kimiArgs.push("-p", prompt);
      } else if (name === "kimi-reply") {
        if (!isNonEmptyString(args.threadId)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for kimi-reply");
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

        expectedThreadId = threadId;
        // -S resumes an explicit id. --continue is never used: it resumes
        // "the previous session for the working directory", which would cross
        // -talk between concurrent delegations sharing a cwd.
        kimiArgs.push("-S", threadId);
        if (args.model !== undefined) kimiArgs.push("-m", args.model);
        kimiArgs.push("-p", appendCoordinationInstructions(args.prompt, coordination));
      } else {
        if (shouldRespond) sendError(id, -32602, `Unknown tool: ${name}`);
        return;
      }

      const abortController = new AbortController();
      if (shouldRespond) activeRequests.set(id, abortController);
      let result;
      try {
        result = await runKimi(kimiArgs, args.cwd, args.timeout, abortController.signal, expectedThreadId);
      } finally {
        if (shouldRespond) activeRequests.delete(id);
      }
      const { response, threadId } = result;

      if (!shouldRespond) return;

      if (threadId === "unknown" && name === "kimi") {
        sendResponse(id, {
          content: [{ type: "text", text: resultText(threadId, response + "\n\n(Warning: no session id returned — multi-turn reply will not be available)") }],
          threadId: threadId,
          ...coordinationMetadata(coordination)
        });
      } else {
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
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep partial line in buffer

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

  // Startup: resolve the kimi binary. Kimi Code installs to ~/.kimi-code/bin,
  // which is frequently absent from the minimal PATH an MCP server inherits.
  try {
    const candidates = [];
    try {
      const listed = execFileSync(IS_WINDOWS ? "where" : "which", ["kimi"], { encoding: "utf8" });
      candidates.push(...listed.trim().split(/\r?\n/).filter(Boolean));
    } catch {
      // Not on PATH; fall through to the explicit candidates below.
    }
    const home = os.homedir();
    if (IS_WINDOWS) {
      candidates.push(path.join(home, ".kimi-code", "bin", "kimi.exe"));
      candidates.push(path.join(home, ".kimi-code", "bin", "kimi.cmd"));
    } else {
      candidates.push(path.join(home, ".kimi-code", "bin", "kimi"));
    }

    const resolved = candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

    if (!resolved) throw new Error("kimi not found");
    KIMI_BIN = resolved;
    execFileSync(KIMI_BIN, ["--version"], { stdio: "pipe" });
  } catch {
    console.error("Kimi CLI not found. Install Kimi Code and ensure 'kimi' is on PATH.");
    process.exit(1);
  }
}

module.exports = {
  buildKimiEnv,
  handlers,
  parseKimiOutput,
  toolDefinitions: KIMI_TOOLS
};
