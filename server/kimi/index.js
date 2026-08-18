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
  coordinationSchema
} = require("../shared/coordination");
const { buildCalleeEnv } = require("../shared/environment");
const { createProviderHandlers, startProviderRuntime } = require("../shared/provider-runtime");

const {
  IS_WINDOWS, clampTimeout, isNonEmptyString, isObject, resolveCli,
  superviseChild, timeoutSchema
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

function buildStartArgs(args, coordination) {
  let prompt = args.prompt;
  if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
  return ["-m", args.model || DEFAULT_MODEL, "-p", appendCoordinationInstructions(prompt, coordination)];
}

function buildReplyArgs(args, coordination, threadId) {
  // -S resumes an explicit id. --continue is never used: it resumes "the
  // previous session for the working directory", which would cross-talk
  // between concurrent delegations sharing a cwd.
  const kimiArgs = ["-S", threadId];
  if (args.model !== undefined) kimiArgs.push("-m", args.model);
  kimiArgs.push("-p", appendCoordinationInstructions(args.prompt, coordination));
  return kimiArgs;
}

function validateKimiArgs(_name, args) {
  // Refuse rather than accept a value that would change nothing. kimi print
  // mode rejects --plan/--yolo/--auto outright and always runs tools, so
  // honouring read-only is impossible; silently ignoring it would advertise a
  // guarantee the caller could act on.
  if (args.sandbox === "read-only") {
    return "Invalid params: 'sandbox: read-only' is not supported by Kimi. Print mode has no permission tier — it rejects --plan, --yolo and --auto, and always runs tools unattended. Use 'workspace-write' and carry a do-not-modify instruction in developer-instructions, or delegate to a provider that can enforce denial.";
  }
  if (args.model !== undefined && !isNonEmptyString(args.model)) {
    return "Invalid params: 'model' must be a non-empty string when provided";
  }
  return null;
}

const handlers = createProviderHandlers({
  activeRequests,
  buildReplyArgs,
  buildStartArgs,
  depth,
  displayName: "Kimi",
  packageVersion: PACKAGE_VERSION,
  provider: "kimi",
  run: runKimi,
  tools: KIMI_TOOLS,
  validateProviderArgs: validateKimiArgs
});

// --- Main Loop (Robust JSON-RPC stream handling) ---

if (require.main === module) {
  // Kimi Code installs to ~/.kimi-code/bin, frequently absent from the minimal
  // PATH an MCP server inherits.
  startProviderRuntime({
    activeChildren,
    activeRequests,
    handlers,
    missingCliMessage: (error) => `Kimi CLI not found. Install Kimi Code and ensure 'kimi' is on PATH. (${error.message})`,
    resolveBinary: () => resolveCli("kimi", { fallbacks: cliFallbacks() }),
    setBinary: (binary) => { KIMI_BIN = binary; }
  });
}

module.exports = {
  cliFallbacks,
  buildKimiEnv,
  resolveWindowsShim,
  handlers,
  parseKimiOutput,
  toolDefinitions: KIMI_TOOLS
};
