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
  coordinationSchema
} = require("../shared/coordination");
const { buildCalleeEnv } = require("../shared/environment");
const { createProviderHandlers, startProviderRuntime } = require("../shared/provider-runtime");

const {
  IS_WINDOWS, clampTimeout, homedir, isFullyQualifiedWindowsPath,
  isNonEmptyString, isObject, resolveCli, superviseChild, timeoutSchema
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_COPILOT_DEPTH");

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
    env: depth.stamp(buildCalleeEnv(process.env)),
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

function cliFallbacks({
  environment = process.env,
  home = homedir(),
  isWindows = IS_WINDOWS
} = {}) {
  // The official installer targets these; an MCP server inherits a minimal PATH
  // that frequently lacks them. Provenance outranks a fallback (see
  // selectCandidate), so a guess can only add reach, never override PATH.
  if (!isWindows) return [path.join(home, ".local", "bin", "copilot")];

  // Windows is covered only for an npm install. A WinGet install of this package
  // does NOT create a shim in WinGet\Links — measured on a Windows host, where
  // Links held six other tools and no copilot; the binary lives under
  // WinGet\Packages\GitHub.Copilot_Microsoft.Winget.Source_<hash>\, a path
  // carrying a package id and source hash that would be a worse guess than none.
  // So a WinGet-only install behind a stripped PATH is a known gap, stated rather
  // than papered over with a path that does not exist.
  const appData = typeof environment.APPDATA === "string" ? environment.APPDATA.trim() : "";
  return isFullyQualifiedWindowsPath(appData)
    ? [path.win32.join(appData, "npm", "copilot.cmd")]
    : [];
}

function permissionArgs(sandbox) {
  return sandbox === "read-only"
    ? ["--deny-tool=shell", "--deny-tool=write", "--deny-tool=edit"]
    : ["--allow-all-tools"];
}

function buildStartArgs(args, coordination) {
  const model = args.model || DEFAULT_MODEL;
  const copilotArgs = ["--model", model];
  if (!MODELS_WITHOUT_EFFORT.has(model)) {
    copilotArgs.push("--effort", resolveEffort(model, args.effort));
  }
  copilotArgs.push(...permissionArgs(args.sandbox));

  let prompt = args.prompt;
  if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
  copilotArgs.push("-p", appendCoordinationInstructions(prompt, coordination));
  return copilotArgs;
}

function buildReplyArgs(args, coordination, threadId) {
  const copilotArgs = ["--resume", threadId];
  // The resumed session already carries its model and effort; only forward
  // --effort when the caller explicitly asks for a change. The model is not
  // known at resume time, so max uses the conservative catalog fallback cap.
  if (args.effort !== undefined) {
    copilotArgs.push("--effort", args.effort === "max" ? FALLBACK_MAX_EFFORT : args.effort);
  }
  copilotArgs.push(...permissionArgs(args.sandbox));
  copilotArgs.push("-p", appendCoordinationInstructions(args.prompt, coordination));
  return copilotArgs;
}

function validateCopilotArgs(name, args) {
  if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
    return `Invalid params: 'effort' must be one of: ${COPILOT_CATALOG.efforts.join(", ")}`;
  }
  if (name === "copilot" && args.model !== undefined && !VALID_MODELS.has(args.model)) {
    return `Invalid params: 'model' must be one of: ${[...VALID_MODELS].join(", ")}`;
  }
  return null;
}

const handlers = createProviderHandlers({
  activeRequests,
  buildReplyArgs,
  buildStartArgs,
  depth,
  displayName: "Copilot",
  packageVersion: PACKAGE_VERSION,
  provider: "copilot",
  run: runCopilot,
  tools: COPILOT_TOOLS,
  validateProviderArgs: validateCopilotArgs,
  warning: "\n\n(Warning: no session ID returned — multi-turn reply will not be available)"
});

// --- Main Loop (Robust JSON-RPC stream handling) ---

if (require.main === module) {
  // An MCP server inherits a minimal PATH that frequently lacks ~/.local/bin,
  // which is where the official installer puts the CLI — measured on Linux,
  // macOS and WSL.
  startProviderRuntime({
    activeChildren,
    activeRequests,
    handlers,
    missingCliMessage: (error) => `Copilot CLI not found or unusable. Please install it first. (${error.message})`,
    resolveBinary: () => resolveCli("copilot", { fallbacks: cliFallbacks() }),
    setBinary: (binary) => { COPILOT_BIN = binary; }
  });
}

module.exports = {
  cliFallbacks,
  handlers,
  parseCopilotOutput,
  resolveEffort,
  resolveWindowsShim,
  toolDefinitions: COPILOT_TOOLS
};
