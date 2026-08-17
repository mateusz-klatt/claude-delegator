#!/usr/bin/env node

/**
 * Claude Delegator - Grok MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Grok CLI (`grok`).
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
  IS_WINDOWS, VALID_SANDBOX_VALUES, clampTimeout, homedir, isNonEmptyString,
  isObject, resolveCli, runStdioLoop, sendError, sendResponse, superviseChild,
  timeoutSchema, validateCommonArgs
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_GROK_DEPTH");
const resolveWindowsShim = (candidate, readShim) => core.resolveWindowsShim(candidate, "grok", readShim);

const GROK_CATALOG = modelCatalog.providers.grok;
const DEFAULT_MODEL = GROK_CATALOG.defaultModel;
const VALID_MODELS = new Set(GROK_CATALOG.models);

const activeChildren = new Set();
const activeRequests = new Map();
let GROK_BIN;

// --- Grok CLI wrapper ---

function buildGrokEnv(source = process.env) {
  return depth.stamp(buildCalleeEnv(source), source);
}

/**
 * `--output-format json` emits exactly one object, so there is none of the
 * candidate-sifting agy needs or the JSONL reassembly kimi needs. The shape:
 *   { text, stopReason, sessionId, usage, total_cost_usd, ... }
 */
function parseGrokOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Grok returned no output");

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // A diagnostic line can precede the object; take the last complete one.
    const start = trimmed.indexOf("{");
    if (start === -1) throw new Error(`Grok produced no JSON. Raw output was: ${stdout}`);
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch (error) {
      throw new Error(`Grok produced unparsable JSON (${error.message}). Raw output was: ${stdout}`);
    }
  }
  if (!isObject(data)) throw new Error(`Grok returned ${typeof data}, expected an object`);

  return {
    response: typeof data.text === "string" ? data.text.trim() : "",
    sessionId: isNonEmptyString(data.sessionId) ? data.sessionId.trim() : "unknown",
    stopReason: isNonEmptyString(data.stopReason) ? data.stopReason : ""
  };
}

// Denials must be explicit, not implied by the permission mode. Measured: a
// permissive ~/.claude/settings.local.json in the CALLER's home defeats
// --permission-mode plan on its own — the write went through with
// stopReason "end_turn". These rules override that allowlist: with them the
// model tried the file tool, then the shell, then a third path, was denied each
// time, and said so. grok reads whichever Claude Code settings file exists, so
// the bridge cannot see or control what the caller has granted; it can only
// deny loudly enough that the grant does not matter.
//
// Verified in five cases with a live positive control, under a permissive caller
// allow list (6 rules loaded, checked against a 0-rule control): bypassPermissions
// wrote the file; plan ALONE wrote it too; plan+deny refused an insistent prompt
// and also an ADVERSARIAL one claiming the mode label was a display artifact —
// the same prompt that defeated cursor-agent's --mode ask. The model attempted
// both tools and the permission layer refused them, which is the whole
// difference between a gate and a label.
//
// The rules also make the denial LEGIBLE. Without them the run ends
// stopReason "cancelled" with the answer cut off mid-action; with them it ends
// "end_turn" and the model reports each tool error verbatim. Both paths are
// live — see the cancelled branch in runGrok, which handles the first.
//
// Still ONE host. The team's reproduction was blocked all day by a shared
// free-tier limit; a subscription lifted it, but propagation lags per host, and
// a CLI that has not re-authenticated returns "no file" for every case
// INCLUDING the control — the result that looks like success.
const READ_ONLY_DENY_RULES = ["Write", "Write(*)", "Edit", "Edit(*)", "Bash", "Bash(*)"];

/**
 * Unlike agy, where read-only is a documented fiction, this mapping is enforced —
 * but only because of the deny rules above. `--permission-mode plan` alone was
 * measured twice: it cancelled a write and a shell escape under an insistent
 * prompt with the caller's own settings in place, and then failed to stop the
 * same write once the caller's settings granted Write. The mode is necessary and
 * not sufficient.
 *
 * Enforcement is never `--sandbox`. `--sandbox read-only` is accepted by the CLI
 * and did not stop a write — a flag whose name promises more than it delivers,
 * which is exactly the trap agy set for us once already.
 */
function sandboxArguments(sandbox) {
  if (sandbox !== "read-only") return ["--permission-mode", "bypassPermissions"];
  return ["--permission-mode", "plan", ...READ_ONLY_DENY_RULES.flatMap((rule) => ["--deny", rule])];
}

async function runGrok(args, cwd, timeoutMs, abortSignal, expectedThreadId) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  // grok has no deadline flag of its own, so the bridge deadline is the only one.
  const fullArgs = [...args, "--output-format", "json"];

  return superviseChild({
    abortSignal,
    activeChildren,
    args: fullArgs,
    binary: GROK_BIN,
    cwd,
    env: buildGrokEnv(process.env),
    label: "Grok",
    notFoundHint: "Install the Grok CLI and ensure 'grok' is on PATH.",
    timeoutMs: effectiveTimeout,
    onClose: ({ code, stderr, stdout }) => {
      if (code !== 0) throw new Error(stderr.trim() || `Grok exited with code ${code}`);

      const { response, sessionId, stopReason } = parseGrokOutput(stdout);

      // `cancelled` means the run was CUT SHORT, which is not the same as "a tool
      // was denied" — an earlier version of this message asserted the latter and
      // was wrong. Three hosts ran an identical denied prompt: two returned
      // `end_turn` with num_turns 2 and a complete answer that reported both tool
      // errors verbatim, one returned `cancelled` with the text stopping
      // mid-word. The denial is visible in the text either way; `cancelled`
      // tracks the model persisting past a limit, not the permission layer.
      //
      // So the throw stays — a truncated answer must not be handed back as if it
      // were a considered reply — but it now describes what is known and offers
      // the likely cause instead of asserting it.
      if (stopReason === "cancelled") {
        throw new Error(
          "Grok stopped with stopReason 'cancelled': the run was cut short and the answer below, if any, " +
          "is incomplete. Under sandbox 'read-only' this most often means the model kept retrying tools " +
          "the permission mode denies; the denials themselves are reported in the text when the run is " +
          "allowed to finish. Use 'workspace-write' if the task genuinely needs to make changes." +
          `${response ? `\nPartial response: ${response}` : ""}`
        );
      }
      if (!response) {
        throw new Error(stderr.trim() || `Grok produced no text. Raw output was: ${stdout}`);
      }
      if (expectedThreadId && sessionId !== "unknown" && sessionId !== expectedThreadId) {
        throw new Error(
          `Grok resumed a different session: requested ${expectedThreadId}, received ${sessionId}. The original session was not continued.`
        );
      }
      return { response, threadId: sessionId };
    }
  });
}

// --- Tool definitions ---

const SANDBOX_DESCRIPTION =
  "'read-only' maps to --permission-mode plan PLUS explicit --deny rules for Write, Edit and Bash. " +
  "The mode alone is not sufficient: it cancelled a write and a shell escape under an insistent " +
  "prompt, but was then defeated by a permissive allow list in the caller's own Claude Code " +
  "settings, which grok reads. The deny rules override that. 'workspace-write' uses " +
  "--permission-mode bypassPermissions. Enforcement is never --sandbox: --sandbox read-only is " +
  "accepted by the CLI and did not stop a write.";

const CWD_DESCRIPTION =
  "Working directory. Project instruction files here are auto-loaded into the session with no known " +
  "off switch — CLAUDE.md was measured loading on Linux, macOS, WSL and Windows, and a planted " +
  "AGENTS.md loaded too — so delegating into code you do not control means trusting those files, and " +
  "delegating into this repository injects its own CLAUDE.md. grok additionally reads permission " +
  "rules from the caller's Claude Code settings, but only when that file contains allow/deny/ask " +
  "entries, so the inherited permissions differ between hosts; the deny rules on 'read-only' exist " +
  "to make the outcome the same everywhere.";

const GROK_TOOLS = [
  {
    name: "grok",
    description: "Start a new Grok expert session (xAI Grok models)",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, description: "The delegation prompt" },
        "developer-instructions": { type: "string", description: "Expert system instructions" },
        sandbox: {
          type: "string",
          enum: [...VALID_SANDBOX_VALUES],
          default: "workspace-write",
          description: SANDBOX_DESCRIPTION
        },
        cwd: { type: "string", minLength: 1, description: CWD_DESCRIPTION },
        model: { type: "string", enum: [...VALID_MODELS], default: DEFAULT_MODEL },
        effort: {
          type: "string",
          minLength: 1,
          description: "Reasoning effort, passed through as --reasoning-effort. The CLI does not " +
            "enumerate its accepted values, so the bridge forwards the string and lets grok reject " +
            "an unusable one rather than inventing an allowlist it cannot verify."
        },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "grok-reply",
    description: "Continue an existing Grok session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", minLength: 1, description: "sessionId returned by a previous grok call" },
        prompt: { type: "string", minLength: 1, description: "Follow-up prompt" },
        sandbox: {
          type: "string",
          enum: [...VALID_SANDBOX_VALUES],
          default: "workspace-write",
          description: SANDBOX_DESCRIPTION
        },
        cwd: { type: "string", minLength: 1, description: CWD_DESCRIPTION },
        effort: { type: "string", minLength: 1, description: "Optional reasoning-effort override for this turn" },
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
  //
  // ~/.grok/bin is where grok installs on every platform measured, Windows
  // included — claude-mac-laptop-1 has ~/.grok/bin/grok, claude-win-home-1 has
  // ~\.grok\bin\grok.exe. It is listed first because ~/.local/bin/grok is not a
  // second install: on WSL it is a symlink *into* ~/.grok/bin, so it exists only
  // where the installer chose to add the convenience link. Listing the stable
  // location first means the fallback still works where that link was skipped.
  //
  // "Stable", not "real": ~/.grok/bin/grok is itself a symlink, to
  // ../downloads/grok-<platform>-<arch>. That last hop is deliberately NOT a
  // fallback — it carries the platform in its name, so writing it down would
  // produce a list that fits only the machine that generated it. See the
  // boundary note on the realpath diagnostic in server/shared/bridge.js.
  if (IS_WINDOWS) return [path.join(homedir(), ".grok", "bin", "grok.exe")];
  return [
    path.join(homedir(), ".grok", "bin", "grok"),
    path.join(homedir(), ".local", "bin", "grok")
  ];
}

// --- Request handlers ---

function buildStartArgs(args, coordination) {
  const grokArgs = ["-m", args.model || DEFAULT_MODEL, ...sandboxArguments(args.sandbox)];
  if (args.effort) grokArgs.push("--reasoning-effort", args.effort);

  let prompt = args.prompt;
  if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
  // --verbatim keeps the CLI from reinterpreting a prompt that begins with
  // something it would otherwise treat as its own directive.
  grokArgs.push("--verbatim", "-p", appendCoordinationInstructions(prompt, coordination));
  return grokArgs;
}

function buildReplyArgs(args, coordination, threadId) {
  // -r resumes an explicit id. --continue is never used: it resumes "the most
  // recent session for the current working directory", which would cross-talk
  // between concurrent delegations sharing a cwd.
  const grokArgs = ["-r", threadId, ...sandboxArguments(args.sandbox)];
  if (args.effort) grokArgs.push("--reasoning-effort", args.effort);
  grokArgs.push("--verbatim", "-p", appendCoordinationInstructions(args.prompt, coordination));
  return grokArgs;
}

function validateArgs(name, args) {
  const commonError = validateCommonArgs(args);
  if (commonError) return commonError;
  if (args.effort !== undefined && !isNonEmptyString(args.effort)) {
    return "Invalid params: 'effort' must be a non-empty string when provided";
  }
  if (!isNonEmptyString(args.prompt)) return "Invalid params: 'prompt' is required";

  if (name === "grok") {
    if (args.model !== undefined && !VALID_MODELS.has(args.model)) {
      return `Invalid params: 'model' must be one of ${[...VALID_MODELS].join(", ")}`;
    }
    if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
      return "Invalid params: 'developer-instructions' must be a string when provided";
    }
    return null;
  }

  if (!isNonEmptyString(args.threadId)) return "Invalid params: 'threadId' is required for grok-reply";
  const threadId = args.threadId.trim();
  if (threadId === "latest" || threadId === "unknown") {
    return "Invalid params: 'threadId' must be an explicit session id";
  }
  return null;
}

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-grok", version: PACKAGE_VERSION }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, { tools: GROK_TOOLS });
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
    if (name !== "grok" && name !== "grok-reply") {
      if (shouldRespond) sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    if (depth.exceeded()) {
      if (shouldRespond) {
        sendError(id, -32603, `Refusing to delegate: this bridge is already running inside a delegated Grok session (${depth.envVar}=${depth.current()}). Complete the work here instead of delegating further.`);
      }
      return;
    }
    if (!isObject(args)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'arguments' must be an object");
      return;
    }

    const problem = validateArgs(name, args);
    if (problem) {
      if (shouldRespond) sendError(id, -32602, problem);
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
      const expectedThreadId = name === "grok-reply" ? args.threadId.trim() : undefined;
      const grokArgs = name === "grok"
        ? buildStartArgs(args, coordination)
        : buildReplyArgs(args, coordination, expectedThreadId);

      const abortController = new AbortController();
      if (shouldRespond) activeRequests.set(id, abortController);
      let result;
      try {
        result = await runGrok(grokArgs, args.cwd, args.timeout, abortController.signal, expectedThreadId);
      } finally {
        if (shouldRespond) activeRequests.delete(id);
      }

      if (!shouldRespond) return;
      const { response, threadId } = result;
      const warning = threadId === "unknown" && name === "grok"
        ? "\n\n(Warning: no session id returned — multi-turn reply will not be available)"
        : "";

      sendResponse(id, {
        content: [{ type: "text", text: resultText(threadId, response + warning) }],
        threadId: threadId,
        ...coordinationMetadata(coordination)
      });
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

// --- Main loop ---

if (require.main === module) {
  runStdioLoop({ handlers, activeRequests, activeChildren });

  try {
    GROK_BIN = resolveCli("grok", { fallbacks: cliFallbacks() });
  } catch (error) {
    console.error(`Grok CLI not found. Install the Grok CLI and ensure 'grok' is on PATH. (${error.message})`);
    process.exit(1);
  }
}

module.exports = {
  READ_ONLY_DENY_RULES,
  buildGrokEnv,
  cliFallbacks,
  handlers,
  parseGrokOutput,
  resolveWindowsShim,
  sandboxArguments,
  toolDefinitions: GROK_TOOLS
};
