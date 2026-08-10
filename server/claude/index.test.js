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

function createClaudeStub() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-test-"));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const scriptPath = path.join(directory, "claude-stub.js");
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.226 (Claude Code)\\n");
  process.exit(0);
}
fs.appendFileSync(process.env.CLAUDE_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  hasClaudeCode: Object.prototype.hasOwnProperty.call(process.env, "CLAUDECODE"),
  preservedValue: process.env.PRESERVED_VALUE,
  agentName: process.env.AGENT_NAME,
  agentMailAgent: process.env.AGENT_MAIL_AGENT,
  agentMailToken: process.env.AGENT_MAIL_REGISTRATION_TOKEN,
  providerAuth: process.env.ANTHROPIC_API_KEY,
  delegationDepth: process.env.CLAUDE_DELEGATOR_CLAUDE_DEPTH
}) + "\\n");
if (process.env.CLAUDE_STUB_HANG === "1") {
  setInterval(() => {}, 1_000);
  return;
}
const isReply = args.includes("--resume");
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: isReply ? "reply result" : "start result"
};
if (!(isReply && process.env.CLAUDE_STUB_OMIT_REPLY_SESSION === "1")) {
  result.session_id = isReply ? "session-reply" : "session-start";
}
process.stdout.write(JSON.stringify(result) + "\\n");
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "claude.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "claude");
    fs.copyFileSync(scriptPath, executablePath);
    fs.chmodSync(executablePath, 0o755);
  }

  const systemBinaryPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  return {
    capturePath,
    env: {
      ...process.env,
      PATH: [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter),
      CLAUDE_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      PRESERVED_VALUE: "keep-me",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_AGENT: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-token",
      ANTHROPIC_API_KEY: "provider-auth"
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createClaudeStub();
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

  function request(method, params = {}) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for RPC response: ${stderr}`));
      }, 5_000);
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
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  function requestAndNotifyInOneWrite(method, params, notificationMethod, notificationParams) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for coalesced RPC response: ${stderr}`));
      }, 5_000);
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
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", method: notificationMethod, params: { ...notificationParams, requestId: id } })}\n`
    );
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
    request,
    requestAndNotifyInOneWrite,
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      const exited = waitForExit();
      child.stdin.end();
      return exited;
    },
    terminate() {
      const exited = waitForExit();
      child.kill("SIGTERM");
      return exited;
    }
  };
}

function readCalls(capturePath) {
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

test("advertises a uniform claude/claude-reply contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-claude");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["claude", "claude-reply"]);
  const startSchema = listed.result.tools[0].inputSchema;
  const replySchema = listed.result.tools[1].inputSchema;
  assert.equal(startSchema.properties.model.default, "claude-opus-5");
  assert.equal(startSchema.properties.effort.default, "xhigh");
  assert.deepEqual(startSchema.properties.model.enum, [
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "opus",
    "fable",
    "sonnet",
    "haiku"
  ]);
  assert.equal(startSchema.properties.timeout.minimum, 10_000);
  assert.equal(startSchema.properties.timeout.maximum, 3_600_000);
  assert.deepEqual(startSchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(startSchema.properties.sandbox.default, "workspace-write");
  assert.deepEqual(replySchema.required, ["threadId", "prompt"]);
  assert.equal(replySchema.properties.sandbox.default, "workspace-write");
  assert.equal(replySchema.properties.effort.default, undefined);
  assert.ok(startSchema.properties.coordination);
  assert.ok(replySchema.properties.coordination);
  await server.close();
});

test("starts Claude with read-only mode, coordination, and a clean nested marker", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "claude",
    arguments: {
      prompt: "Inspect the implementation",
      "developer-instructions": "Act as an architect.",
      model: "fable",
      effort: "high",
      sandbox: "read-only",
      coordination: {
        projectKey: "/workspace/project",
        callerAgentName: "codex-wsl-home-1",
        mailTopic: "delegation-1",
        checkpointIntervalSeconds: 60
      }
    }
  });

  assert.deepEqual(JSON.parse(response.result.content[0].text), { threadId: response.result.threadId, content: "start result" });
  assert.equal(response.result.threadId, "session-start");
  assert.equal(response.result.coordinationRequested, true);
  assert.equal(Object.hasOwn(response.result, "delegationId"), false);

  const [call] = readCalls(server.capturePath);
  assert.deepEqual(call.args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.ok(call.args.includes("--model"));
  assert.equal(call.args[call.args.indexOf("--model") + 1], "fable");
  assert.equal(call.args[call.args.indexOf("--effort") + 1], "high");
  assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(call.args[call.args.indexOf("--append-system-prompt") + 1], "Act as an architect.");
  assert.equal(call.args.includes("--safe-mode"), false);
  assert.equal(call.args.includes("--bare"), false);
  assert.match(call.args.at(-1), /Inspect the implementation/);
  assert.match(call.args.at(-1), /Useful native subagents are allowed/);
  assert.match(call.args.at(-1), /codex-wsl-home-1/);
  assert.match(call.args.at(-1), /"mailTopic": "delegation-1"/);
  assert.equal(call.hasClaudeCode, false);
  assert.equal(call.preservedValue, "keep-me");
  assert.equal(call.agentName, undefined);
  assert.equal(call.agentMailAgent, undefined);
  assert.equal(call.agentMailToken, undefined);
  assert.equal(call.providerAuth, "provider-auth");
  await server.close();
});

test("resumes the explicit session and retains it when Claude omits session_id", async () => {
  const server = startServer({ CLAUDE_STUB_OMIT_REPLY_SESSION: "1" });
  const response = await server.request("tools/call", {
    name: "claude-reply",
    arguments: {
      threadId: "session-original",
      prompt: "Continue the review",
      sandbox: "workspace-write",
      coordination: {
        projectKey: "/workspace/project",
        callerAgentName: "codex-wsl-home-1",
        mailTopic: "delegation-9"
      }
    }
  });

  assert.deepEqual(JSON.parse(response.result.content[0].text), { threadId: response.result.threadId, content: "reply result" });
  assert.equal(response.result.threadId, "session-original");
  assert.equal(response.result.coordinationRequested, true);
  assert.equal(Object.hasOwn(response.result, "agentMailThreadId"), false);

  const [call] = readCalls(server.capturePath);
  assert.equal(call.args[call.args.indexOf("--resume") + 1], "session-original");
  assert.equal(call.args.includes("--effort"), false);
  assert.equal(call.args.includes("--permission-mode"), false);
  assert.equal(call.args.includes("--dangerously-skip-permissions"), true);
  assert.match(call.args.at(-1), /"mailTopic": "delegation-9"/);
  assert.match(call.args.at(-1), /provider session `threadId`/);
  await server.close();
});

test("rejects invalid catalog and coordination inputs before invoking Claude", async () => {
  const server = startServer();
  const invalidModel = await server.request("tools/call", {
    name: "claude",
    arguments: { prompt: "hello", model: "claude-not-real" }
  });
  assert.equal(invalidModel.error.code, -32602);
  assert.match(invalidModel.error.message, /model/);

  const invalidCoordination = await server.request("tools/call", {
    name: "claude",
    arguments: {
      prompt: "hello",
      coordination: { projectKey: "project" }
    }
  });
  assert.equal(invalidCoordination.error.code, -32602);
  assert.match(invalidCoordination.error.message, /callerAgentName/);

  const invalidTimeout = await server.request("tools/call", {
    name: "claude",
    arguments: { prompt: "hello", timeout: 9_999 }
  });
  assert.equal(invalidTimeout.error.code, -32602);
  assert.match(invalidTimeout.error.message, /10000/);
  assert.equal(fs.existsSync(server.capturePath), false);
  await server.close();
});

test("cancels an active Claude process group and keeps the MCP server responsive", async () => {
  const server = startServer({ CLAUDE_STUB_HANG: "1" });
  const pending = server.request("tools/call", {
    name: "claude",
    arguments: { prompt: "hang until cancelled" }
  });
  await waitFor(() => fs.existsSync(server.capturePath), "Claude stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Claude process remained alive");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["claude", "claude-reply"]);
  await server.close();
});

test("handles a call and its cancellation when both frames share one stdin chunk", async () => {
  const server = startServer({ CLAUDE_STUB_HANG: "1" });
  const cancelled = await server.requestAndNotifyInOneWrite(
    "tools/call",
    { name: "claude", arguments: { prompt: "cancel this coalesced call" } },
    "notifications/cancelled",
    { reason: "same chunk" }
  );
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);

  if (fs.existsSync(server.capturePath)) {
    const [{ pid }] = readCalls(server.capturePath);
    await waitFor(() => !processIsAlive(pid), "coalesced-cancel Claude process remained alive");
  }
  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["claude", "claude-reply"]);
  await server.close();
});

test("terminating the MCP server also terminates an active Claude process group", async () => {
  const server = startServer({ CLAUDE_STUB_HANG: "1" });
  const pending = server.request("tools/call", {
    name: "claude",
    arguments: { prompt: "hang until parent shutdown" }
  }).catch(() => null);
  await waitFor(() => fs.existsSync(server.capturePath), "Claude stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  await server.terminate();
  await pending;
  await waitFor(() => !processIsAlive(pid), "Claude child survived MCP server termination");
});

test("stamps the delegation depth into the Claude child environment", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "claude",
    arguments: { prompt: "first-level delegation" }
  });

  assert.deepEqual(JSON.parse(response.result.content[0].text), { threadId: response.result.threadId, content: "start result" });
  const [call] = readCalls(server.capturePath);
  assert.equal(call.delegationDepth, "1");
  await server.close();
});

test("refuses both tools when already running inside a delegated Claude session", async () => {
  const server = startServer({ CLAUDE_DELEGATOR_CLAUDE_DEPTH: "1" });

  const started = await server.request("tools/call", {
    name: "claude",
    arguments: { prompt: "second-level delegation" }
  });
  assert.equal(started.error.code, -32603);
  assert.match(started.error.message, /Refusing to delegate/);
  assert.match(started.error.message, /CLAUDE_DELEGATOR_CLAUDE_DEPTH=1/);

  const resumed = await server.request("tools/call", {
    name: "claude-reply",
    arguments: { threadId: "session-start", prompt: "second-level reply" }
  });
  assert.equal(resumed.error.code, -32603);

  assert.equal(fs.existsSync(server.capturePath), false);

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["claude", "claude-reply"]);
  await server.close();
});

test("a non-positive or malformed depth marker does not block first-level delegation", async () => {
  for (const depth of ["0", "", "not-a-number"]) {
    const server = startServer({ CLAUDE_DELEGATOR_CLAUDE_DEPTH: depth });
    const response = await server.request("tools/call", {
      name: "claude",
      arguments: { prompt: `depth marker ${JSON.stringify(depth)}` }
    });
    assert.deepEqual(JSON.parse(response.result.content[0].text), { threadId: response.result.threadId, content: "start result" });
    assert.equal(readCalls(server.capturePath)[0].delegationDepth, "1");
    await server.close();
  }
});
