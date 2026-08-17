"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const bridge = require("./index.js");

const catalog = require("../../config/model-catalog.json");
const { resolveEffort } = require("./index.js");

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

function createCopilotStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const scriptPath = path.join(directory, "copilot-stub.js");
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("Copilot CLI 1.0.78\\n");
  process.exit(0);
}

fs.appendFileSync(process.env.COPILOT_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  cwd: process.cwd(),
  preservedValue: process.env.PRESERVED_VALUE,
  providerAuth: process.env.GITHUB_TOKEN,
  agentName: process.env.AGENT_NAME,
  agentMailAgent: process.env.AGENT_MAIL_AGENT,
  agentMailProject: process.env.Agent_Mail_Project_Key,
  agentMailToken: process.env.AGENT_MAIL_REGISTRATION_TOKEN,
  mcpAgentMailToken: process.env.MCP_AGENT_MAIL_TOKEN,
  httpBearerToken: process.env.HTTP_BEARER_TOKEN,
  integrationBearerToken: process.env.integration_bearer_token,
  claudeCode: process.env.CLAUDECODE
}) + "\\n");

if (process.env.COPILOT_STUB_PROCESS_ERROR === "1") {
  process.stderr.write("stub process failed\\n");
  process.exit(17);
}

if (process.env.COPILOT_STUB_QUOTA === "1") {
  // Real shape measured on macOS and Linux: the reason is a session.error event
  // on STDOUT, stderr is empty (0 bytes), and the process exits non-zero.
  process.stdout.write(JSON.stringify({
    type: "session.error",
    data: {
      errorType: "quota",
      errorCode: "quota_exceeded",
      statusCode: 402,
      message: "You have exceeded your monthly quota"
    }
  }) + "\\n");
  process.exit(1);
}

if (process.env.COPILOT_STUB_HANG === "1") {
  setInterval(() => {}, 1_000);
} else {
  const isReply = args.includes("--resume");
  process.stdout.write(JSON.stringify({
    type: "assistant.message",
    data: { content: isReply ? "reply " : "start " }
  }) + "\\n");
  process.stdout.write("terminal noise ignored by the bridge\\n");
  process.stdout.write(JSON.stringify({
    type: "assistant.message",
    data: { content: "result" }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    sessionId: process.env.COPILOT_STUB_OMIT_SESSION === "1"
      ? undefined
      : (isReply ? "thread-reply" : "thread-start"),
    exitCode: process.env.COPILOT_STUB_RESULT_ERROR === "1" ? 9 : 0
  }) + "\\n");
}
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "copilot.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "copilot");
    fs.copyFileSync(scriptPath, executablePath);
    fs.chmodSync(executablePath, 0o755);
  }

  const systemBinaryPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  return {
    capturePath,
    directory,
    env: {
      ...process.env,
      PATH: [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter),
      COPILOT_STUB_CAPTURE: capturePath,
      PRESERVED_VALUE: "keep-me",
      GITHUB_TOKEN: "provider-auth",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_AGENT: "CallerAgent",
      Agent_Mail_Project_Key: "/caller/project",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-registration-token",
      MCP_AGENT_MAIL_TOKEN: "caller-project-token",
      HTTP_BEARER_TOKEN: "caller-server-token",
      integration_bearer_token: "caller-integration-token",
      CLAUDECODE: "nested-session-marker"
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createCopilotStub();
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

  function waitForResponse(id, responseTimeoutMs) {
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
    const response = waitForResponse(id, responseTimeoutMs);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  function requestAndCancelSameChunk(method, params = {}, reason = "test cancellation") {
    const id = nextId++;
    const response = waitForResponse(id, 5_000);
    const frames = [
      { jsonrpc: "2.0", id, method, params },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }
    ];
    child.stdin.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    return response;
  }

  function waitForExit() {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      const forceKill = setTimeout(() => child.kill(), 2_000);
      forceKill.unref();
      child.once("exit", (code, signal) => {
        clearTimeout(forceKill);
        resolve({ code, signal });
      });
    });
  }

  return {
    capturePath: stub.capturePath,
    directory: stub.directory,
    pid: child.pid,
    request,
    requestAndCancelSameChunk,
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

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `expected ${flag} in ${JSON.stringify(args)}`);
  return args[index + 1];
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

function linuxDirectChildPids(pid) {
  if (process.platform !== "linux") return [];
  const childrenPath = `/proc/${pid}/task/${pid}/children`;
  if (!fs.existsSync(childrenPath)) return [];
  return fs.readFileSync(childrenPath, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

test("advertises the uniform copilot/copilot-reply contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-copilot");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["copilot", "copilot-reply"]);
  const [start, reply] = listed.result.tools.map((tool) => tool.inputSchema);
  const copilotCatalog = catalog.providers.copilot;
  assert.equal(start.additionalProperties, false);
  assert.deepEqual(start.required, ["prompt"]);
  assert.deepEqual(start.properties.model.enum, copilotCatalog.models);
  assert.equal(start.properties.model.default, copilotCatalog.defaultModel);
  assert.deepEqual(start.properties.effort.enum, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(start.properties.effort.default, copilotCatalog.defaultEffort);
  assert.equal(start.properties.timeout.minimum, 10_000);
  assert.equal(start.properties.timeout.maximum, 3_600_000);
  assert.deepEqual(start.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(start.properties.sandbox.default, "workspace-write");
  assert.deepEqual(reply.required, ["threadId", "prompt"]);
  assert.deepEqual(reply.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(reply.properties.sandbox.default, "workspace-write");
  assert.equal(reply.properties.effort.default, undefined);
  assert.ok(start.properties.coordination);
  assert.ok(reply.properties.coordination);
  assert.deepEqual(start.properties.coordination.required, ["projectKey", "callerAgentName"]);
  assert.deepEqual(reply.properties.coordination.required, ["projectKey", "callerAgentName"]);
  assert.equal(start.properties.coordination.properties.mailTopic.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  assert.equal(start.properties.coordination.properties.checkpointIntervalSeconds.minimum, 60);
  await server.close();
});

test("starts Copilot read-only with capped effort, coordination, cwd, and a scrubbed environment", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "copilot",
    arguments: {
      prompt: "Inspect the implementation",
      "developer-instructions": "Act as a reviewer.",
      model: "claude-opus-5",
      effort: "max",
      sandbox: "read-only",
      cwd: server.directory,
      timeout: 10_000,
      coordination: {
        projectKey: "/workspace/project",
        callerAgentName: "codex-wsl-home-1",
        mailTopic: "copilot-review-1",
        checkpointIntervalSeconds: 60
      }
    }
  });

  assert.deepEqual(JSON.parse(response.result.content[0].text), { threadId: response.result.threadId, content: "start result" });
  assert.equal(response.result.threadId, "thread-start");
  assert.equal(response.result.coordinationRequested, true);
  assert.deepEqual(Object.keys(response.result).sort(), ["content", "coordinationRequested", "threadId"]);

  const [call] = readCalls(server.capturePath);
  assert.equal(call.cwd, server.directory);
  assert.equal(argumentValue(call.args, "--model"), "claude-opus-5");
  assert.equal(argumentValue(call.args, "--effort"), "xhigh");
  assert.ok(call.args.includes("--deny-tool=shell"));
  assert.ok(call.args.includes("--deny-tool=write"));
  assert.ok(call.args.includes("--deny-tool=edit"));
  assert.equal(call.args.includes("--allow-all-tools"), false);
  assert.ok(call.args.includes("--output-format"));
  assert.equal(argumentValue(call.args, "--output-format"), "json");
  assert.ok(call.args.includes("--silent"));
  assert.ok(call.args.includes("--no-ask-user"));
  assert.ok(call.args.includes("--no-custom-instructions"));

  const prompt = argumentValue(call.args, "-p");
  assert.match(prompt, /^Act as a reviewer\.\n\nInspect the implementation/);
  assert.match(prompt, /Optional MCP Agent Mail Coordination/);
  assert.match(prompt, /Useful native subagents are allowed/);
  assert.match(prompt, /"callerAgentName": "codex-wsl-home-1"/);
  assert.match(prompt, /"mailTopic": "copilot-review-1"/);
  assert.match(prompt, /"checkpointIntervalSeconds": 60/);
  assert.match(prompt, /reply_message/);

  assert.equal(call.preservedValue, "keep-me");
  assert.equal(call.providerAuth, "provider-auth");
  assert.equal(call.agentName, undefined);
  assert.equal(call.agentMailAgent, undefined);
  assert.equal(call.agentMailProject, undefined);
  assert.equal(call.agentMailToken, undefined);
  assert.equal(call.mcpAgentMailToken, undefined);
  assert.equal(call.httpBearerToken, undefined);
  assert.equal(call.integrationBearerToken, undefined);
  assert.equal(call.claudeCode, undefined);
  await server.close();
});

test("forwards none/minimal efforts verbatim and maps workspace-write to allow-all", async () => {
  const server = startServer();
  for (const effort of ["none", "minimal"]) {
    const response = await server.request("tools/call", {
      name: "copilot",
      arguments: {
        prompt: `Use ${effort} effort`,
        model: "gpt-5.6-sol",
        effort,
        sandbox: "workspace-write"
      }
    });
    assert.equal(response.result.isError, undefined);
  }

  const calls = readCalls(server.capturePath);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => argumentValue(call.args, "--effort")), ["none", "minimal"]);
  for (const call of calls) {
    assert.ok(call.args.includes("--allow-all-tools"));
    assert.equal(call.args.some((arg) => arg.startsWith("--deny-tool=")), false);
  }
  await server.close();
});

test("uses verified model effort floors and ceilings and caps max conservatively on resume", async () => {
  assert.equal(resolveEffort("gpt-5.6-sol", "max"), "max");
  assert.equal(resolveEffort("gpt-5.6-terra", "max"), "xhigh");
  assert.equal(resolveEffort("claude-opus-5", "minimal"), "minimal");
  assert.equal(resolveEffort("gpt-5-mini", "none"), "low");
  assert.equal(resolveEffort("gpt-5-mini", "minimal"), "low");

  const server = startServer();
  const start = await server.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "Use the verified maximum", model: "gpt-5.6-sol", effort: "max" }
  });
  assert.equal(start.result.threadId, "thread-start");

  const flooredStart = await server.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "Use the verified minimum", model: "gpt-5-mini", effort: "none" }
  });
  assert.equal(flooredStart.result.threadId, "thread-start");

  const reply = await server.request("tools/call", {
    name: "copilot-reply",
    arguments: {
      threadId: "thread-original",
      prompt: "Continue the review",
      effort: "max",
      sandbox: "read-only"
    }
  });
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { threadId: reply.result.threadId, content: "reply result" });
  assert.equal(reply.result.threadId, "thread-reply");

  const [startCall, flooredStartCall, replyCall] = readCalls(server.capturePath);
  assert.equal(argumentValue(startCall.args, "--effort"), "max");
  assert.ok(startCall.args.includes("--allow-all-tools"));
  assert.equal(argumentValue(flooredStartCall.args, "--model"), "gpt-5-mini");
  assert.equal(argumentValue(flooredStartCall.args, "--effort"), "low");
  assert.ok(flooredStartCall.args.includes("--allow-all-tools"));
  assert.equal(argumentValue(replyCall.args, "--resume"), "thread-original");
  assert.equal(argumentValue(replyCall.args, "--effort"), "xhigh");
  assert.equal(replyCall.args.includes("--model"), false);
  assert.ok(replyCall.args.includes("--deny-tool=shell"));
  assert.equal(argumentValue(replyCall.args, "-p"), "Continue the review");
  await server.close();
});

test("adds coordination to replies and forwards an explicit low effort unchanged", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "copilot-reply",
    arguments: {
      threadId: "thread-original",
      prompt: "Finish the task",
      effort: "none",
      coordination: {
        projectKey: "project-a",
        callerAgentName: "codex-wsl-home-1"
      }
    }
  });

  assert.equal(response.result.coordinationRequested, true);
  assert.deepEqual(Object.keys(response.result).sort(), ["content", "coordinationRequested", "threadId"]);
  const [call] = readCalls(server.capturePath);
  assert.equal(argumentValue(call.args, "--resume"), "thread-original");
  assert.equal(argumentValue(call.args, "--effort"), "none");
  assert.ok(call.args.includes("--allow-all-tools"));
  assert.match(argumentValue(call.args, "-p"), /"callerAgentName": "codex-wsl-home-1"/);
  assert.match(argumentValue(call.args, "-p"), /"projectKey": "project-a"/);
  assert.match(argumentValue(call.args, "-p"), /reply_message/);
  assert.match(argumentValue(call.args, "-p"), /mail failure must not block the task/);
  await server.close();
});

test("rejects invalid tool inputs and timeout bounds before invoking Copilot", async () => {
  const server = startServer();
  const invalidCalls = [
    { name: "copilot", arguments: { prompt: "hello", model: "not-a-model" } },
    { name: "copilot", arguments: { prompt: "hello", sandbox: "prompt-me" } },
    { name: "copilot", arguments: { prompt: "hello", effort: "ultra" } },
    { name: "copilot", arguments: { prompt: "hello", timeout: 9_999 } },
    { name: "copilot", arguments: { prompt: "hello", timeout: 3_600_001 } },
    { name: "copilot", arguments: { prompt: "hello", cwd: "" } },
    { name: "copilot", arguments: { prompt: "" } },
    { name: "copilot", arguments: { prompt: "hello", "developer-instructions": 7 } },
    { name: "copilot-reply", arguments: { threadId: "latest", prompt: "hello" } },
    { name: "copilot-reply", arguments: { threadId: "unknown", prompt: "hello" } },
    { name: "copilot-reply", arguments: { threadId: "thread-1", prompt: "" } },
    {
      name: "copilot",
      arguments: {
        prompt: "hello",
        coordination: { projectKey: "project-a" }
      }
    },
    { name: "not-a-tool", arguments: {} }
  ];

  for (const params of invalidCalls) {
    const response = await server.request("tools/call", params);
    assert.equal(response.error.code, -32602, response.error.message);
  }
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("validates the JSON-RPC call envelope before invoking Copilot", async () => {
  const server = startServer();
  const invalidParams = await server.request("tools/call", []);
  assert.equal(invalidParams.error.code, -32602);
  assert.match(invalidParams.error.message, /expected an object/);

  const invalidName = await server.request("tools/call", { name: "", arguments: {} });
  assert.equal(invalidName.error.code, -32602);
  assert.match(invalidName.error.message, /name/);

  const invalidArguments = await server.request("tools/call", { name: "copilot", arguments: [] });
  assert.equal(invalidArguments.error.code, -32602);
  assert.match(invalidArguments.error.message, /arguments/);

  const unknownMethod = await server.request("unknown/method");
  assert.equal(unknownMethod.error.code, -32601);
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("returns CLI and session failures as MCP tool errors", async () => {
  const processFailureServer = startServer({ COPILOT_STUB_PROCESS_ERROR: "1" });
  const processFailure = await processFailureServer.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "fail in the process" }
  });
  assert.equal(processFailure.result.isError, true);
  assert.match(processFailure.result.content[0].text, /stub process failed/);
  await processFailureServer.close();

  const resultFailureServer = startServer({ COPILOT_STUB_RESULT_ERROR: "1" });
  const resultFailure = await resultFailureServer.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "fail in the result event" }
  });
  assert.equal(resultFailure.result.isError, true);
  assert.match(resultFailure.result.content[0].text, /exitCode 9/);
  await resultFailureServer.close();
});

test("cancels an active Copilot process group and keeps the MCP server responsive", async () => {
  const server = startServer({ COPILOT_STUB_HANG: "1" });
  const pending = server.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "hang until cancelled" }
  });
  await waitFor(() => fs.existsSync(server.capturePath), "Copilot stub did not start");
  const [{ pid, args }] = readCalls(server.capturePath);
  assert.ok(args.includes("--allow-all-tools"));

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Copilot process remained alive");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["copilot", "copilot-reply"]);
  await server.close();
});

test("dispatches a tools call and cancellation from the same stdin chunk independently", async () => {
  const server = startServer({ COPILOT_STUB_HANG: "1" });
  const cancelled = await server.requestAndCancelSameChunk("tools/call", {
    name: "copilot",
    arguments: { prompt: "cancel from the same stdin chunk" }
  });

  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  if (process.platform === "linux") {
    await waitFor(
      () => linuxDirectChildPids(server.pid).length === 0,
      "same-chunk cancellation left the Copilot child running"
    );
  }
  if (fs.existsSync(server.capturePath)) {
    const [{ pid }] = readCalls(server.capturePath);
    await waitFor(() => !processIsAlive(pid), "same-chunk cancellation left the Copilot stub alive");
  }

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["copilot", "copilot-reply"]);
  await server.close();
});

test("all MCP shutdown paths terminate an active Copilot process group", async () => {
  const shutdownModes = [
    ["stdin end", (server) => server.close(), 0],
    ["SIGTERM", (server) => server.terminate("SIGTERM"), 0]
  ];
  if (process.platform !== "win32") {
    shutdownModes.push(["SIGINT", (server) => server.terminate("SIGINT"), 130]);
  }

  for (const [name, shutdown, expectedExitCode] of shutdownModes) {
    const server = startServer({ COPILOT_STUB_HANG: "1" });
    const pending = server.request("tools/call", {
      name: "copilot",
      arguments: { prompt: `hang until ${name}` }
    }).catch(() => null);
    await waitFor(() => fs.existsSync(server.capturePath), `Copilot stub did not start for ${name}`);
    const [{ pid, args }] = readCalls(server.capturePath);
    assert.ok(args.includes("--allow-all-tools"));

    const shutdownStartedAt = Date.now();
    try {
      const exit = await shutdown(server);
      await pending;
      await waitFor(() => !processIsAlive(pid), `Copilot child survived ${name}`);
      assert.ok(Date.now() - shutdownStartedAt < 2_500, `${name} shutdown took too long`);
      if (process.platform === "win32" && name === "SIGTERM") {
        assert.equal(exit.code, null, "Windows SIGTERM should report a signal exit");
        assert.equal(exit.signal, "SIGTERM", "Windows SIGTERM reported an unexpected signal");
      } else {
        assert.equal(exit.code, expectedExitCode, `${name} returned an unexpected exit code`);
      }
    } finally {
      if (processIsAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch (_error) { /* already dead */ }
      }
    }
  }
});

test("terminates a hung Copilot CLI at the requested timeout and remains responsive", async () => {
  const server = startServer({ COPILOT_STUB_HANG: "1" });
  const startedAt = Date.now();
  const response = await server.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "hang until timeout", timeout: 10_000 }
  }, 15_000);

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Copilot CLI timed out after 10s/);
  assert.ok(Date.now() - startedAt >= 9_000);

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["copilot", "copilot-reply"]);
  await server.close();
});

test("warns when a successful start does not return a session id", async () => {
  const server = startServer({ COPILOT_STUB_OMIT_SESSION: "1" });
  const response = await server.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "one-shot task" }
  });

  assert.equal(response.result.threadId, "unknown");
  const warned = JSON.parse(response.result.content[0].text);
  assert.match(warned.content, /^start result/);
  assert.match(warned.content, /Warning: no session ID returned/);
  await server.close();
});

test("surfaces a provider error that Copilot reports on stdout with an empty stderr", async () => {
  // Measured independently on macOS and Linux: stderr is 0 bytes and the whole
  // reason (402 / quota_exceeded) is a session.error event on stdout. The old
  // code returned "Copilot exited with code 1" and dropped it, which made a
  // spent quota indistinguishable from a broken bridge.
  const server = startServer({ COPILOT_STUB_QUOTA: "1" });
  const response = await server.request("tools/call", {
    name: "copilot",
    arguments: { prompt: "anything" }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /exceeded your monthly quota/);
  assert.match(response.result.content[0].text, /quota_exceeded/);
  assert.match(response.result.content[0].text, /402/);
  assert.doesNotMatch(response.result.content[0].text, /exited with code/);
  await server.close();
});

test("parses assistant chunks, session id and provider errors from one JSONL stream", () => {
  const stream = [
    JSON.stringify({ type: "assistant.message", data: { content: "one " } }),
    "terminal noise",
    JSON.stringify({ type: "assistant.message", data: { content: "two" } }),
    JSON.stringify({ type: "result", sessionId: "s-1", exitCode: 0 })
  ].join("\n");

  assert.deepEqual(bridge.parseCopilotOutput(stream), {
    chunks: ["one ", "two"],
    sessionId: "s-1",
    resultExitCode: 0,
    errorMessage: ""
  });

  const failure = bridge.parseCopilotOutput(JSON.stringify({
    type: "session.error",
    data: { message: "Boom", errorCode: "quota_exceeded", statusCode: 402 }
  }));
  assert.equal(failure.errorMessage, "Boom (quota_exceeded 402)");

  assert.equal(bridge.parseCopilotOutput("").sessionId, "unknown");
});

test("follows a Windows .cmd shim to the loader it wraps", () => {
  // Previously inline in the startup block, so it could only be exercised by
  // running on real Windows. Injecting the reader makes it testable anywhere.
  const dir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
  const shimPath = dir + "\\copilot.cmd";
  const script = dir + "\\node_modules\\@github\\copilot\\index.js";
  const node = "C:\\Program Files\\nodejs\\node.exe";

  assert.equal(
    bridge.resolveWindowsShim(shimPath, () => `@echo off\r\n"${node}" "${script}" %*\r\n`),
    script
  );

  const dp0 = `@echo off\r\n@SET "dp0=%~dp0"\r\n"${node}" "%dp0%\\node_modules\\@github\\copilot\\index.js" %*\r\n`;
  assert.equal(bridge.resolveWindowsShim(shimPath, () => dp0).includes("%dp0%"), false);
  assert.match(bridge.resolveWindowsShim(shimPath, () => dp0), /index\.js$/);

  assert.equal(bridge.resolveWindowsShim(dir + "\\copilot.exe", () => { throw new Error("must not read"); }), dir + "\\copilot.exe");
  assert.throws(() => bridge.resolveWindowsShim(shimPath, () => "@echo off\r\nrem nothing\r\n"), /could not resolve copilot/);
});
