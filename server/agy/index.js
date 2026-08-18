#!/usr/bin/env node

/**
 * Claude Delegator - Agy MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Google Antigravity CLI (`agy`).
 * Speaks JSON-RPC 2.0 over stdio.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
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
  IS_WINDOWS, clampTimeout, isFullyQualifiedWindowsPath, isNonEmptyString,
  isObject, resolveCli, superviseChild, timeoutSchema
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_AGY_DEPTH");

// Keep the two-argument shape the suite drives; the core takes the provider
// name so one implementation serves every bridge.
const resolveWindowsShim = (candidate, readShim) => core.resolveWindowsShim(candidate, "agy", readShim);

const AGY_CATALOG = modelCatalog.providers.agy;
const DEFAULT_MODEL = AGY_CATALOG.defaultModel;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);
const VALID_MODELS = new Set(AGY_CATALOG.models);


// --- MCP Protocol Helpers ---







// --- Agy CLI Wrapper ---


// agy's own --print-timeout bounds only the post-send wait, not process startup
// (auth plus in-process language-server boot measured at 2.9-4.5s). Leave the
// child a startup budget so our outer hard-kill stays the authoritative deadline
// and agy reports its own timeout first, which keeps the conversation resumable.
const STARTUP_BUDGET_MS = 30_000;
const MIN_PRINT_TIMEOUT_MS = 5_000;

const activeChildren = new Set();
const activeRequests = new Map();
let AGY_BIN;
let logSequence = 0;

function printTimeoutFor(effectiveTimeout) {
  return Math.max(effectiveTimeout - STARTUP_BUDGET_MS, MIN_PRINT_TIMEOUT_MS);
}

function nextLogPath() {
  logSequence += 1;
  // agy rewrites a shared ~/.gemini/antigravity-cli/cli.log symlink and names
  // its default log with per-second granularity, so two concurrent delegations
  // in the same second collide. An explicit per-invocation path removes the race.
  return path.join(os.tmpdir(), `claude-delegator-agy-${process.pid}-${logSequence}.log`);
}

function readLogTail(logPath, bytes = 4096) {
  try {
    const contents = fs.readFileSync(logPath, "utf8");
    return contents.length > bytes ? contents.slice(-bytes) : contents;
  } catch {
    return "";
  }
}


function sandboxArguments(sandbox) {
  // agy has no provider-enforced read-only tier in headless print mode.
  // --mode plan is delivered as a slash-command expansion and is inert under the
  // --disable-slash-commands this bridge must always pass; with slash commands
  // enabled it is still only a behavioural nudge, verified letting a write
  // through under an insistent prompt. Omitting --dangerously-skip-permissions
  // soft-denies run_command and nothing else: write_to_file, read_url_content
  // and search_web all remain available. read-only is therefore strictly more
  // restrictive than the default and nothing more. Advisory intent must travel
  // in developer-instructions, as it already does for every provider.
  return sandbox === "read-only" ? [] : ["--dangerously-skip-permissions"];
}

function parseAgyOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("No JSON response found");

  // Try the whole payload first, then
  // each line newest-first. A greedy brace match would span from the first '{'
  // of any diagnostic line to the last '}' of the payload and backtracks
  // quadratically on large noisy output.
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed) && (
        Object.hasOwn(parsed, "conversation_id") ||
        Object.hasOwn(parsed, "response")
      )) {
        return parsed;
      }
    } catch {
      // Ignore terminal noise and try the next complete JSON candidate.
    }
  }

  throw new Error("No JSON response found");
}


function buildAgyEnv(source = process.env) {
  const env = buildCalleeEnv(source);
  return depth.stamp(env, source);
}

async function runAgy(args, cwd, timeoutMs, abortSignal, expectedThreadId) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  const logPath = nextLogPath();
  // Forced flags lead so the caller-supplied prompt stays the final token.
  // --disable-slash-commands is mandatory, not cosmetic: without it a prompt
  // whose first token is /settings is handled locally and returns the whole
  // config, and a repo-supplied skill can register its own slash command.
  const fullArgs = [
    "--output-format", "json",
    "--disable-slash-commands",
    "--print-timeout", `${printTimeoutFor(effectiveTimeout)}ms`,
    "--log-file", logPath,
    ...args
  ];

  return superviseChild({
    abortSignal,
    activeChildren,
    args: fullArgs,
    binary: AGY_BIN,
    cwd,
    env: buildAgyEnv(process.env),
    label: "Agy",
    notFoundHint: "Install the Antigravity CLI and ensure 'agy' is on PATH.",
    timeoutMs: effectiveTimeout,
    onTimeout: (seconds) => {
      const tail = readLogTail(logPath);
      return `Agy CLI timed out after ${seconds}s. Diagnostics: ${logPath}` + (tail ? `\n${tail}` : "");
    },
    onClose: ({ code, stderr, stdout }) => {
      // Exit code alone does not classify an agy run. A rejected --model exits 1
      // with well-formed JSON carrying status ERROR; a soft-denied tool exits 0
      // with status SUCCESS and an empty response. Parse stdout first and let the
      // exit code only pick the fallback message.
      let parsed = null;
      let parseError = null;
      try {
        parsed = parseAgyOutput(stdout);
      } catch (e) {
        parseError = e;
      }

      const diagnostics = () => {
        const tail = readLogTail(logPath);
        return `${stderr.trim() ? `\n${stderr.trim()}` : ""}\nDiagnostics: ${logPath}${tail ? `\n${tail}` : ""}`;
      };

      if (!parsed) {
        throw new Error(`Agy produced no parsable JSON (exit ${code}): ${parseError.message}${diagnostics()}`);
      }

      const threadId = isNonEmptyString(parsed.conversation_id) ? parsed.conversation_id.trim() : "";
      // A print-timeout persists the conversation and returns its id, so the run
      // is resumable. The house error result carries no threadId field, so the
      // recovery path rides in the message text instead of changing the shape.
      const resumable = threadId ? ` (resumable threadId: ${threadId})` : "";

      if (parsed.status && parsed.status !== "SUCCESS") {
        throw new Error(`Agy ${parsed.status}: ${parsed.error || stderr.trim() || `exit ${code}`}${resumable}${diagnostics()}`);
      }
      if (code !== 0) {
        throw new Error(`Agy exited with code ${code}: ${parsed.error || stderr.trim() || "no error text"}${resumable}${diagnostics()}`);
      }

      const response = typeof parsed.response === "string" ? parsed.response.trim() : "";
      if (!response) {
        // status SUCCESS with an empty response means a tool required a
        // permission headless mode cannot prompt for and was auto-denied. agy
        // explains which one on stderr; no work happened.
        throw new Error(`Agy completed without output — a tool was auto-denied and no work was performed.${resumable}${diagnostics()}`);
      }

      if (expectedThreadId && threadId && threadId !== expectedThreadId) {
        // An unknown --conversation id does not fail: agy warns and silently
        // starts a different conversation. Fail loudly rather than hand back a
        // context-free session the caller believes is a continuation.
        throw new Error(
          `Agy resumed a different conversation: requested ${expectedThreadId}, received ${threadId}. The original session was not continued.${diagnostics()}`
        );
      }

      try { fs.unlinkSync(logPath); } catch { /* best effort */ }

      return { response, threadId: threadId || "unknown" };
    }
  });
}

// --- Request Handlers ---

const SANDBOX_DESCRIPTION =
  "workspace-write auto-approves every tool for unattended execution. " +
  "read-only ONLY soft-denies shell commands — file writes, web search and URL fetches remain available, " +
  "so it is not a provider-enforced read-only guarantee. Carry advisory intent in developer-instructions.";

const AGY_TOOLS = [
  {
    name: "agy",
    description: "Start a new Agy (Google Antigravity) expert session — Gemini, Claude and GPT-OSS models",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "The delegation prompt" },
        "developer-instructions": { type: "string", description: "Expert system instructions" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: SANDBOX_DESCRIPTION },
        cwd: { type: "string", description: "Working directory; it becomes the session workspace. State the absolute path in the prompt too — relative phrasing makes agy wander outside it." },
        model: { type: "string", enum: AGY_CATALOG.models, default: DEFAULT_MODEL, description: "Model to use. Most ids bake in the reasoning tier (-low/-medium/-high), which is why this bridge exposes no separate effort parameter." },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "agy-reply",
    description: "Continue an existing Agy session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "conversation_id returned by a previous agy call" },
        prompt: { type: "string", description: "Follow-up prompt" },
        sandbox: { type: "string", enum: [...VALID_SANDBOX_VALUES], default: "workspace-write", description: SANDBOX_DESCRIPTION },
        cwd: { type: "string", description: "Working directory; a resumed conversation does not inherit its original workspace, so pass the same cwd the start call used." },
        model: { type: "string", enum: AGY_CATALOG.models, description: "REQUIRED. Unlike the sibling bridges, a resumed agy conversation does not inherit its model — omitting it silently falls back to the user's settings.json default. Echo back the model the start call used." },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["threadId", "prompt", "model"]
    }
  }
];

function cliFallbacks({
  environment = process.env,
  home = os.homedir(),
  isWindows = IS_WINDOWS
} = {}) {
  // The official installer targets these; an MCP server inherits a minimal PATH
  // that frequently lacks them. Provenance outranks a fallback (see
  // selectCandidate), so a guess can only add reach, never override PATH.
  if (!isWindows) return [path.join(home, ".local", "bin", "agy")];
  const localAppData = typeof environment.LOCALAPPDATA === "string"
    ? environment.LOCALAPPDATA.trim()
    : "";
  return isFullyQualifiedWindowsPath(localAppData)
    ? [path.win32.join(localAppData, "agy", "bin", "agy.exe")]
    : [];
}

function buildStartArgs(args, coordination) {
  let prompt = args.prompt;
  if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
  return [
    "--model", args.model || DEFAULT_MODEL,
    ...sandboxArguments(args.sandbox),
    "-p", appendCoordinationInstructions(prompt, coordination)
  ];
}

function buildReplyArgs(args, coordination, threadId) {
  return [
    "--conversation", threadId,
    "--model", args.model,
    ...sandboxArguments(args.sandbox),
    "-p", appendCoordinationInstructions(args.prompt, coordination)
  ];
}

function validateAgyArgs(name, args) {
  if (args.model !== undefined && !VALID_MODELS.has(args.model)) {
    return `Invalid params: 'model' must be one of: ${[...VALID_MODELS].join(", ")}`;
  }
  if (name === "agy-reply" && !isNonEmptyString(args.model)) {
    return "Invalid params: 'model' is required for agy-reply because a resumed conversation does not inherit its model — pass the model the start call used";
  }
  return null;
}

const handlers = createProviderHandlers({
  activeRequests,
  buildReplyArgs,
  buildStartArgs,
  depth,
  displayName: "Agy",
  packageVersion: PACKAGE_VERSION,
  provider: "agy",
  run: runAgy,
  threadIdKind: "conversation id",
  tools: AGY_TOOLS,
  validateProviderArgs: validateAgyArgs,
  warning: "\n\n(Warning: no conversation id returned — multi-turn reply will not be available)"
});

// --- Main Loop (Robust JSON-RPC stream handling) ---

if (require.main === module) {
  // agy ships as a native executable rather than an npm package, and its usual
  // home is frequently absent from the minimal PATH an MCP server inherits.
  startProviderRuntime({
    activeChildren,
    activeRequests,
    handlers,
    missingCliMessage: (error) => `Agy CLI not found. Install the Google Antigravity CLI and ensure 'agy' is on PATH. (${error.message})`,
    resolveBinary: () => resolveCli("agy", { fallbacks: cliFallbacks() }),
    setBinary: (binary) => { AGY_BIN = binary; }
  });
}

module.exports = {
  buildAgyEnv,
  cliFallbacks,
  resolveWindowsShim,
  handlers,
  parseAgyOutput,
  printTimeoutFor,
  sandboxArguments,
  toolDefinitions: AGY_TOOLS
};
