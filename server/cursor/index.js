#!/usr/bin/env node

/**
 * Claude Delegator - Cursor MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Cursor Agent CLI (`cursor-agent`).
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
  IS_WINDOWS, VALID_SANDBOX_VALUES, clampTimeout, homedir, isNonEmptyString,
  isObject, resolveCli, superviseChild, timeoutSchema
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_CURSOR_DEPTH");
const resolveWindowsShim = (candidate, readShim) =>
  core.resolveWindowsShim(candidate, "cursor-agent", readShim, ["agent"]);

const CURSOR_CATALOG = modelCatalog.providers.cursor;
const DEFAULT_MODEL = CURSOR_CATALOG.defaultModel;

const activeChildren = new Set();
const activeRequests = new Map();
let CURSOR_BIN;

// --- Cursor CLI wrapper ---

function buildCursorEnv(source = process.env) {
  return depth.stamp(buildCalleeEnv(source), source);
}

/**
 * `--output-format json` emits exactly one object on a single line:
 *   { type, subtype, is_error, duration_ms, result, session_id, request_id, usage }
 *
 * Parsed BEFORE the exit code is consulted, because the exit code does not
 * classify the run. A transient backend failure was measured returning code 0
 * with a plain-text "Connection lost, reconnecting to ..." and no JSON at all,
 * while a rejected model returns code 1, also without JSON. Trusting the code
 * would report the first as success with an empty answer. This is the same
 * shape agy set (decision 11): parse stdout first, use the code only to pick a
 * message.
 */
function parseCursorOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  // Scan whole LINES, last first, rather than slicing from the first "{" to the
  // end. cursor-agent prints its result object on one line, and prints bare
  // non-JSON status lines too — "Connection lost, reconnecting to ... (attempt
  // 1)" was measured as one. Slicing from the first brace survived a line
  // BEFORE the result and broke on anything after it, turning a completed run
  // into a reported failure and discarding the session_id with it, so the caller
  // could not even resume. A line scan handles noise on either side.
  //
  // This is deliberately not shared with the grok bridge, whose --output-format
  // json is PRETTY-PRINTED across many lines: a line scan would find no
  // parseable line there at all. Same-looking problem, opposite correct answer.
  let data;
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      // Cursor may print other structured events after the final answer. Only
      // the result record belongs to this tool call; accepting a trailing hook
      // or system record could return unrelated text with a plausible-looking
      // session id.
      if (isObject(parsed) && parsed.type === "result") {
        data = parsed;
        break;
      }
    } catch {
      // Not this line; keep scanning outward.
    }
  }
  if (!isObject(data)) return null;

  return {
    isError: data.is_error === true,
    response: typeof data.result === "string" ? data.result.trim() : "",
    sessionId: isNonEmptyString(data.session_id) ? data.session_id.trim() : "unknown",
    subtype: isNonEmptyString(data.subtype) ? data.subtype : ""
  };
}

/**
 * Neither value is a sandbox, and only one of them restricts anything.
 *
 * `--mode ask` is Cursor's read-only conversational mode. Measured: it refused
 * an insistent write-or-shell prompt twice, including under a permissive allow
 * list — but it was then DEFEATED by a prompt asserting the mode label was a
 * display artefact and demanding real tool calls. Both files appeared, and the
 * model's own report said "the Ask mode label did not block either call". So it
 * deflects, it does not deny. That is agy's category, not grok's: the value is
 * kept because it is strictly more restrictive than the alternative, and it is
 * documented for exactly what it is.
 *
 * `--mode plan` is NOT used even though its help text promises "no edits": with
 * workspace trust granted it wrote the file on the first insistent prompt. The
 * flag whose name outruns its behaviour, for the third provider running.
 *
 * `--sandbox enabled` is never emitted either. It is accepted, and it did not
 * stop a write inside the workspace; Cursor's real sandbox profiles live in
 * ~/.cursor/cli-config.json and sandbox-policies/, which are operator
 * configuration the bridge does not write. There is no --deny equivalent on the
 * command line, which is why read-only cannot be made to enforce here the way
 * it is on grok.
 */
function sandboxArguments(sandbox) {
  return sandbox === "read-only" ? ["--mode", "ask"] : ["--force"];
}

/**
 * Workspace trust is mandatory, not defensive.
 *
 * Without it a headless run prints "Workspace Trust Required" and exits 0 having
 * executed nothing — which looks exactly like a permission mode successfully
 * denying the task. That false negative cost a measurement here already: a
 * plan-mode test read as "enforced" when in fact the model had never run, and
 * the positive control passed only because --force happens to grant trust as a
 * side effect, so control and test differed by two variables instead of one.
 *
 * Passing it explicitly on both branches keeps the sandbox value the only thing
 * that varies between them.
 */
const TRUST_ARGS = ["--trust"];

async function runCursor(args, cwd, timeoutMs, abortSignal, expectedThreadId) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  const fullArgs = [...args, "--output-format", "json"];

  return superviseChild({
    abortSignal,
    activeChildren,
    args: fullArgs,
    binary: CURSOR_BIN,
    cwd,
    env: buildCursorEnv(process.env),
    label: "Cursor",
    notFoundHint: "Install the Cursor Agent CLI and ensure 'cursor-agent' is on PATH.",
    timeoutMs: effectiveTimeout,
    onClose: ({ code, stderr, stdout }) => {
      const parsed = parseCursorOutput(stdout);

      // No JSON at all: the CLI failed before producing a result. Both observed
      // shapes land here — the model rejection (code 1) and the transient
      // connection error (code 0) — so the message comes from the output, and
      // the code only fills in when the output is empty.
      if (!parsed) {
        const detail = stdout.trim() || stderr.trim();
        throw new Error(detail || `Cursor exited with code ${code} and produced no output`);
      }
      if (parsed.isError) {
        throw new Error(
          parsed.response || parsed.subtype || `Cursor reported an error (exit code ${code})`
        );
      }
      if (!parsed.response) {
        throw new Error(stderr.trim() || `Cursor produced no text. Raw output was: ${stdout}`);
      }
      if (expectedThreadId && parsed.sessionId === "unknown") {
        throw new Error(
          `Cursor reply for session ${expectedThreadId} returned no session_id. Continuity could not be verified.`
        );
      }
      if (expectedThreadId && parsed.sessionId !== expectedThreadId) {
        throw new Error(
          `Cursor resumed a different session: requested ${expectedThreadId}, received ${parsed.sessionId}. The original session was not continued.`
        );
      }
      return { response: parsed.response, threadId: parsed.sessionId };
    }
  });
}

// --- Tool definitions ---

const SANDBOX_DESCRIPTION =
  "'workspace-write' uses --force (all tools, unattended). 'read-only' uses --mode ask, which " +
  "DEFLECTS rather than denies: it refused an insistent write-or-shell prompt, including under a " +
  "permissive allow list, but was defeated by a prompt asserting the mode label was a display " +
  "artefact and demanding real tool calls. Treat it as advisory, and carry do-not-modify intent in " +
  "developer-instructions as well. --mode plan is never used (it wrote the file once trust was " +
  "granted) and --sandbox is never emitted (accepted, but did not stop a workspace write). " +
  "cursor-agent has no command-line deny rules, so read-only cannot be made to enforce here the way " +
  "it does on grok; route to grok or Claude when the caller needs provider-enforced denial.";

const MODEL_DESCRIPTION =
  "Free-form, because the CLI documents bracket-parameterised overrides such as " +
  "'claude-opus-4-8[context=1m,effort=high,fast=false]' that no enum can express. `cursor-agent " +
  "models` listed 204 ids on the verification account, but only 'auto' and the Composer family " +
  "actually ran: every named third-party model failed with 'Named models unavailable. Free plans can " +
  "only use Auto.' Note that 'auto' is server-routed and not stable — it resolved to " +
  "cursor-grok-4.6-high-fast on one turn and cursor-grok-4.6-high on the next turn of one session, " +
  "so the restriction is on choosing a model, not on using one. Pick a Composer id when a run must " +
  "be reproducible.";

const CWD_DESCRIPTION =
  "Working directory, which also becomes the workspace. --add-dir is never passed: it adds workspace " +
  "roots and widens rules discovery, and cwd alone already grants file access — the same reasoning as " +
  "the Agy bridge.";

const REPLY_CWD_DESCRIPTION =
  CWD_DESCRIPTION + " Pass the same cwd used by the start call: Cursor stores sessions per workspace. " +
  "Omitting cwd is retained for compatibility and only works when the bridge process already runs in " +
  "that same workspace.";

const CURSOR_TOOLS = [
  {
    name: "cursor",
    description: "Start a new Cursor expert session (Cursor Agent CLI)",
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
        model: { type: "string", minLength: 1, default: DEFAULT_MODEL, description: MODEL_DESCRIPTION },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "cursor-reply",
    description: "Continue an existing Cursor session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", minLength: 1, description: "session_id returned by a previous cursor call" },
        prompt: { type: "string", minLength: 1, description: "Follow-up prompt" },
        sandbox: {
          type: "string",
          enum: [...VALID_SANDBOX_VALUES],
          default: "workspace-write",
          description: SANDBOX_DESCRIPTION
        },
        cwd: { type: "string", minLength: 1, description: REPLY_CWD_DESCRIPTION },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["threadId", "prompt"]
    }
  }
];

function cliFallbacks() {
  // POSIX: the ~/.local/bin launcher and nothing below it. That path is a symlink
  // into ~/.local/share/cursor-agent/versions/<version>/, and the version is in
  // the directory name — writing it down would produce a list correct only on the
  // machine that generated it and only until Cursor next updates. That is the
  // WinGet\Packages guess removed in 1.7.0, wearing a different hat.
  //
  // Windows: deliberately empty. cursor-agent installs there as a .cmd that
  // shells to a sibling .ps1, but no host on this team has measured WHERE, and a
  // guess is precisely the mistake above. PATH still resolves it wherever the
  // installer put itself; an empty list costs reach only under a stripped PATH,
  // whereas a wrong entry would cost correctness everywhere. Fill this in once
  // someone reports the real location.
  if (IS_WINDOWS) return [];
  return [path.join(homedir(), ".local", "bin", "cursor-agent")];
}

// --- Request handlers ---

function buildStartArgs(args, coordination) {
  const cursorArgs = [
    "--model", args.model || DEFAULT_MODEL,
    ...TRUST_ARGS,
    ...sandboxArguments(args.sandbox)
  ];

  let prompt = args.prompt;
  if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
  cursorArgs.push("-p", appendCoordinationInstructions(prompt, coordination));
  return cursorArgs;
}

function buildReplyArgs(args, coordination, threadId) {
  // --resume takes an explicit chat id. --continue is never used: it resumes the
  // previous session for the working directory, which would cross-talk between
  // concurrent delegations sharing a cwd — the same trap documented on kimi.
  //
  // No --model. Measured: a resume inherits the model the session started with,
  // rather than falling back to the user's configured default. That is the
  // opposite of agy, where the reply tool must re-pin it, so the deviation is
  // asserted in this bridge's own tests rather than in the shared core.
  const cursorArgs = ["--resume", threadId, ...TRUST_ARGS, ...sandboxArguments(args.sandbox)];
  cursorArgs.push("-p", appendCoordinationInstructions(args.prompt, coordination));
  return cursorArgs;
}

function validateCursorArgs(name, args) {
  if (name === "cursor" && args.model !== undefined && !isNonEmptyString(args.model)) {
    return "Invalid params: 'model' must be a non-empty string when provided";
  }
  return null;
}

const handlers = createProviderHandlers({
  activeRequests,
  buildReplyArgs,
  buildStartArgs,
  depth,
  displayName: "Cursor",
  packageVersion: PACKAGE_VERSION,
  provider: "cursor",
  run: runCursor,
  tools: CURSOR_TOOLS,
  validateProviderArgs: validateCursorArgs
});

// --- Main loop ---

if (require.main === module) {
  startProviderRuntime({
    activeChildren,
    activeRequests,
    handlers,
    resolveBinary: () => resolveCli("cursor-agent", { fallbacks: cliFallbacks(), aliases: ["agent"] }),
    setBinary: (binary) => { CURSOR_BIN = binary; },
    // The message names the CLI, but on macOS the cause can be a locked login
    // keychain instead: cursor-agent --version touches it, and resolveCli runs
    // exactly that to validate the binary at startup. A locked keychain makes
    // the validation throw, so the bridge exits before serving and the MCP
    // client sees CONNECTION_CLOSED — the same false-negative shape as a missing
    // --trust. Name the second cause so it is not debugged as the first.
    missingCliMessage: (error) =>
      `Cursor Agent CLI not found. Install it and ensure 'cursor-agent' is on PATH. (${error.message})` +
      " On macOS a locked login keychain produces this same message: cursor-agent --version touches the keychain and the bridge runs that to validate the CLI at startup — unlock the login keychain and retry."
  });
}

module.exports = {
  TRUST_ARGS,
  buildCursorEnv,
  cliFallbacks,
  handlers,
  parseCursorOutput,
  resolveWindowsShim,
  sandboxArguments,
  toolDefinitions: CURSOR_TOOLS
};
