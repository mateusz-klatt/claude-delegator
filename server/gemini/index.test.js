"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

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

function createGeminiStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const workspacePath = path.join(directory, "workspace");
  const scriptPath = path.join(directory, "gemini-stub.js");
  fs.mkdirSync(workspacePath);

  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("0.54.4\\n");
  process.exit(0);
}
const approvalIndex = args.indexOf("--approval-mode");
const promptIndex = args.indexOf("-p");
const approvalMode = approvalIndex === -1 ? null : args[approvalIndex + 1];
const prompt = promptIndex === -1 ? "" : args[promptIndex + 1];
fs.appendFileSync(process.env.GEMINI_STUB_CAPTURE, JSON.stringify({
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
  providerAuth: process.env.GEMINI_API_KEY
}) + "\\n");

if (prompt.includes("TIMEOUT_FOREVER")) {
  setInterval(() => {}, 1_000);
  return;
}
if (prompt.includes("CLI_FAILURE")) {
  process.stderr.write("Gemini stub failed intentionally\\n");
  process.exit(7);
}
if (prompt.includes("BROKEN_JSON")) {
  process.stdout.write("Gemini diagnostic without a structured result\\n");
  process.exit(0);
}
if (prompt.includes("NOISY_JSON")) {
  process.stdout.write("warning: telemetry cache {unavailable}\\n");
  process.stdout.write(JSON.stringify({
    response: "parsed past the noise",
    session_id: "session-noisy"
  }) + "\\n");
  process.exit(0);
}

const isReply = args.includes("--resume");
const suffix = isReply ? "reply" : "start";
const result = prompt.includes("NO_RESPONSE")
  ? { session_id: "session-empty" }
  : {
      response: suffix + " result via " + approvalMode,
      session_id: "session-" + suffix + "-" + approvalMode
    };
process.stdout.write("Gemini stub diagnostic\\n");
process.stdout.write(JSON.stringify(result) + "\\n");
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "gemini.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "gemini");
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
      ...process.env,
      PATH: [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter),
      GEMINI_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_AGENT: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-agent-mail-token",
      MCP_AGENT_MAIL_TOKEN: "caller-mcp-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      INTEGRATION_BEARER_TOKEN: "caller-integration-token",
      PRESERVED_VALUE: "keep-me",
      GEMINI_API_KEY: "provider-auth"
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createGeminiStub();
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

test("advertises the uniform gemini/gemini-reply MCP contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-gemini");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["gemini", "gemini-reply"]);
  const startSchema = listed.result.tools[0].inputSchema;
  const replySchema = listed.result.tools[1].inputSchema;
  assert.equal(startSchema.additionalProperties, false);
  assert.equal(startSchema.properties.model.default, "gemini-3.1-pro-preview");
  assert.equal(startSchema.properties.model.enum, undefined);
  assert.ok(startSchema.properties.model.examples.includes("auto-gemini-3"));
  assert.deepEqual(startSchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(startSchema.properties.sandbox.default, "workspace-write");
  assert.deepEqual(replySchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(replySchema.properties.sandbox.default, "workspace-write");
  assert.equal(startSchema.properties.timeout.minimum, 10_000);
  assert.equal(startSchema.properties.timeout.maximum, 3_600_000);
  assert.deepEqual(replySchema.required, ["threadId", "prompt"]);
  assert.ok(startSchema.properties.coordination);
  assert.ok(replySchema.properties.coordination);
  assert.deepEqual(
    startSchema.properties.coordination.required,
    ["projectKey", "callerAgentName"]
  );
  assert.equal(
    startSchema.properties.coordination.properties.mailTopic.pattern,
    "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
  );
  assert.deepEqual(
    Object.keys(startSchema.properties.coordination.properties).sort(),
    [
      "callerAgentName",
      "checkpointIntervalSeconds",
      "mailTopic",
      "projectKey"
    ]
  );
  await server.close();
});

test("constructs read-only plan plus explicit and default workspace-write yolo calls", async () => {
  const server = startServer();
  const coordination = {
    projectKey: "/workspace/project",
    callerAgentName: "codex-wsl-home-1",
    mailTopic: "gemini-delegation-1",
    checkpointIntervalSeconds: 120
  };

  const start = await server.request("tools/call", {
    name: "gemini",
    arguments: {
      prompt: "Inspect the implementation",
      "developer-instructions": "Act as an architect.",
      model: "gemini-2.5-flash",
      sandbox: "read-only",
      cwd: server.workspacePath,
      coordination
    }
  });
  assert.deepEqual(JSON.parse(start.result.content[0].text), { threadId: start.result.threadId, content: "start result via plan" });
  assert.equal(start.result.threadId, "session-start-plan");
  assert.equal(start.result.coordinationRequested, true);
  assert.deepEqual(
    Object.keys(start.result).sort(),
    ["content", "coordinationRequested", "threadId"]
  );

  const reply = await server.request("tools/call", {
    name: "gemini-reply",
    arguments: {
      threadId: "session-original",
      prompt: "Continue the review",
      sandbox: "workspace-write"
    }
  });
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { threadId: reply.result.threadId, content: "reply result via yolo" });
  assert.equal(reply.result.threadId, "session-reply-yolo");
  assert.equal(reply.result.coordinationRequested, false);

  const defaultWorkspaceWrite = await server.request("tools/call", {
    name: "gemini",
    arguments: {
      prompt: "Use the experimental model",
      model: "gemini-experimental-account-model"
    }
  });
  assert.deepEqual(JSON.parse(defaultWorkspaceWrite.result.content[0].text), { threadId: defaultWorkspaceWrite.result.threadId, content: "start result via yolo" });
  assert.equal(defaultWorkspaceWrite.result.threadId, "session-start-yolo");

  const [planCall, replyCall, defaultCall] = readCalls(server.capturePath);
  assert.deepEqual(planCall.args.slice(0, 4), ["-m", "gemini-2.5-flash", "--approval-mode", "plan"]);
  assert.deepEqual(planCall.args.slice(-2), ["-o", "json"]);
  assert.equal(planCall.cwd, server.workspacePath);
  const planPrompt = planCall.args[planCall.args.indexOf("-p") + 1];
  assert.match(planPrompt, /^Act as an architect\.\n\nInspect the implementation/);
  assert.match(planPrompt, /Optional MCP Agent Mail Coordination/);
  assert.match(planPrompt, /"callerAgentName": "codex-wsl-home-1"/);
  assert.match(planPrompt, /"mailTopic": "gemini-delegation-1"/);
  assert.match(planPrompt, /"checkpointIntervalSeconds": 120/);
  assert.match(planPrompt, /reply_message/);

  assert.equal(replyCall.args[replyCall.args.indexOf("--resume") + 1], "session-original");
  assert.equal(replyCall.args.includes("-m"), false);
  assert.equal(replyCall.args[replyCall.args.indexOf("--approval-mode") + 1], "yolo");
  assert.equal(replyCall.args[replyCall.args.indexOf("-p") + 1], "Continue the review");
  assert.deepEqual(replyCall.args.slice(-2), ["-o", "json"]);

  assert.equal(defaultCall.args[defaultCall.args.indexOf("-m") + 1], "gemini-experimental-account-model");
  assert.equal(defaultCall.args[defaultCall.args.indexOf("--approval-mode") + 1], "yolo");

  for (const call of [planCall, replyCall, defaultCall]) {
    assert.equal(call.hasClaudeCode, false);
    assert.equal(call.hasAgentName, false);
    assert.equal(call.hasAgentMailAgent, false);
    assert.equal(call.hasAgentMailToken, false);
    assert.equal(call.hasMcpAgentMailToken, false);
    assert.equal(call.hasHttpBearerToken, false);
    assert.equal(call.hasIntegrationBearerToken, false);
    assert.equal(call.preservedValue, "keep-me");
    assert.equal(call.providerAuth, "provider-auth");
  }
  await server.close();
});

test("uses explicit fallback output and reports CLI and parse failures", async () => {
  const server = startServer();
  const empty = await server.request("tools/call", {
    name: "gemini",
    arguments: { prompt: "NO_RESPONSE" }
  });
  assert.deepEqual(JSON.parse(empty.result.content[0].text), { threadId: empty.result.threadId, content: "(No output)" });
  assert.equal(empty.result.threadId, "session-empty");

  const cliFailure = await server.request("tools/call", {
    name: "gemini",
    arguments: { prompt: "CLI_FAILURE" }
  });
  assert.equal(cliFailure.result.isError, true);
  assert.match(cliFailure.result.content[0].text, /Gemini stub failed intentionally/);

  const parseFailure = await server.request("tools/call", {
    name: "gemini",
    arguments: { prompt: "BROKEN_JSON" }
  });
  assert.equal(parseFailure.result.isError, true);
  assert.match(parseFailure.result.content[0].text, /Parse error: No JSON response found/);
  assert.match(parseFailure.result.content[0].text, /Raw output was: Gemini diagnostic/);
  await server.close();
});

test("rejects invalid inputs before invoking Gemini", async () => {
  const server = startServer();
  const invalidCases = [
    [{ name: "gemini", arguments: { prompt: "hello", sandbox: "unsafe" } }, /sandbox/],
    [{ name: "gemini", arguments: { prompt: "hello", timeout: 9_999 } }, /timeout/],
    [{ name: "gemini", arguments: { prompt: "hello", timeout: 3_600_001 } }, /timeout/],
    [{ name: "gemini", arguments: { prompt: " " } }, /prompt/],
    [{ name: "gemini", arguments: { prompt: "hello", model: " " } }, /model/],
    [{ name: "gemini", arguments: { prompt: "hello", "developer-instructions": 7 } }, /developer-instructions/],
    [{ name: "gemini-reply", arguments: { threadId: "latest", prompt: "hello" } }, /explicit session id/],
    [{ name: "gemini-reply", arguments: { threadId: "session", prompt: " " } }, /prompt/],
    [{
      name: "gemini",
      arguments: {
        prompt: "hello",
        coordination: {
          projectKey: "project",
          mailTopic: "gemini-delegation-1"
        }
      }
    }, /callerAgentName/],
    [{ name: "not-gemini", arguments: { prompt: "hello" } }, /Unknown tool/]
  ];

  for (const [params, messagePattern] of invalidCases) {
    const response = await server.request("tools/call", params);
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, messagePattern);
  }
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("cancels an active Gemini process group and keeps the MCP server responsive", async () => {
  const server = startServer();
  const pending = server.request("tools/call", {
    name: "gemini",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });
  await waitFor(() => fs.existsSync(server.capturePath), "Gemini stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Gemini process remained alive");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["gemini", "gemini-reply"]);
  await server.close();
});

test("dispatches a cancellation coalesced with tools/call and remains responsive", async () => {
  const server = startServer();
  const cancelled = await server.requestAndCancelInSingleWrite("tools/call", {
    name: "gemini",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });

  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  for (const { pid } of readCalls(server.capturePath)) {
    await waitFor(() => !processIsAlive(pid), "coalesced cancellation left Gemini alive");
  }

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["gemini", "gemini-reply"]);
  await server.close();
});

test("stdin end, SIGTERM, and SIGINT each terminate an active Gemini process group", async () => {
  for (const shutdownMode of ["stdin-end", "SIGTERM", "SIGINT"]) {
    const server = startServer();
    const pending = server.request("tools/call", {
      name: "gemini",
      arguments: { prompt: "TIMEOUT_FOREVER" }
    }).catch(() => null);
    await waitFor(() => fs.existsSync(server.capturePath), `Gemini stub did not start for ${shutdownMode}`);
    const [{ pid }] = readCalls(server.capturePath);

    if (shutdownMode === "stdin-end") {
      await server.close();
    } else {
      await server.terminate(shutdownMode);
    }
    await pending;
    await waitFor(
      () => !processIsAlive(pid),
      `Gemini child survived MCP server shutdown via ${shutdownMode}`
    );
  }
});

test("terminates a hung Gemini CLI at the requested timeout and remains responsive", { timeout: 20_000 }, async () => {
  const server = startServer();
  const startedAt = Date.now();
  const response = await server.request("tools/call", {
    name: "gemini",
    arguments: { prompt: "TIMEOUT_FOREVER", timeout: 10_000 }
  }, 15_000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Gemini CLI timed out after 10s/);
  assert.ok(elapsedMs >= 9_000, `timeout fired too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 14_000, `timeout fired too late after ${elapsedMs}ms`);

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["gemini", "gemini-reply"]);
  await server.close();
});

test("parses the result past a diagnostic line that contains braces", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "gemini",
    arguments: { prompt: "NOISY_JSON" }
  });

  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    threadId: response.result.threadId,
    content: "parsed past the noise"
  });
  assert.equal(response.result.threadId, "session-noisy");
  assert.equal(response.result.isError, undefined);
  await server.close();
});
