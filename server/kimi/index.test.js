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

function createKimiStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kimi-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const workspacePath = path.join(directory, "workspace");
  const scriptPath = path.join(directory, "kimi-stub.js");
  fs.mkdirSync(workspacePath);

  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("0.36.1\\n");
  process.exit(0);
}
const promptIndex = args.indexOf("-p");
const prompt = promptIndex === -1 ? "" : args[promptIndex + 1];
const sessionIndex = args.indexOf("-S");
const requestedSession = sessionIndex === -1 ? null : args[sessionIndex + 1];

fs.appendFileSync(process.env.KIMI_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  cwd: process.cwd(),
  hasAgentName: Object.prototype.hasOwnProperty.call(process.env, "AGENT_NAME"),
  hasClaudeCode: Object.prototype.hasOwnProperty.call(process.env, "CLAUDECODE"),
  hasAgentMailToken: Object.prototype.hasOwnProperty.call(process.env, "AGENT_MAIL_REGISTRATION_TOKEN"),
  hasHttpBearerToken: Object.prototype.hasOwnProperty.call(process.env, "HTTP_BEARER_TOKEN"),
  preservedValue: process.env.PRESERVED_VALUE,
  delegationDepth: process.env.CLAUDE_DELEGATOR_KIMI_DEPTH
}) + "\\n");

if (prompt.includes("TIMEOUT_FOREVER")) {
  setInterval(() => {}, 1_000);
  return;
}
if (prompt.includes("CLI_FAILURE")) {
  // Real kimi shape for an unknown model: version banner on stdout, error on stderr.
  process.stdout.write(JSON.stringify({ role: "meta", type: "system.version", version: "0.36.1" }) + "\\n");
  process.stderr.write('error: failed to run prompt: Model "NOPE" is not configured in config.toml.\\n');
  process.exit(1);
}
if (prompt.includes("NO_ASSISTANT")) {
  process.stdout.write(JSON.stringify({ role: "meta", type: "system.version", version: "0.36.1" }) + "\\n");
  process.exit(0);
}
if (prompt.includes("WRONG_SESSION")) {
  process.stdout.write(JSON.stringify({ role: "assistant", content: "fresh session" }) + "\\n");
  process.stdout.write(JSON.stringify({
    role: "meta", type: "session.resume_hint", session_id: "session_somewhere_else"
  }) + "\\n");
  process.exit(0);
}

const suffix = requestedSession ? "reply" : "start";
process.stdout.write(JSON.stringify({ role: "meta", type: "system.version", version: "0.36.1" }) + "\\n");
process.stdout.write("kimi diagnostic noise that is not JSON\\n");
// Assistant content may arrive in several events and must be concatenated.
process.stdout.write(JSON.stringify({ role: "assistant", content: suffix + " result" }) + "\\n");
process.stdout.write(JSON.stringify({ role: "assistant", content: " continued" }) + "\\n");
process.stdout.write(JSON.stringify({
  role: "meta",
  type: "session.resume_hint",
  session_id: requestedSession || ("session_" + suffix)
}) + "\\n");
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "kimi.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "kimi");
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
      KIMI_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-agent-mail-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      PRESERVED_VALUE: "keep-me",
      CLAUDE_DELEGATOR_KIMI_DEPTH: ""
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createKimiStub();
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
  let raw;
  try {
    raw = fs.readFileSync(capturePath, "utf8");
  } catch {
    return []; // The stub has not created the file yet.
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line)];
    } catch (error) {
      // The stub creates the file and appends to it in two steps, so a reader
      // can arrive mid-write and see a truncated final line. Tolerate that one;
      // an unparseable line anywhere else is real corruption and must not pass.
      if (index === lines.length - 1) return [];
      throw error;
    }
  });
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

test("advertises the uniform kimi/kimi-reply MCP contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-kimi");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["kimi", "kimi-reply"]);
  const startSchema = listed.result.tools[0].inputSchema;
  const replySchema = listed.result.tools[1].inputSchema;
  assert.equal(startSchema.additionalProperties, false);
  assert.equal(startSchema.properties.model.default, "moonshot-ai/kimi-k3");
  // The roster is user-extensible via `kimi provider catalog`, so no hard enum.
  assert.equal(startSchema.properties.model.enum, undefined);
  assert.ok(startSchema.properties.model.examples.includes("moonshot-ai/kimi-k2.7-code"));
  assert.equal(startSchema.properties.timeout.minimum, 10_000);
  assert.equal(startSchema.properties.timeout.maximum, 3_600_000);
  assert.equal(startSchema.properties.timeout.default, 900_000);
  // kimi has no effort flag; reasoning depth is the config.toml [thinking] toggle.
  assert.equal(startSchema.properties.effort, undefined);
  assert.deepEqual(replySchema.required, ["threadId", "prompt"]);
  assert.ok(startSchema.properties.coordination);
  await server.close();
});

test("builds start and resume calls and always forces stream-json", async () => {
  const server = startServer();
  const coordination = {
    projectKey: "/workspace/project",
    callerAgentName: "codex-wsl-home-1",
    mailTopic: "kimi-delegation-1",
    checkpointIntervalSeconds: 120
  };

  const start = await server.request("tools/call", {
    name: "kimi",
    arguments: {
      prompt: "Inspect the implementation",
      "developer-instructions": "Act as an architect.",
      model: "moonshot-ai/kimi-k2.6",
      cwd: server.workspacePath,
      coordination
    }
  });
  // Assistant content arrives in several events and must be concatenated.
  assert.deepEqual(JSON.parse(start.result.content[0].text), {
    threadId: "session_start",
    content: "start result continued"
  });
  assert.equal(start.result.threadId, "session_start");
  assert.equal(start.result.coordinationRequested, true);

  const reply = await server.request("tools/call", {
    name: "kimi-reply",
    arguments: { threadId: "session_original", prompt: "Continue the review" }
  });
  assert.equal(reply.result.threadId, "session_original");
  assert.deepEqual(JSON.parse(reply.result.content[0].text), {
    threadId: "session_original",
    content: "reply result continued"
  });

  const [startCall, replyCall] = readCalls(server.capturePath);
  for (const call of [startCall, replyCall]) {
    assert.deepEqual(call.args.slice(-2), ["--output-format", "stream-json"]);
    // --continue would resume "the previous session for the working directory",
    // which cross-talks between concurrent delegations sharing a cwd.
    assert.equal(call.args.includes("--continue"), false);
    assert.equal(call.args.includes("-c"), false);
    // These are all rejected by kimi when combined with --prompt.
    assert.equal(call.args.includes("--plan"), false);
    assert.equal(call.args.includes("-y"), false);
    assert.equal(call.args.includes("--auto"), false);
    assert.equal(call.delegationDepth, "1");
    assert.equal(call.hasClaudeCode, false);
    assert.equal(call.hasAgentName, false);
    assert.equal(call.hasAgentMailToken, false);
    assert.equal(call.hasHttpBearerToken, false);
    assert.equal(call.preservedValue, "keep-me");
  }

  assert.equal(startCall.args[startCall.args.indexOf("-m") + 1], "moonshot-ai/kimi-k2.6");
  assert.equal(startCall.cwd, server.workspacePath);
  const startPrompt = startCall.args[startCall.args.indexOf("-p") + 1];
  assert.match(startPrompt, /^Act as an architect\.\n\nInspect the implementation/);
  assert.match(startPrompt, /Optional MCP Agent Mail Coordination/);
  assert.match(startPrompt, /"callerAgentName": "codex-wsl-home-1"/);

  assert.equal(replyCall.args[replyCall.args.indexOf("-S") + 1], "session_original");
  // No model override was requested, so the resumed session keeps its own.
  assert.equal(replyCall.args.includes("-m"), false);
  await server.close();
});

test("refuses read-only rather than advertising a tier kimi cannot enforce", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "kimi",
    arguments: { prompt: "Review this", sandbox: "read-only" }
  });

  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /not supported by Kimi/);
  assert.match(response.error.message, /no permission tier/);
  // Nothing was spawned: the refusal happens before the CLI is invoked.
  assert.deepEqual(readCalls(server.capturePath), []);

  const allowed = await server.request("tools/call", {
    name: "kimi",
    arguments: { prompt: "Review this", sandbox: "workspace-write" }
  });
  assert.equal(allowed.result.threadId, "session_start");
  await server.close();
});

test("reports CLI failures and missing assistant output", async () => {
  const server = startServer();

  const cliFailure = await server.request("tools/call", {
    name: "kimi",
    arguments: { prompt: "CLI_FAILURE" }
  });
  assert.equal(cliFailure.result.isError, true);
  assert.match(cliFailure.result.content[0].text, /is not configured in config\.toml/);

  const noAssistant = await server.request("tools/call", {
    name: "kimi",
    arguments: { prompt: "NO_ASSISTANT" }
  });
  assert.equal(noAssistant.result.isError, true);
  assert.match(noAssistant.result.content[0].text, /no assistant output/);
  await server.close();
});

test("fails loudly when kimi resumes a different session", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "kimi-reply",
    arguments: { threadId: "session_expired", prompt: "WRONG_SESSION" }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /resumed a different session/);
  assert.match(response.result.content[0].text, /session_somewhere_else/);
  await server.close();
});

test("refuses to delegate from inside an already delegated kimi session", async () => {
  const server = startServer({ CLAUDE_DELEGATOR_KIMI_DEPTH: "1" });
  for (const name of ["kimi", "kimi-reply"]) {
    const response = await server.request("tools/call", {
      name,
      arguments: { threadId: "session_x", prompt: "hello" }
    });
    assert.equal(response.error.code, -32603);
    assert.match(response.error.message, /already running inside a delegated Kimi session/);
  }
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("rejects invalid inputs before invoking Kimi", async () => {
  const server = startServer();
  const invalidCases = [
    [{ name: "kimi", arguments: { prompt: "hello", sandbox: "unsafe" } }, /sandbox/],
    [{ name: "kimi", arguments: { prompt: "hello", timeout: 9_999 } }, /timeout/],
    [{ name: "kimi", arguments: { prompt: "hello", timeout: 3_600_001 } }, /timeout/],
    [{ name: "kimi", arguments: { prompt: " " } }, /prompt/],
    [{ name: "kimi", arguments: { prompt: "hello", model: " " } }, /model/],
    [{ name: "kimi", arguments: { prompt: "hello", cwd: " " } }, /cwd/],
    [{ name: "kimi", arguments: { prompt: "hello", "developer-instructions": 7 } }, /developer-instructions/],
    [{ name: "kimi-reply", arguments: { threadId: "latest", prompt: "hello" } }, /explicit session id/],
    [{ name: "kimi-reply", arguments: { threadId: "session", prompt: " " } }, /prompt/],
    [{
      name: "kimi",
      arguments: {
        prompt: "hello",
        coordination: { projectKey: "project", mailTopic: "kimi-delegation-1" }
      }
    }, /callerAgentName/],
    [{ name: "not-kimi", arguments: { prompt: "hello" } }, /Unknown tool/]
  ];

  for (const [params, messagePattern] of invalidCases) {
    const response = await server.request("tools/call", params);
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, messagePattern);
  }
  assert.deepEqual(readCalls(server.capturePath), []);
  await server.close();
});

test("cancels an active Kimi process group and keeps the MCP server responsive", async () => {
  const server = startServer();
  const pending = server.request("tools/call", {
    name: "kimi",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });
  await waitFor(() => readCalls(server.capturePath).length > 0, "Kimi stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Kimi process remained alive");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["kimi", "kimi-reply"]);
  await server.close();
});

test("dispatches a cancellation coalesced with tools/call and remains responsive", async () => {
  const server = startServer();
  const cancelled = await server.requestAndCancelInSingleWrite("tools/call", {
    name: "kimi",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });

  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  for (const { pid } of readCalls(server.capturePath)) {
    await waitFor(() => !processIsAlive(pid), "coalesced cancellation left Kimi alive");
  }
  await server.close();
});

test("stdin end, SIGTERM, and SIGINT each terminate an active Kimi process group", async () => {
  for (const shutdownMode of ["stdin-end", "SIGTERM", "SIGINT"]) {
    const server = startServer();
    const pending = server.request("tools/call", {
      name: "kimi",
      arguments: { prompt: "TIMEOUT_FOREVER" }
    }).catch(() => null);
    await waitFor(() => readCalls(server.capturePath).length > 0, `Kimi stub did not start for ${shutdownMode}`);
    const [{ pid }] = readCalls(server.capturePath);

    if (shutdownMode === "stdin-end") {
      await server.close();
    } else {
      await server.terminate(shutdownMode);
    }
    await pending;
    await waitFor(
      () => !processIsAlive(pid),
      `Kimi child survived MCP server shutdown via ${shutdownMode}`
    );
  }
});

test("terminates a hung Kimi CLI at the requested timeout and remains responsive", { timeout: 20_000 }, async () => {
  const server = startServer();
  const startedAt = Date.now();
  const response = await server.request("tools/call", {
    name: "kimi",
    arguments: { prompt: "TIMEOUT_FOREVER", timeout: 10_000 }
  }, 15_000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Kimi CLI timed out after 10s/);
  assert.ok(elapsedMs >= 9_000, `timeout fired too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 14_000, `timeout fired too late after ${elapsedMs}ms`);
  await server.close();
});

test("parses JSONL past non-JSON noise and concatenates assistant events", () => {
  const stdout = [
    JSON.stringify({ role: "meta", type: "system.version", version: "0.36.1" }),
    "plain terminal noise",
    JSON.stringify({ role: "assistant", content: "first" }),
    JSON.stringify({ role: "assistant", content: " second" }),
    JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_abc" })
  ].join("\n");

  assert.deepEqual(bridge.parseKimiOutput(stdout), {
    response: "first second",
    sessionId: "session_abc"
  });

  assert.deepEqual(bridge.parseKimiOutput(""), { response: "", sessionId: "unknown" });
});

test("stamps the delegation depth while scrubbing caller Agent Mail identity", () => {
  const env = bridge.buildKimiEnv({
    PATH: "/usr/bin",
    AGENT_NAME: "CallerAgent",
    AGENT_MAIL_REGISTRATION_TOKEN: "secret",
    PRESERVED_VALUE: "keep-me"
  });
  assert.equal(env.CLAUDE_DELEGATOR_KIMI_DEPTH, "1");
  assert.equal(env.PRESERVED_VALUE, "keep-me");
  assert.equal(env.AGENT_NAME, undefined);
  assert.equal(env.AGENT_MAIL_REGISTRATION_TOKEN, undefined);

  const nested = bridge.buildKimiEnv({ CLAUDE_DELEGATOR_KIMI_DEPTH: "1" });
  assert.equal(nested.CLAUDE_DELEGATOR_KIMI_DEPTH, "2");
});

test("accepts only fully-qualified Windows home fallback roots", () => {
  for (const home of ["relative\\home", "C:drive-relative", "\\root-relative"]) {
    assert.deepEqual(bridge.cliFallbacks({ home, isWindows: true }), [], home);
  }
  assert.deepEqual(bridge.cliFallbacks({
    home: "C:\\Users\\dev",
    isWindows: true
  }), [
    "C:\\Users\\dev\\.kimi-code\\bin\\kimi.exe",
    "C:\\Users\\dev\\.kimi-code\\bin\\kimi.cmd"
  ]);
  assert.deepEqual(bridge.cliFallbacks({
    home: "\\\\fileserver\\profiles\\dev",
    isWindows: true
  }), [
    "\\\\fileserver\\profiles\\dev\\.kimi-code\\bin\\kimi.exe",
    "\\\\fileserver\\profiles\\dev\\.kimi-code\\bin\\kimi.cmd"
  ]);
});

test("binds the shared shim resolver to its own CLI name", () => {
  // The shim shapes themselves are covered once, in server/shared/bridge.test.js.
  // What is per-bridge is only which command name gets baked in, and that is what
  // makes a mismatched shim fail loudly instead of resolving to another CLI.
  const dir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
  const shimPath = dir + "\\kimi.cmd";
  const script = dir + "\\kimi-stub.js";
  const node = "C:\\Program Files\\nodejs\\node.exe";

  assert.equal(
    bridge.resolveWindowsShim(shimPath, () => `@echo off\r\n"${node}" "%dp0%\\kimi-stub.js" %*\r\n`),
    script
  );
  assert.throws(
    () => bridge.resolveWindowsShim(shimPath, () => `@echo off\r\n"${node}" "%dp0%\\other-stub.js" %*\r\n`),
    /could not resolve kimi/
  );
});
