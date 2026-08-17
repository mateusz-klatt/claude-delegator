#!/usr/bin/env node

/**
 * Claude Delegator - Kimi MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Kimi Code CLI (`kimi`).
 * Speaks JSON-RPC 2.0 over stdio.
 */

const os = require("node:os");
const path = require("node:path");
const core = require("../shared/bridge");
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

const {
  IS_WINDOWS, clampTimeout, isNonEmptyString, isObject, resolveCli,
  runStdioLoop, sendError, sendResponse, superviseChild, timeoutSchema,
  validateCommonArgs
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_KIMI_DEPTH");
const resolveWindowsShim = (candidate, readShim) => core.resolveWindowsShim(candidate, "kimi", readShim);

const KIMI_CATALOG = modelCatalog.providers.kimi;
const DEFAULT_MODEL = KIMI_CATALOG.defaultModel;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);


// --- MCP Protocol Helpers ---







// --- Kimi CLI Wrapper ---


const activeChildren = new Set();
const activeRequests = new Map();
let KIMI_BIN;


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
  return depth.stamp(env, source);
}

async function runKimi(args, cwd, timeoutMs, abortSignal, expectedThreadId) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  // kimi has no timeout flag of its own, so the bridge deadline is the only one.
  const fullArgs = [...args, "--output-format", "stream-json"];

  return superviseChild({
    abortSignal,
    activeChildren,
    args: fullArgs,
    binary: KIMI_BIN,
    cwd,
    env: buildKimiEnv(process.env),
    label: "Kimi",
    notFoundHint: "Install Kimi Code and ensure 'kimi' is on PATH.",
    timeoutMs: effectiveTimeout,
    onClose: ({ code, stderr, stdout }) => {
      // Unlike Agy, kimi failures are exit-code shaped: an unknown model exits 1
      // with the explanation on stderr and only the version banner on stdout.
      if (code !== 0) throw new Error(stderr.trim() || `Kimi exited with code ${code}`);

      const { response, sessionId } = parseKimiOutput(stdout);
      if (!response) {
        throw new Error(stderr.trim() || `Kimi produced no assistant output. Raw output was: ${stdout}`);
      }
      if (expectedThreadId && sessionId !== "unknown" && sessionId !== expectedThreadId) {
        throw new Error(
          `Kimi resumed a different session: requested ${expectedThreadId}, received ${sessionId}. The original session was not continued.`
        );
      }
      return { response, threadId: sessionId };
    }
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
        timeout: timeoutSchema(),
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
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["threadId", "prompt"]
    }
  }
];

function cliFallbacks() {
  // The official installer targets these; an MCP server inherits a minimal PATH
  // that frequently lacks them. Provenance outranks a fallback (see
  // selectCandidate), so a guess can only add reach, never override PATH.
  const home = os.homedir();
  if (!IS_WINDOWS) return [path.join(home, ".kimi-code", "bin", "kimi")];
  return [path.join(home, ".kimi-code", "bin", "kimi.exe"), path.join(home, ".kimi-code", "bin", "kimi.cmd")];
}

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
    if ((name === "kimi" || name === "kimi-reply") && depth.exceeded()) {
      if (shouldRespond) {
        sendError(id, -32603, `Refusing to delegate: this bridge is already running inside a delegated Kimi session (${depth.envVar}=${depth.current()}). Complete the work here instead of delegating further.`);
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
    const commonError = validateCommonArgs(args);
    if (commonError) {
      if (shouldRespond) sendError(id, -32602, commonError);
      return;
    }
    if (args.model !== undefined && !isNonEmptyString(args.model)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'model' must be a non-empty string when provided");
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
  runStdioLoop({ handlers, activeRequests, activeChildren });

  // Kimi Code installs to ~/.kimi-code/bin, frequently absent from the minimal
  // PATH an MCP server inherits.
  try {
    const home = os.homedir();
    KIMI_BIN = resolveCli("kimi", {
      fallbacks: cliFallbacks()
    });
  } catch (error) {
    console.error(`Kimi CLI not found. Install Kimi Code and ensure 'kimi' is on PATH. (${error.message})`);
    process.exit(1);
  }
}

module.exports = {
  cliFallbacks,
  buildKimiEnv,
  resolveWindowsShim,
  handlers,
  parseKimiOutput,
  toolDefinitions: KIMI_TOOLS
};
