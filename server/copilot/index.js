#!/usr/bin/env node

/**
 * Claude Delegator - Copilot MCP Bridge
 *
 * A zero-dependency MCP server that wraps the GitHub Copilot CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

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
  IS_WINDOWS, clampTimeout, homedir, isNonEmptyString, isObject, resolveCli,
  runStdioLoop, sendError, sendResponse, superviseChild, timeoutSchema,
  validateCommonArgs
} = core;

const resolveWindowsShim = (candidate, readShim) => core.resolveWindowsShim(candidate, "copilot", readShim);

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






// Copilot --output-format json emits JSONL events. Key events:
//   {type:"assistant.message", data:{content:"..."}}     → response text (may repeat)
//   {type:"result", sessionId:"uuid", exitCode:0}        → session id at top level
//   {type:"session.error", data:{message, errorCode, statusCode}} → provider failure
// The error event lands on STDOUT while stderr stays empty, so both the success
// and the failure branch have to read this.
function parseCopilotOutput(stdout) {
  const chunks = [];
  let sessionId = "unknown";
  let resultExitCode = 0;
  let errorMessage = "";

  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // Not JSON — ignore terminal noise.
    }
    if (!isObject(event)) continue;

    if (event.type === "assistant.message" && event.data?.content) {
      chunks.push(event.data.content);
    }
    if (event.type === "result") {
      if (event.sessionId) sessionId = event.sessionId;
      if (event.exitCode !== undefined) resultExitCode = event.exitCode;
    }
    if (event.type === "session.error" && isObject(event.data) && !errorMessage) {
      const { message, errorCode, statusCode } = event.data;
      const detail = [errorCode, statusCode].filter(Boolean).join(" ");
      errorMessage = [message || "Copilot session error", detail && `(${detail})`]
        .filter(Boolean)
        .join(" ");
    }
  }

  return { chunks, sessionId, resultExitCode, errorMessage };
}


// --- Copilot CLI Wrapper ---


const activeChildren = new Set();
const activeRequests = new Map();
let COPILOT_BIN;


async function runCopilot(args, cwd, timeoutMs, abortSignal) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  // Always force JSON output, non-interactive mode (no stdin approval prompts)
  const fullArgs = [...args, "--output-format", "json", "--silent", "--no-ask-user", "--no-custom-instructions"];

  return superviseChild({
    abortSignal,
    activeChildren,
    args: fullArgs,
    binary: COPILOT_BIN,
    cwd,
    env: buildCalleeEnv(process.env),
    label: "Copilot",
    notFoundHint: "Install with 'npm install -g @github/copilot'.",
    timeoutMs: effectiveTimeout,
    onClose: ({ code, stderr, stdout }) => {
      const parsed = parseCopilotOutput(stdout);

      if (code !== 0) {
        // Copilot reports provider-side failures as a session.error event on
        // STDOUT and leaves stderr empty — measured at zero bytes on macOS and
        // Linux for a 402 quota_exceeded. Falling straight back to the exit code
        // discarded a fully machine-readable reason and made every failure look
        // identical, so read stdout before giving up on it.
        throw new Error(parsed.errorMessage || stderr.trim() || `Copilot exited with code ${code}`);
      }

      const { chunks, sessionId, resultExitCode } = parsed;
      if (resultExitCode !== 0) {
        throw new Error(parsed.errorMessage || `Copilot session failed with exitCode ${resultExitCode}`);
      }

      return { response: (chunks.join("") || "(No output)").trim(), threadId: sessionId };
    }
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
        timeout: timeoutSchema(),
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
  if (!IS_WINDOWS) return [path.join(homedir(), ".local", "bin", "copilot")];
  return [
    ...(process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "copilot.exe")]
      : []),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "copilot.cmd")] : [])
  ];
}

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
    const commonError = validateCommonArgs(args);
    if (commonError) {
      if (shouldRespond) sendError(id, -32602, commonError);
      return;
    }
    if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
      if (shouldRespond) sendError(id, -32602, `Invalid params: 'effort' must be one of: ${COPILOT_CATALOG.efforts.join(", ")}`);
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
  runStdioLoop({ handlers, activeRequests, activeChildren });

  try {
    // An MCP server inherits a minimal PATH that frequently lacks ~/.local/bin,
    // which is where the official installer puts the CLI — measured on Linux,
    // macOS and WSL. agy and kimi already guard against that; copilot and claude
    // did not, purely by omission.
    COPILOT_BIN = resolveCli("copilot", {
      fallbacks: cliFallbacks()
    });
  } catch (error) {
    console.error(`Copilot CLI not found or unusable. Please install it first. (${error.message})`);
    process.exit(1);
  }
}

module.exports = {
  cliFallbacks,
  handlers,
  parseCopilotOutput,
  resolveEffort,
  resolveWindowsShim,
  toolDefinitions: COPILOT_TOOLS
};
