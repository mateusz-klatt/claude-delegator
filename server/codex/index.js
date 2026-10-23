#!/usr/bin/env node

/**
 * Claude Delegator - Codex MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Codex CLI's non-interactive
 * `codex exec --json` mode. Speaks JSON-RPC 2.0 over stdio.
 *
 * Codex used to ship its own MCP server, which this plugin passed through
 * unchanged. `codex mcp-server` was deprecated in 0.149.1 and removed by
 * openai/codex#42993; 0.152.1 was the last release installed here that still
 * had it. A current CLI parses the word as an interactive prompt and exits
 * with "stdin is not a terminal", which reaches Claude Code as
 * CONNECTION_CLOSED. `codex app-server` is no drop-in either: it speaks
 * Codex's own JSON-RPC protocol rather than MCP, so a registration that names
 * it hangs on the MCP handshake. Codex therefore joins the other CLIs behind
 * the shared bridge core, through `exec` — the CLI's automation surface, and
 * itself an app-server client: a failed resume reports
 * "thread/resume failed ... (code -32600)".
 */

const fs = require("node:fs");
const os = require("node:os");
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
  IS_WINDOWS, VALID_SANDBOX_VALUES, clampTimeout, homedir,
  isFullyQualifiedWindowsPath, isNonEmptyString, isObject, resolveCli,
  superviseChild, timeoutSchema
} = core;

const depth = core.createDepthGuard("CLAUDE_DELEGATOR_CODEX_DEPTH");
const resolveWindowsShim = (candidate, readShim) => core.resolveWindowsShim(candidate, "codex", readShim);

const CODEX_CATALOG = modelCatalog.providers.codex;
const DEFAULT_MODEL = CODEX_CATALOG.defaultModel;
const DEFAULT_EFFORT = CODEX_CATALOG.defaultEffort;
const EFFORT_ORDER = CODEX_CATALOG.efforts;
const VALID_EFFORT_VALUES = new Set(EFFORT_ORDER);
const MODEL_EFFORTS = new Map(CODEX_CATALOG.models.map((model) => [model.id, model.efforts]));
const OVERRIDE_ENV = "CODEX_DELEGATOR_CODEX_BIN";

// Lines the CLI writes to stderr on every healthy run. Left in, they would
// stand in front of the real reason whenever stderr is all a failure leaves.
const STDERR_NOISE = [
  /^Reading additional input from stdin\.\.\.$/,
  /^WARNING: proceeding, even though we could not update PATH:/
];

const activeChildren = new Set();
const activeRequests = new Map();
let CODEX_BIN;

// --- Codex CLI wrapper ---

function buildCodexEnv(source = process.env) {
  const env = depth.stamp(buildCalleeEnv(source), source);
  // The override names the binary for this bridge; it is not configuration
  // the delegated Codex should see.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === OVERRIDE_ENV.toLowerCase()) delete env[key];
  }
  return env;
}

/**
 * Clamp a requested effort to the levels the catalog records for the model.
 * Before 0.164.0 an unsupported level failed the whole call with HTTP 400
 * before a thread existed; 0.164.0 accepted `ultra` on gpt-6-luna, which tops
 * out at `max`. Clamping keeps either behaviour from mattering. A model the
 * catalog does not know is passed through unchanged for Codex to judge.
 */
function resolveEffort(model, requestedEffort) {
  const effort = requestedEffort || DEFAULT_EFFORT;
  const supported = MODEL_EFFORTS.get(model);
  if (!supported || supported.includes(effort)) return effort;
  for (let index = EFFORT_ORDER.indexOf(effort); index >= 0; index -= 1) {
    if (supported.includes(EFFORT_ORDER[index])) return EFFORT_ORDER[index];
  }
  return supported[0];
}

/**
 * `-c` parses its value as TOML and silently falls back to the raw text when
 * that fails, so an unencoded multi-line expert prompt would arrive with its
 * quotes and escapes intact. JSON string syntax is a TOML basic string except
 * for DEL and lone surrogates, which TOML rejects; escape the first and repair
 * the second so the value always parses.
 */
function tomlString(text) {
  return JSON.stringify(text.toWellFormed()).replaceAll("\u007f", String.raw`\u007f`);
}

/**
 * `workspace-write` keeps the contract every sibling bridge uses — the
 * provider's unattended full-tool mode — which for Codex is exactly what the
 * plugin pinned before: danger-full-access with approvals off. `read-only`
 * maps to Codex's own sandbox, which the operating system enforces rather than
 * the model. Measured on WSL with a positive control in the same directory:
 * the read-only run's `printf … > file` failed with "Read-only file system"
 * and no file appeared, while the danger-full-access control wrote its file.
 *
 * Config keys rather than `-s`, because `exec resume` has no `-s` and both
 * calls must carry the same policy. A resume honoured `sandbox_mode` as well.
 */
function sandboxArguments(sandbox) {
  const mode = sandbox === "read-only" ? "read-only" : "danger-full-access";
  return ["-c", `sandbox_mode="${mode}"`, "-c", 'approval_policy="never"'];
}

function modelArguments(args) {
  const model = args.model || DEFAULT_MODEL;
  return ["-m", model, "-c", `model_reasoning_effort="${resolveEffort(model, args.effort)}"`];
}

function parseCodexEvent(line) {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line);
    return isObject(event) ? event : null;
  } catch {
    return null; // Not JSON — ignore terminal noise.
  }
}

/**
 * Codex relays a backend rejection as the backend's own JSON, serialized into
 * the message string:
 *   {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"…"}}
 * Unwrap it so the caller reads the reason rather than an escaped object.
 */
function errorText(message) {
  if (!isNonEmptyString(message)) return "";
  const trimmed = message.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  const inner = isObject(parsed) && isObject(parsed.error) ? parsed.error : null;
  if (!inner || !isNonEmptyString(inner.message)) return trimmed;
  const detail = [parsed.status && `HTTP ${parsed.status}`, inner.type].filter(Boolean).join(" ");
  return detail ? `${inner.message} (${detail})` : inner.message;
}

/**
 * `exec --json` emits JSONL events. The ones the bridge reads:
 *   {type:"thread.started", thread_id}                 → resumable id, also on resume
 *   {type:"item.completed", item:{type:"agent_message", text}}  → one per message
 *   {type:"item.completed", item:{type:"error", message}}       → non-fatal warning
 *   {type:"turn.completed", usage}                     → success
 *   {type:"turn.failed", error:{message}}              → failure, after an `error` event
 * The last agent message here is only the fallback answer; earlier ones are
 * progress notes ("I'll run a single shell command…"). See runCodex for why
 * `--output-last-message` outranks it.
 */
function parseCodexOutput(stdout) {
  const result = {
    completed: false,
    errors: [],
    failure: "",
    message: "",
    threadId: "unknown",
    warnings: []
  };
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseCodexEvent(line);
    if (!event) continue;
    if (event.type === "thread.started" && isNonEmptyString(event.thread_id)) {
      result.threadId = event.thread_id.trim();
    } else if (event.type === "item.completed" && isObject(event.item)) {
      const { item } = event;
      if (item.type === "agent_message" && typeof item.text === "string") result.message = item.text;
      if (item.type === "error" && isNonEmptyString(item.message)) result.warnings.push(item.message.trim());
    } else if (event.type === "turn.completed") {
      result.completed = true;
    } else if (event.type === "turn.failed") {
      result.failure = errorText(event.error?.message) || "Codex reported a failed turn";
    } else if (event.type === "error" && isNonEmptyString(event.message)) {
      result.errors.push(errorText(event.message));
    }
  }
  return result;
}

function meaningfulStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !STDERR_NOISE.some((pattern) => pattern.test(line)))
    .join("\n");
}

function withWarnings(text, warnings) {
  if (warnings.length === 0) return text;
  return `${text}\n\n${warnings.map((warning) => `(Codex warning: ${warning})`).join("\n")}`;
}

function readLastMessage(outputPath) {
  try {
    return fs.readFileSync(outputPath, "utf8");
  } catch {
    return ""; // Codex writes the file only for a completed turn.
  }
}

/**
 * The answer is read from `--output-last-message`, not from the JSONL stream.
 * At turn/completed, 0.164.0 recovers the final message from the turn snapshot
 * (the last agent message, else the last plan) and writes it only to that
 * file: `reconcile_unfinished_started_items` never re-emits an agent message,
 * because `map_started_item` does not track them. A stream that missed the
 * final item would otherwise hand back a progress note as the answer. The
 * JSONL message remains the fallback for a run that wrote no file.
 *
 * A private directory rather than a bare temp name, because Codex writes the
 * path with std::fs::write, which follows a symlink planted in a shared /tmp.
 */
async function runCodex(args, cwd, timeoutMs, abortSignal, expectedThreadId) {
  const effectiveTimeout = clampTimeout(timeoutMs);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-delegator-codex-"));
  const outputPath = path.join(outputDirectory, "last-message.txt");
  const separator = args.indexOf("--");
  const fullArgs = [...args.slice(0, separator), "-o", outputPath, ...args.slice(separator)];

  try {
    return await superviseChild({
      abortSignal,
      activeChildren,
      args: fullArgs,
      binary: CODEX_BIN,
      cwd,
      env: buildCodexEnv(process.env),
      label: "Codex",
      notFoundHint: "Install the Codex CLI and ensure 'codex' is on PATH, or set CODEX_DELEGATOR_CODEX_BIN.",
      timeoutMs: effectiveTimeout,
      onClose: ({ code, stderr, stdout }) => {
        const parsed = parseCodexOutput(stdout);

        // The exit code does not carry the reason. A rejected model exits 1 with
        // the reason in a turn.failed event on stdout; an unknown resume id exits
        // 1 with no JSON at all and the reason on stderr only.
        if (parsed.failure) {
          throw new Error(withWarnings(`Codex turn failed: ${parsed.failure}`, parsed.warnings));
        }
        if (!parsed.completed || code !== 0) {
          const reason = parsed.errors.at(-1) || meaningfulStderr(stderr) ||
            (code === 0 ? "Codex exited without completing a turn" : `Codex exited with code ${code}`);
          throw new Error(withWarnings(reason, parsed.warnings));
        }
        if (expectedThreadId && parsed.threadId !== "unknown" && parsed.threadId !== expectedThreadId) {
          throw new Error(
            `Codex resumed a different session: requested ${expectedThreadId}, received ${parsed.threadId}. The original session was not continued.`
          );
        }
        const message = readLastMessage(outputPath).trim() || parsed.message.trim();
        if (!message) {
          throw new Error(withWarnings("Codex completed the turn without a final message", parsed.warnings));
        }
        return { response: withWarnings(message, parsed.warnings), threadId: parsed.threadId };
      }
    });
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true });
  }
}

// --- Tool definitions ---

const MODEL_DESCRIPTION =
  `Codex model id. Free-form: Codex validates it and an unknown id fails with HTTP 400 before any ` +
  `work happens. Catalogued for this account: ${CODEX_CATALOG.models.map((model) => model.id).join(", ")}.`;

const REPLY_MODEL_DESCRIPTION =
  `${MODEL_DESCRIPTION} A resume does NOT inherit the model — Codex falls back to its own config ` +
  `default and warns — so codex-reply always re-pins one. Repeat the start call's model when it was ` +
  `not the default.`;

const EFFORT_DESCRIPTION =
  "Reasoning effort (model_reasoning_effort). Clamped to the levels the catalog records for the " +
  "chosen model, so `ultra` on a model that stops at `max` runs at `max`.";

const SANDBOX_DESCRIPTION =
  "'read-only' maps to Codex's own sandbox_mode=read-only, which the operating system enforces: a " +
  "shell write failed with 'Read-only file system' while a danger-full-access control in the same " +
  "directory wrote its file. 'workspace-write' is the bridge's unattended full-tool mode, which for " +
  "Codex is sandbox_mode=danger-full-access with approval_policy=never. A resume inherits neither; " +
  "repeat the value.";

const CWD_DESCRIPTION =
  "Working directory and Codex workspace. A resume runs in the directory it is launched from, not " +
  "the one the session was recorded under, so repeat the start call's cwd on codex-reply.";

const CODEX_TOOLS = [
  {
    name: "codex",
    description: "Start a new Codex expert session (OpenAI GPT models via the Codex CLI)",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, description: "The delegation prompt" },
        "developer-instructions": { type: "string", description: "Expert system instructions (Codex developer_instructions)" },
        sandbox: {
          type: "string",
          enum: [...VALID_SANDBOX_VALUES],
          default: "workspace-write",
          description: SANDBOX_DESCRIPTION
        },
        cwd: { type: "string", minLength: 1, description: CWD_DESCRIPTION },
        model: { type: "string", minLength: 1, default: DEFAULT_MODEL, description: MODEL_DESCRIPTION },
        effort: { type: "string", enum: EFFORT_ORDER, default: DEFAULT_EFFORT, description: EFFORT_DESCRIPTION },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["prompt"]
    }
  },
  {
    name: "codex-reply",
    description: "Continue an existing Codex session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", minLength: 1, description: "threadId returned by a previous codex call" },
        prompt: { type: "string", minLength: 1, description: "Follow-up prompt" },
        sandbox: {
          type: "string",
          enum: [...VALID_SANDBOX_VALUES],
          default: "workspace-write",
          description: SANDBOX_DESCRIPTION
        },
        cwd: { type: "string", minLength: 1, description: CWD_DESCRIPTION },
        model: { type: "string", minLength: 1, default: DEFAULT_MODEL, description: REPLY_MODEL_DESCRIPTION },
        effort: {
          type: "string",
          enum: EFFORT_ORDER,
          default: DEFAULT_EFFORT,
          description: `${EFFORT_DESCRIPTION} A resume does not inherit it either; repeat a non-default start effort.`
        },
        timeout: timeoutSchema(),
        coordination: coordinationSchema
      },
      required: ["threadId", "prompt"]
    }
  }
];

// --- Binary resolution ---

function cliFallbacks({
  environment = process.env,
  home = homedir(),
  isWindows = IS_WINDOWS
} = {}) {
  // The standalone installer links ~/.local/bin/codex into
  // ~/.codex/packages/standalone/current; an MCP server inherits a minimal PATH
  // that frequently lacks it. Provenance outranks a fallback (see
  // selectCandidate), so a guess can only add reach, never override PATH. The
  // release directory behind the link is deliberately not a fallback: it is
  // version-stamped, and a stale pin there is how a host ends up on a CLI that
  // still has `mcp-server` but none of the current models.
  if (!isWindows) return [path.join(home, ".local", "bin", "codex")];

  const fallbacks = [];
  const localAppData = environment.LOCALAPPDATA;
  const localRoot = typeof localAppData === "string" ? localAppData.trim() : "";
  if (isFullyQualifiedWindowsPath(localRoot)) {
    // Measured native installer location. Keep the stable product path, never a
    // version-stamped package directory.
    fallbacks.push(path.win32.join(
      localRoot, "Programs", "OpenAI", "Codex", "bin", "codex.exe"
    ));
  }

  const appData = environment.APPDATA;
  const roamingRoot = typeof appData === "string" ? appData.trim() : "";
  if (isFullyQualifiedWindowsPath(roamingRoot)) {
    // npm's stable global shim. resolveCli expands it to its JS loader before
    // spawn, with shell:false.
    fallbacks.push(path.win32.join(roamingRoot, "npm", "codex.cmd"));
  }
  return fallbacks;
}

function resolveCodexBinary({
  environment = process.env,
  home = homedir(),
  isWindows = IS_WINDOWS,
  resolver = resolveCli
} = {}) {
  const explicit = environment[OVERRIDE_ENV];
  if (typeof explicit !== "string" || !explicit.trim()) {
    // The shared resolver scans PATH as data, validates POSIX X_OK, follows
    // Windows npm shims without a shell, and never executes `which`/`where`.
    return resolver("codex", {
      environment,
      fallbacks: cliFallbacks({ environment, home, isWindows })
    });
  }

  const platformPath = isWindows ? path.win32 : path;
  const configured = explicit.trim();
  const isAbsolute = isWindows
    ? isFullyQualifiedWindowsPath(configured)
    : platformPath.isAbsolute(configured);
  if (!isAbsolute) {
    throw new Error(`${OVERRIDE_ENV} must be an absolute path`);
  }
  let candidate = platformPath.normalize(configured);
  if (!fs.statSync(candidate).isFile()) throw new Error("explicit Codex path is not a file");
  if (!isWindows && !/\.(?:c?m?js)$/i.test(candidate)) {
    fs.accessSync(candidate, fs.constants.X_OK);
  }
  if (isWindows && /\.(?:cmd|bat)$/i.test(candidate)) {
    candidate = resolveWindowsShim(candidate);
  }
  return candidate;
}

// --- Request handlers ---

function buildStartArgs(args, coordination) {
  const codexArgs = [
    // Outside a trusted git repository `exec` refuses to start. The retired
    // mcp-server never asked, and the caller chose this cwd deliberately.
    "exec", "--json", "--skip-git-repo-check",
    ...modelArguments(args),
    ...sandboxArguments(args.sandbox)
  ];
  // A native channel, unlike the bridges that have to prepend the expert
  // prompt: measured, the instructions were honoured on the start call and
  // still in force on a resume that did not repeat them.
  if (args["developer-instructions"]) {
    codexArgs.push("-c", `developer_instructions=${tomlString(args["developer-instructions"])}`);
  }
  // `--` ends option parsing, so a prompt that opens with a dash stays a prompt.
  codexArgs.push("--", appendCoordinationInstructions(args.prompt, coordination));
  return codexArgs;
}

function buildReplyArgs(args, coordination, threadId) {
  // An explicit id only. `--last` resumes the most recent session for the
  // directory, which would cross-talk between concurrent delegations. The
  // model and effort are re-pinned on every reply because a resume inherits
  // neither: measured, a session started on gpt-6-luna resumed on the config
  // default, gpt-6.1-sol, with Codex's own warning as the only trace.
  return [
    "exec", "resume", "--json", "--skip-git-repo-check",
    ...modelArguments(args),
    ...sandboxArguments(args.sandbox),
    "--", threadId, appendCoordinationInstructions(args.prompt, coordination)
  ];
}

function validateCodexArgs(_name, args) {
  // A lone "-" is Codex's "read the prompt from stdin" sentinel even after
  // `--`, and the bridge's stdin is closed: measured, "No prompt provided via
  // stdin." and exit 1. Refuse it here with the real reason.
  if (args.prompt === "-") {
    return "Invalid params: 'prompt' must not be a lone '-', which Codex reads as \"take the prompt from stdin\"";
  }
  if (args.effort !== undefined && !VALID_EFFORT_VALUES.has(args.effort)) {
    return `Invalid params: 'effort' must be one of: ${EFFORT_ORDER.join(", ")}`;
  }
  if (args.model !== undefined && (!isNonEmptyString(args.model) || args.model.trim().startsWith("-"))) {
    return "Invalid params: 'model' must be a non-empty model id when provided";
  }
  return null;
}

const handlers = createProviderHandlers({
  activeRequests,
  buildReplyArgs,
  buildStartArgs,
  depth,
  displayName: "Codex",
  packageVersion: PACKAGE_VERSION,
  provider: "codex",
  run: runCodex,
  threadIdKind: "thread id",
  tools: CODEX_TOOLS,
  validateProviderArgs: validateCodexArgs,
  warning: "\n\n(Warning: no thread id returned — multi-turn reply will not be available)"
});

// --- Main loop ---

if (require.main === module) {
  startProviderRuntime({
    activeChildren,
    activeRequests,
    handlers,
    missingCliMessage: (error) => `Codex CLI not found. Install the Codex CLI and ensure 'codex' is on PATH, or set ${OVERRIDE_ENV} to its absolute path. (${error.message})`,
    resolveBinary: () => resolveCodexBinary(),
    setBinary: (binary) => { CODEX_BIN = binary; }
  });
}

module.exports = {
  buildCodexEnv,
  cliFallbacks,
  errorText,
  handlers,
  parseCodexOutput,
  resolveCodexBinary,
  resolveEffort,
  resolveWindowsShim,
  sandboxArguments,
  toolDefinitions: CODEX_TOOLS,
  tomlString
};
