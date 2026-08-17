"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const bridge = require("./index.js");

const SERVER_PATH = path.join(__dirname, "index.js");
const temporaryDirectories = [];
const runningServers = new Set();

afterEach(() => {
  for (const server of runningServers) {
    server.kill();
  }
  runningServers.clear();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

// On Windows process.env carries `Path`, so a plain spread plus `PATH:` leaves the
// object holding two keys that differ only in case. Node happens to keep the one
// that sorts first — "PATH" < "Path" — so the restricted value does win today, but
// nothing in this suite should depend on a sort order inside a Node internal.
function withPath(source, value) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^path$/i.test(key)));
  env.PATH = value;
  return env;
}

function createAgyStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const workspacePath = path.join(directory, "workspace");
  const scriptPath = path.join(directory, "agy-stub.js");
  fs.mkdirSync(workspacePath);

  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.1.13\\n");
  process.exit(0);
}
const promptIndex = args.indexOf("-p");
const prompt = promptIndex === -1 ? "" : args[promptIndex + 1];
const conversationIndex = args.indexOf("--conversation");
const requestedConversation = conversationIndex === -1 ? null : args[conversationIndex + 1];
const logIndex = args.indexOf("--log-file");
const logPath = logIndex === -1 ? null : args[logIndex + 1];
const permissive = args.includes("--dangerously-skip-permissions") ? "dsp" : "plain";

fs.appendFileSync(process.env.AGY_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  cwd: process.cwd(),
  hasAgentName: Object.prototype.hasOwnProperty.call(process.env, "AGENT_NAME"),
  hasClaudeCode: Object.prototype.hasOwnProperty.call(process.env, "CLAUDECODE"),
  hasAgentMailAgent: Object.prototype.hasOwnProperty.call(process.env, "AGENT_MAIL_AGENT"),
  hasAgentMailToken: Object.prototype.hasOwnProperty.call(process.env, "AGENT_MAIL_REGISTRATION_TOKEN"),
  hasMcpAgentMailToken: Object.prototype.hasOwnProperty.call(process.env, "MCP_AGENT_MAIL_TOKEN"),
  hasHttpBearerToken: Object.prototype.hasOwnProperty.call(process.env, "HTTP_BEARER_TOKEN"),
  hasIntegrationBearerToken: Object.prototype.hasOwnProperty.call(process.env, "INTEGRATION_BEARER_TOKEN"),
  preservedValue: process.env.PRESERVED_VALUE,
  delegationDepth: process.env.CLAUDE_DELEGATOR_AGY_DEPTH
}) + "\\n");

if (prompt.includes("TIMEOUT_FOREVER")) {
  setInterval(() => {}, 1_000);
  return;
}
if (prompt.includes("CLI_FAILURE")) {
  process.stderr.write("Agy stub failed intentionally\\n");
  process.exit(2);
}
if (prompt.includes("BROKEN_JSON")) {
  process.stdout.write("Agy diagnostic without a structured result\\n");
  process.exit(0);
}
if (prompt.includes("NOISY_JSON")) {
  process.stdout.write("warning: telemetry cache {unavailable}\\n");
  process.stdout.write(JSON.stringify({
    conversation_id: "conversation-noisy",
    status: "SUCCESS",
    response: "parsed past the noise"
  }) + "\\n");
  process.exit(0);
}
if (prompt.includes("AUTO_DENIED")) {
  // Real agy shape: exit 0, SUCCESS, empty response, explanation on stderr.
  process.stderr.write("jetski: no output produced — a tool required the \\"command\\" permission\\n");
  process.stdout.write(JSON.stringify({
    conversation_id: "conversation-denied",
    status: "SUCCESS",
    response: ""
  }) + "\\n");
  process.exit(0);
}
if (prompt.includes("PREFLIGHT_ERROR")) {
  // Real agy shape: exit 1, valid JSON, status ERROR, empty conversation id.
  if (logPath) fs.writeFileSync(logPath, "stub log: model rejected\\n");
  process.stdout.write(JSON.stringify({
    conversation_id: "",
    status: "ERROR",
    response: "",
    error: "invalid model selection"
  }) + "\\n");
  process.exit(1);
}
if (prompt.includes("PRINT_TIMEOUT")) {
  // Real agy shape: exit 1, but the conversation persisted and is resumable.
  process.stdout.write(JSON.stringify({
    conversation_id: "conversation-resumable",
    status: "ERROR",
    response: "",
    error: "timeout waiting for response"
  }) + "\\n");
  process.exit(1);
}
if (prompt.includes("WRONG_CONVERSATION")) {
  // An unknown --conversation id makes agy silently start a different one.
  process.stdout.write(JSON.stringify({
    conversation_id: "conversation-somewhere-else",
    status: "SUCCESS",
    response: "fresh session, no history"
  }) + "\\n");
  process.exit(0);
}

const suffix = requestedConversation ? "reply" : "start";
process.stdout.write(JSON.stringify({
  conversation_id: requestedConversation || ("conversation-" + suffix + "-" + permissive),
  status: "SUCCESS",
  response: suffix + " result via " + permissive
}) + "\\n");
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "agy.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "agy");
    fs.copyFileSync(scriptPath, executablePath);
    fs.chmodSync(executablePath, 0o755);
  }

  const systemBinaryPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  return {
    capturePath,
    workspacePath,
    env: {
      ...withPath(process.env, [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter)),
      AGY_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_AGENT: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-agent-mail-token",
      MCP_AGENT_MAIL_TOKEN: "caller-mcp-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      INTEGRATION_BEARER_TOKEN: "caller-integration-token",
      PRESERVED_VALUE: "keep-me",
      CLAUDE_DELEGATOR_AGY_DEPTH: ""
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createAgyStub();
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...stub.env, ...extraEnv },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  runningServers.add(child);

  let nextId = 1;
  let stdoutBuffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  child.on("exit", (code) => {
    runningServers.delete(child);
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`server exited with code ${code}: ${stderr}`));
    }
    pending.clear();
  });

  function responseFor(id, responseTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for RPC response: ${stderr}`));
      }, responseTimeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  function request(method, params = {}, responseTimeoutMs = 5_000) {
    const id = nextId++;
    const response = responseFor(id, responseTimeoutMs);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  function requestAndCancelInSingleWrite(method, params = {}, responseTimeoutMs = 5_000) {
    const id = nextId++;
    const response = responseFor(id, responseTimeoutMs);
    const call = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const cancellation = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, reason: "coalesced test cancellation" }
    });
    child.stdin.write(`${call}\n${cancellation}\n`);
    return response;
  }

  function waitForExit() {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const forceKill = setTimeout(() => child.kill(), 2_000);
      forceKill.unref();
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }

  return {
    capturePath: stub.capturePath,
    workspacePath: stub.workspacePath,
    request,
    requestAndCancelInSingleWrite,
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      const exited = waitForExit();
      child.stdin.end();
      return exited;
    },
    terminate(signal = "SIGTERM") {
      const exited = waitForExit();
      child.kill(signal);
      return exited;
    }
  };
}

function readCalls(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("advertises the uniform agy/agy-reply MCP contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-agy");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["agy", "agy-reply"]);
  const startSchema = listed.result.tools[0].inputSchema;
  const replySchema = listed.result.tools[1].inputSchema;
  assert.equal(startSchema.additionalProperties, false);
  assert.equal(startSchema.properties.model.default, "gemini-3.1-pro-high");
  assert.ok(startSchema.properties.model.enum.includes("claude-opus-4-6-thinking"));
  assert.equal(startSchema.properties.model.enum.length, 14);
  assert.deepEqual(startSchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(startSchema.properties.sandbox.default, "workspace-write");
  assert.deepEqual(replySchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(startSchema.properties.timeout.minimum, 10_000);
  assert.equal(startSchema.properties.timeout.maximum, 3_600_000);
  assert.equal(startSchema.properties.timeout.default, 900_000);

  // agy bakes the reasoning tier into most model ids, so neither tool exposes effort.
  assert.equal(startSchema.properties.effort, undefined);
  assert.equal(replySchema.properties.effort, undefined);

  // Deviation from the sibling bridges: a resumed conversation inherits neither
  // its model nor its workspace, so model is required rather than defaulted.
  assert.deepEqual(replySchema.required, ["threadId", "prompt", "model"]);
  assert.equal(replySchema.properties.model.default, undefined);

  assert.ok(startSchema.properties.coordination);
  assert.deepEqual(
    startSchema.properties.coordination.required,
    ["projectKey", "callerAgentName"]
  );
  await server.close();
});

test("constructs read-only and workspace-write calls with the forced non-interactive flags", async () => {
  const server = startServer();
  const coordination = {
    projectKey: "/workspace/project",
    callerAgentName: "codex-wsl-home-1",
    mailTopic: "agy-delegation-1",
    checkpointIntervalSeconds: 120
  };

  const start = await server.request("tools/call", {
    name: "agy",
    arguments: {
      prompt: "Inspect the implementation",
      "developer-instructions": "Act as an architect.",
      model: "gemini-3.5-flash-low",
      sandbox: "read-only",
      cwd: server.workspacePath,
      coordination
    }
  });
  assert.deepEqual(JSON.parse(start.result.content[0].text), {
    threadId: start.result.threadId,
    content: "start result via plain"
  });
  assert.equal(start.result.threadId, "conversation-start-plain");
  assert.equal(start.result.coordinationRequested, true);
  assert.deepEqual(
    Object.keys(start.result).sort(),
    ["content", "coordinationRequested", "threadId"]
  );

  const reply = await server.request("tools/call", {
    name: "agy-reply",
    arguments: {
      threadId: "conversation-original",
      prompt: "Continue the review",
      model: "gemini-3.5-flash-low",
      sandbox: "workspace-write"
    }
  });
  assert.equal(reply.result.threadId, "conversation-original");
  assert.deepEqual(JSON.parse(reply.result.content[0].text), {
    threadId: "conversation-original",
    content: "reply result via dsp"
  });

  const defaultWorkspaceWrite = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "Use the default model" }
  });
  assert.equal(defaultWorkspaceWrite.result.threadId, "conversation-start-dsp");

  const [planCall, replyCall, defaultCall] = readCalls(server.capturePath);

  for (const call of [planCall, replyCall, defaultCall]) {
    // Forced flags lead so the caller prompt stays the final token.
    assert.deepEqual(call.args.slice(0, 3), ["--output-format", "json", "--disable-slash-commands"]);
    assert.match(call.args[call.args.indexOf("--print-timeout") + 1], /^\d+ms$/);
    assert.ok(call.args.includes("--log-file"));
    assert.equal(call.args[call.args.length - 2], "-p");
    // --add-dir would switch on repo-supplied AGENTS.md/GEMINI.md rules injection.
    assert.equal(call.args.includes("--add-dir"), false);
    // --effort conflicts with the tier baked into most model ids.
    assert.equal(call.args.includes("--effort"), false);
    assert.equal(call.args.includes("--continue"), false);
    assert.equal(call.args.includes("--mode"), false);
    // The delegated child is stamped one level deeper than this bridge.
    assert.equal(call.delegationDepth, "1");
    assert.equal(call.hasClaudeCode, false);
    assert.equal(call.hasAgentName, false);
    assert.equal(call.hasAgentMailAgent, false);
    assert.equal(call.hasAgentMailToken, false);
    assert.equal(call.hasMcpAgentMailToken, false);
    assert.equal(call.hasHttpBearerToken, false);
    assert.equal(call.hasIntegrationBearerToken, false);
    assert.equal(call.preservedValue, "keep-me");
  }

  assert.equal(planCall.args[planCall.args.indexOf("--model") + 1], "gemini-3.5-flash-low");
  assert.equal(planCall.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(planCall.cwd, server.workspacePath);
  const planPrompt = planCall.args[planCall.args.indexOf("-p") + 1];
  assert.match(planPrompt, /^Act as an architect\.\n\nInspect the implementation/);
  assert.match(planPrompt, /Optional MCP Agent Mail Coordination/);
  assert.match(planPrompt, /"callerAgentName": "codex-wsl-home-1"/);
  assert.match(planPrompt, /"mailTopic": "agy-delegation-1"/);

  assert.equal(replyCall.args[replyCall.args.indexOf("--conversation") + 1], "conversation-original");
  assert.equal(replyCall.args[replyCall.args.indexOf("--model") + 1], "gemini-3.5-flash-low");
  assert.ok(replyCall.args.includes("--dangerously-skip-permissions"));

  assert.equal(defaultCall.args[defaultCall.args.indexOf("--model") + 1], "gemini-3.1-pro-high");
  assert.ok(defaultCall.args.includes("--dangerously-skip-permissions"));
  await server.close();
});

test("classifies the agy failure channels that are not exit-code shaped", async () => {
  const server = startServer();

  // exit 0 + SUCCESS + empty response: a tool was auto-denied, no work happened.
  const denied = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "AUTO_DENIED" }
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /auto-denied and no work was performed/);
  assert.match(denied.result.content[0].text, /required the "command" permission/);

  // exit 1 + valid JSON + status ERROR + empty conversation id: pre-flight, unrecoverable.
  const preflight = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "PREFLIGHT_ERROR" }
  });
  assert.equal(preflight.result.isError, true);
  assert.match(preflight.result.content[0].text, /Agy ERROR: invalid model selection/);
  assert.equal(/resumable threadId/.test(preflight.result.content[0].text), false);
  assert.match(preflight.result.content[0].text, /stub log: model rejected/);

  // exit 1 + valid JSON + a real conversation id: the run IS resumable.
  const printTimeout = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "PRINT_TIMEOUT" }
  });
  assert.equal(printTimeout.result.isError, true);
  assert.match(printTimeout.result.content[0].text, /timeout waiting for response/);
  assert.match(printTimeout.result.content[0].text, /resumable threadId: conversation-resumable/);

  // exit 2 + no JSON at all.
  const cliFailure = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "CLI_FAILURE" }
  });
  assert.equal(cliFailure.result.isError, true);
  assert.match(cliFailure.result.content[0].text, /no parsable JSON \(exit 2\)/);
  assert.match(cliFailure.result.content[0].text, /Agy stub failed intentionally/);

  // exit 0 + prose instead of JSON.
  const parseFailure = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "BROKEN_JSON" }
  });
  assert.equal(parseFailure.result.isError, true);
  assert.match(parseFailure.result.content[0].text, /No JSON response found/);
  await server.close();
});

test("fails loudly when agy resumes a different conversation", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "agy-reply",
    arguments: {
      threadId: "conversation-that-expired",
      prompt: "WRONG_CONVERSATION",
      model: "gemini-3.5-flash-low"
    }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /resumed a different conversation/);
  assert.match(response.result.content[0].text, /requested conversation-that-expired/);
  assert.match(response.result.content[0].text, /received conversation-somewhere-else/);
  await server.close();
});

test("refuses to delegate from inside an already delegated agy session", async () => {
  const server = startServer({ CLAUDE_DELEGATOR_AGY_DEPTH: "1" });
  for (const name of ["agy", "agy-reply"]) {
    const response = await server.request("tools/call", {
      name,
      arguments: { threadId: "conversation-x", prompt: "hello", model: "gemini-3.5-flash-low" }
    });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /already running inside a delegated Agy session/);
  }
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("rejects invalid inputs before invoking Agy", async () => {
  const server = startServer();
  const invalidCases = [
    [{ name: "agy", arguments: { prompt: "hello", sandbox: "unsafe" } }, /sandbox/],
    [{ name: "agy", arguments: { prompt: "hello", timeout: 9_999 } }, /timeout/],
    [{ name: "agy", arguments: { prompt: "hello", timeout: 3_600_001 } }, /timeout/],
    [{ name: "agy", arguments: { prompt: " " } }, /prompt/],
    [{ name: "agy", arguments: { prompt: "hello", model: "gemini-3.1-pro-preview" } }, /model/],
    [{ name: "agy", arguments: { prompt: "hello", cwd: " " } }, /cwd/],
    [{ name: "agy", arguments: { prompt: "hello", "developer-instructions": 7 } }, /developer-instructions/],
    [{ name: "agy-reply", arguments: { threadId: "latest", prompt: "hello", model: "gemini-3.5-flash-low" } }, /explicit conversation id/],
    [{ name: "agy-reply", arguments: { threadId: "conversation", prompt: " ", model: "gemini-3.5-flash-low" } }, /prompt/],
    [{ name: "agy-reply", arguments: { threadId: "conversation", prompt: "hello" } }, /'model' is required for agy-reply/],
    [{
      name: "agy",
      arguments: {
        prompt: "hello",
        coordination: { projectKey: "project", mailTopic: "agy-delegation-1" }
      }
    }, /callerAgentName/],
    [{ name: "not-agy", arguments: { prompt: "hello" } }, /Unknown tool/]
  ];

  for (const [params, messagePattern] of invalidCases) {
    const response = await server.request("tools/call", params);
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, messagePattern);
  }
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("cancels an active Agy process group and keeps the MCP server responsive", async () => {
  const server = startServer();
  const pending = server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });
  await waitFor(() => fs.existsSync(server.capturePath), "Agy stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Agy process remained alive");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["agy", "agy-reply"]);
  await server.close();
});

test("dispatches a cancellation coalesced with tools/call and remains responsive", async () => {
  const server = startServer();
  const cancelled = await server.requestAndCancelInSingleWrite("tools/call", {
    name: "agy",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });

  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  for (const { pid } of readCalls(server.capturePath)) {
    await waitFor(() => !processIsAlive(pid), "coalesced cancellation left Agy alive");
  }
  await server.close();
});

test("stdin end, SIGTERM, and SIGINT each terminate an active Agy process group", async () => {
  for (const shutdownMode of ["stdin-end", "SIGTERM", "SIGINT"]) {
    const server = startServer();
    const pending = server.request("tools/call", {
      name: "agy",
      arguments: { prompt: "TIMEOUT_FOREVER" }
    }).catch(() => null);
    await waitFor(() => fs.existsSync(server.capturePath), `Agy stub did not start for ${shutdownMode}`);
    const [{ pid }] = readCalls(server.capturePath);

    if (shutdownMode === "stdin-end") {
      await server.close();
    } else {
      await server.terminate(shutdownMode);
    }
    await pending;
    await waitFor(
      () => !processIsAlive(pid),
      `Agy child survived MCP server shutdown via ${shutdownMode}`
    );
  }
});

test("terminates a hung Agy CLI at the requested timeout and remains responsive", { timeout: 20_000 }, async () => {
  const server = startServer();
  const startedAt = Date.now();
  const response = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "TIMEOUT_FOREVER", timeout: 10_000 }
  }, 15_000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Agy CLI timed out after 10s/);
  assert.match(response.result.content[0].text, /Diagnostics:/);
  assert.ok(elapsedMs >= 9_000, `timeout fired too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 14_000, `timeout fired too late after ${elapsedMs}ms`);

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["agy", "agy-reply"]);
  await server.close();
});

test("parses the result past a diagnostic line that contains braces", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "agy",
    arguments: { prompt: "NOISY_JSON" }
  });

  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    threadId: "conversation-noisy",
    content: "parsed past the noise"
  });
  assert.equal(response.result.isError, undefined);
  await server.close();
});

test("reserves a startup budget under agy's own print timeout", () => {
  // agy's --print-timeout bounds only the post-send wait, so the child must be
  // told to give up before our outer hard-kill does, leaving the run resumable.
  assert.equal(bridge.printTimeoutFor(900_000), 870_000);
  assert.equal(bridge.printTimeoutFor(3_600_000), 3_570_000);
  // Short timeouts clamp instead of going negative.
  assert.equal(bridge.printTimeoutFor(10_000), 5_000);
  assert.equal(bridge.printTimeoutFor(30_000), 5_000);
});

test("maps sandbox tiers to the only flag agy actually honours", () => {
  assert.deepEqual(bridge.sandboxArguments("workspace-write"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(bridge.sandboxArguments(undefined), ["--dangerously-skip-permissions"]);
  // read-only soft-denies shell only; there is no provider-enforced write denial.
  assert.deepEqual(bridge.sandboxArguments("read-only"), []);
});

test("stamps the delegation depth while scrubbing caller Agent Mail identity", () => {
  const env = bridge.buildAgyEnv({
    PATH: "/usr/bin",
    AGENT_NAME: "CallerAgent",
    AGENT_MAIL_REGISTRATION_TOKEN: "secret",
    HTTP_BEARER_TOKEN: "secret",
    PRESERVED_VALUE: "keep-me"
  });
  assert.equal(env.CLAUDE_DELEGATOR_AGY_DEPTH, "1");
  assert.equal(env.PRESERVED_VALUE, "keep-me");
  assert.equal(env.AGENT_NAME, undefined);
  assert.equal(env.AGENT_MAIL_REGISTRATION_TOKEN, undefined);
  assert.equal(env.HTTP_BEARER_TOKEN, undefined);

  const nested = bridge.buildAgyEnv({ CLAUDE_DELEGATOR_AGY_DEPTH: "1" });
  assert.equal(nested.CLAUDE_DELEGATOR_AGY_DEPTH, "2");
});

test("parses only complete JSON candidates that look like an agy result", () => {
  assert.deepEqual(
    bridge.parseAgyOutput('noise {broken\n{"conversation_id":"c1","status":"SUCCESS","response":"ok"}'),
    { conversation_id: "c1", status: "SUCCESS", response: "ok" }
  );
  assert.throws(() => bridge.parseAgyOutput("   "), /No JSON response found/);
  assert.throws(() => bridge.parseAgyOutput("{}"), /No JSON response found/);
});

test("binds the shared shim resolver to its own CLI name", () => {
  // The shim shapes themselves are covered once, in server/shared/bridge.test.js.
  // What is per-bridge is only which command name gets baked in, and that is what
  // makes a mismatched shim fail loudly instead of resolving to another CLI.
  const dir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
  const shimPath = dir + "\\agy.cmd";
  const script = dir + "\\agy-stub.js";
  const node = "C:\\Program Files\\nodejs\\node.exe";

  assert.equal(
    bridge.resolveWindowsShim(shimPath, () => `@echo off\r\n"${node}" "%dp0%\\agy-stub.js" %*\r\n`),
    script
  );
  assert.throws(
    () => bridge.resolveWindowsShim(shimPath, () => `@echo off\r\n"${node}" "%dp0%\\other-stub.js" %*\r\n`),
    /could not resolve agy/
  );
});
