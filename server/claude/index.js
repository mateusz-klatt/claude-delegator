#!/usr/bin/env node

/**
 * Claude Delegator - Claude MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Claude Code CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

"use strict";

const path = require("node:path");
const core = require("../shared/bridge");
const { version: PACKAGE_VERSION } = require("../../package.json");
const modelCatalog = require("../../config/model-catalog.json");
const {
  appendCoordinationInstructions,
  coordinationMetadata,
  coordinationSchema,
  validateCoordination
} = require("../shared/coordination.js");
const { buildCalleeEnv } = require("../shared/environment.js");
const { resultText } = require("../shared/result.js");

const {
  IS_WINDOWS, homedir, isFullyQualifiedWindowsPath, isNonEmptyString, isObject,
  resolveCli, runStdioLoop, sendError, sendResponse, superviseChild, timeoutSchema,
  VALID_SANDBOX_VALUES, validateCommonArgs
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_CLAUDE_DEPTH");

const CLAUDE_CATALOG = modelCatalog.providers.claude;
const DEFAULT_MODEL = CLAUDE_CATALOG.defaultModel;
const DEFAULT_EFFORT = CLAUDE_CATALOG.defaultEffort;
const VALID_MODELS = new Set([
  ...CLAUDE_CATALOG.models,
  ...Object.keys(CLAUDE_CATALOG.aliases)
]);
const VALID_EFFORT_VALUES = new Set(CLAUDE_CATALOG.efforts);
// Delegation-loop guard. The bridge stamps this into every child environment, and the
// variable survives each further hop (see server/shared/environment.js), so a Claude
// session reached through this bridge cannot reach another one — directly, or via a
// round trip through Codex or any other provider that is configured to call back here.
const activeChildren = new Set();
const activeRequests = new Map();

// --- MCP Protocol Helpers ---







function validateCommonArguments(args) {
  const problem = validateCommonArgs(args);
  if (problem) throw new TypeError(problem.replace(/^Invalid params: /, ""));
  if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
    throw new TypeError("'effort' must be 'low', 'medium', 'high', 'xhigh', or 'max'");
  }
  return validateCoordination(args.coordination);
}

// --- Claude CLI Wrapper ---

class ClaudeProviderError extends Error {}



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
    } catch {
      // Ignore terminal noise and try the next complete JSON candidate.
    }
  }

  if (!data) {
    throw new Error(`no Claude result object found\nRaw output was: ${stdout}`);
  }
  if (data.is_error === true || data.subtype === "error") {
    throw new ClaudeProviderError(
      typeof data.result === "string" ? data.result : "Claude session failed"
    );
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
  return superviseChild({
    abortSignal,
    activeChildren,
    args,
    binary: CLAUDE_BIN,
    cwd,
    env: depth.stamp(buildCalleeEnv(process.env)),
    label: "Claude",
    notFoundHint: "Install Claude Code first.",
    timeoutMs,
    onClose: ({ code, stderr, stdout }) => {
      if (code !== 0) {
        try {
          // Claude can emit a structured provider error on stdout and then run
          // SessionEnd hooks whose failure is written to stderr. The structured
          // result is the cause of the failed call; hook output is only teardown
          // noise and must not mask it.
          parseClaudeOutput(stdout, fallbackThreadId);
        } catch (error) {
          if (error instanceof ClaudeProviderError) throw error;
        }
        throw new Error(stderr.trim() || `Claude exited with code ${code}`);
      }
      try {
        return parseClaudeOutput(stdout, fallbackThreadId);
      } catch (error) {
        throw new Error(`Parse error: ${error.message}`);
      }
    }
  });
}

function sandboxArguments(sandbox) {
  if (sandbox === "read-only") return ["--permission-mode", "plan"];
  return ["--dangerously-skip-permissions"];
}

// --- Tool Definitions ---

function cliFallbacks({ home = homedir(), isWindows = IS_WINDOWS } = {}) {
  // The official installer targets these; an MCP server inherits a minimal PATH
  // that frequently lacks them. Provenance outranks a fallback (see
  // selectCandidate), so a guess can only add reach, never override PATH.
  if (!isWindows) return [path.join(home, ".local", "bin", "claude")];
  const root = typeof home === "string" ? home.trim() : "";
  return isFullyQualifiedWindowsPath(root)
    ? [path.win32.join(root, ".local", "bin", "claude.exe")]
    : [];
}

const CLAUDE_TOOLS = [
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
          timeout: timeoutSchema(),
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
          timeout: timeoutSchema(),
          coordination: coordinationSchema
        },
        required: ["threadId", "prompt"]
      }
    }
  ];

// --- Request Handlers ---

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
    sendResponse(id, { tools: CLAUDE_TOOLS });
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
        depth.exceeded()) {
      if (shouldRespond) {
        sendError(id, -32603, `Refusing to delegate: this bridge is already running inside a delegated Claude session (${depth.envVar}=${depth.current()}). Complete the work here instead of delegating further.`);
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
        content: [{ type: "text", text: resultText(threadId, response + warning) }],
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

let CLAUDE_BIN;

if (require.main === module) {
  runStdioLoop({ handlers, activeRequests, activeChildren });

  try {
    // See the note in the Copilot bridge: the official installer targets
    // ~/.local/bin, and a minimal inherited PATH often does not include it.
    CLAUDE_BIN = resolveCli("claude", {
      aliases: ["@anthropic-ai"],
      fallbacks: cliFallbacks()
    });
  } catch (error) {
    console.error(`Claude CLI not found. Please install Claude Code first. (${error.message})`);
    process.exit(1);
  }
}

module.exports = {
  cliFallbacks,
  handlers,
  parseClaudeOutput,
  sandboxArguments,
  toolDefinitions: CLAUDE_TOOLS
};
