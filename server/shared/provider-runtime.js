"use strict";

const {
  isNonEmptyString,
  isObject,
  runStdioLoop,
  sendError,
  sendResponse,
  validateCommonArgs
} = require("./bridge");
const { coordinationMetadata, validateCoordination } = require("./coordination");
const { resultText } = require("./result");

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const PROTOCOL_VERSION = "2024-11-05";

function sendProtocolError(id, shouldRespond, code, message) {
  if (shouldRespond) sendError(id, code, message);
}

function callEnvelope(params, supportedTools) {
  if (!isObject(params)) return { problem: "Invalid params: expected an object" };

  const { name, arguments: args } = params;
  if (!isNonEmptyString(name)) {
    return { problem: "Invalid params: 'name' must be a non-empty string" };
  }
  if (!supportedTools.has(name)) return { problem: `Unknown tool: ${name}` };
  if (!isObject(args)) return { problem: "Invalid params: 'arguments' must be an object" };
  return { args, name };
}

function validationError(args, isStart, replyTool, threadIdKind) {
  const commonError = validateCommonArgs(args);
  if (commonError) return commonError;

  if (!isNonEmptyString(args.prompt)) return "Invalid params: 'prompt' is required";

  if (isStart) {
    if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
      return "Invalid params: 'developer-instructions' must be a string when provided";
    }
    return null;
  }

  if (!isNonEmptyString(args.threadId)) {
    return `Invalid params: 'threadId' is required for ${replyTool}`;
  }
  const threadId = args.threadId.trim();
  if (threadId === "latest" || threadId === "unknown") {
    return `Invalid params: 'threadId' must be an explicit ${threadIdKind}`;
  }
  return null;
}

function parseCoordination(args) {
  try {
    return { coordination: validateCoordination(args.coordination) };
  } catch (error) {
    return { problem: `Invalid params: ${error.message}` };
  }
}

async function executeProviderCall({
  activeRequests,
  args,
  buildReplyArgs,
  buildStartArgs,
  coordination,
  id,
  isStart,
  run,
  shouldRespond,
  warning
}) {
  try {
    const expectedThreadId = isStart ? undefined : args.threadId.trim();
    const cliArgs = isStart
      ? buildStartArgs(args, coordination)
      : buildReplyArgs(args, coordination, expectedThreadId);
    const abortController = new AbortController();
    if (shouldRespond) activeRequests.set(id, abortController);

    let result;
    try {
      result = await run(cliArgs, args.cwd, args.timeout, abortController.signal, expectedThreadId);
    } finally {
      if (shouldRespond) activeRequests.delete(id);
    }

    if (!shouldRespond) return;
    const { response, threadId } = result;
    const suffix = isStart && threadId === "unknown" ? warning : "";
    sendResponse(id, {
      content: [{ type: "text", text: resultText(threadId, response + suffix) }],
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
  }
}

/**
 * Build the protocol shell shared by every CLI-backed provider bridge.
 *
 * Provider modules retain the parts whose semantics differ: schemas, argument
 * construction, provider-specific validation and child-output parsing. Keeping
 * the JSON-RPC lifecycle here makes notification, cancellation and result
 * behaviour identical without copying the same state machine into each bridge.
 */
function createProviderHandlers({
  activeRequests,
  buildReplyArgs,
  buildStartArgs,
  depth,
  displayName,
  packageVersion,
  provider,
  run,
  threadIdKind = "session id",
  tools,
  validateProviderArgs = () => null,
  warning = "\n\n(Warning: no session id returned — multi-turn reply will not be available)"
}) {
  const startTool = provider;
  const replyTool = `${provider}-reply`;
  const supportedTools = new Set([startTool, replyTool]);

  async function callTool(id, params, shouldRespond) {
    const envelope = callEnvelope(params, supportedTools);
    if (envelope.problem) {
      sendProtocolError(id, shouldRespond, INVALID_PARAMS, envelope.problem);
      return;
    }

    const { args, name } = envelope;
    if (depth.exceeded()) {
      const message = `Refusing to delegate: this bridge is already running inside a delegated ${displayName} session (${depth.envVar}=${depth.current()}). Complete the work here instead of delegating further.`;
      sendProtocolError(id, shouldRespond, INTERNAL_ERROR, message);
      return;
    }

    const isStart = name === startTool;
    const problem = validationError(args, isStart, replyTool, threadIdKind) ||
      validateProviderArgs(name, args);
    if (problem) {
      sendProtocolError(id, shouldRespond, INVALID_PARAMS, problem);
      return;
    }

    const coordinationResult = parseCoordination(args);
    if (coordinationResult.problem) {
      sendProtocolError(id, shouldRespond, INVALID_PARAMS, coordinationResult.problem);
      return;
    }

    await executeProviderCall({
      activeRequests,
      args,
      buildReplyArgs,
      buildStartArgs,
      coordination: coordinationResult.coordination,
      id,
      isStart,
      run,
      shouldRespond,
      warning
    });
  }

  return {
    "initialize": (id, _params, shouldRespond) => {
      if (!shouldRespond) return;
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: `claude-delegator-${provider}`, version: packageVersion }
      });
    },
    "tools/list": (id, _params, shouldRespond) => {
      if (shouldRespond) sendResponse(id, { tools });
    },
    "tools/call": callTool,
    "notifications/cancelled": (_id, params) => {
      if (!isObject(params) || !Object.hasOwn(params, "requestId")) return;
      activeRequests.get(params.requestId)?.abort();
    },
    "notifications/initialized": () => {}
  };
}

function startProviderRuntime({
  activeChildren,
  activeRequests,
  handlers,
  missingCliMessage,
  resolveBinary,
  setBinary
}) {
  runStdioLoop({ handlers, activeRequests, activeChildren });
  try {
    setBinary(resolveBinary());
  } catch (error) {
    console.error(missingCliMessage(error));
    process.exit(1);
  }
}

module.exports = { createProviderHandlers, startProviderRuntime };
