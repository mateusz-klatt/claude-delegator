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

function createCursorStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const workspacePath = path.join(directory, "workspace");
  // Must contain the command name: resolveWindowsShim only accepts a quoted
  // target whose path contains "cursor-agent" (or the "agent" alias), so a stub
  // called cursor-stub.js makes the resolver throw and the server exit before it
  // serves anything. That is invisible on POSIX, where the stub is copied to a
  // file literally named cursor-agent and the shim path is never taken.
  const scriptPath = path.join(directory, "cursor-agent-stub.js");
  fs.mkdirSync(workspacePath);

  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2026.08.11-e8db854\\n");
  process.exit(0);
}
const promptIndex = args.indexOf("-p");
const prompt = promptIndex === -1 ? "" : args[promptIndex + 1];
const resumeIndex = args.indexOf("--resume");
const requestedSession = resumeIndex === -1 ? null : args[resumeIndex + 1];

fs.appendFileSync(process.env.CURSOR_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  cwd: process.cwd(),
  hasAgentName: Object.prototype.hasOwnProperty.call(process.env, "AGENT_NAME"),
  hasClaudeCode: Object.prototype.hasOwnProperty.call(process.env, "CLAUDECODE"),
  hasAgentMailToken: Object.prototype.hasOwnProperty.call(process.env, "AGENT_MAIL_REGISTRATION_TOKEN"),
  hasHttpBearerToken: Object.prototype.hasOwnProperty.call(process.env, "HTTP_BEARER_TOKEN"),
  preservedValue: process.env.PRESERVED_VALUE,
  delegationDepth: process.env.CLAUDE_DELEGATOR_CURSOR_DEPTH
}) + "\\n");

if (prompt.includes("TIMEOUT_FOREVER")) {
  setInterval(() => {}, 1_000);
  return;
}
if (prompt.includes("REJECTED_MODEL")) {
  // A rejected model: exit 1, and NOT json despite --output-format json.
  process.stdout.write("ActionRequiredError: Named models unavailable Free plans can only use Auto.\\n");
  process.exit(1);
}
if (prompt.includes("CONNECTION_LOST")) {
  // The dangerous one: a transient backend failure exits ZERO and prints no JSON.
  // A bridge that trusted the exit code would report this as an empty success.
  process.stdout.write("Connection lost, reconnecting to https://agentn.example (attempt 1)\\n");
  process.exit(0);
}
if (prompt.includes("IS_ERROR")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "error_during_execution", is_error: true,
    result: "the agent failed mid-run", session_id: "sess-start"
  }) + "\\n");
  process.exit(0);
}
if (prompt.includes("NO_TEXT")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: "sess-start"
  }) + "\\n");
  process.exit(0);
}
if (prompt.includes("WRONG_SESSION")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: "fresh session", session_id: "sess-somewhere-else"
  }) + "\\n");
  process.exit(0);
}

const suffix = requestedSession ? "reply" : "start";
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 4108,
  result: suffix + " result",
  session_id: requestedSession || "sess-start",
  request_id: "req-1",
  usage: { inputTokens: 10, outputTokens: 2 }
}) + "\\n");
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "cursor-agent.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "cursor-agent");
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
      CURSOR_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-agent-mail-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      PRESERVED_VALUE: "keep-me",
      CLAUDE_DELEGATOR_CURSOR_DEPTH: ""
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createCursorStub();
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



test("advertises the uniform cursor/cursor-reply MCP contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-cursor");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["cursor", "cursor-reply"]);

  const [start, reply] = listed.result.tools;
  assert.deepEqual(start.inputSchema.required, ["prompt"]);
  assert.deepEqual(reply.inputSchema.required, ["threadId", "prompt"]);

  // Free-form, not an enum: the CLI documents bracket-parameterised overrides
  // like 'claude-opus-4-8[context=1m,effort=high,fast=false]' that an allowlist
  // could not express. This is kimi's shape, not grok's.
  assert.equal(start.inputSchema.properties.model.type, "string");
  assert.equal(start.inputSchema.properties.model.enum, undefined);
  // The reasoning tier is baked into the model id, exactly as on agy, so there
  // is no effort knob to expose.
  assert.equal(start.inputSchema.properties.effort, undefined);
  assert.equal(reply.inputSchema.properties.effort, undefined);
  assert.equal(reply.inputSchema.properties.model, undefined);
});

test("maps read-only to a mode that deflects, and never to one that lies", async () => {
  const { sandboxArguments } = require("./index.js");

  assert.deepEqual(sandboxArguments("read-only"), ["--mode", "ask"]);
  assert.deepEqual(sandboxArguments("workspace-write"), ["--force"]);

  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  // --mode plan promises "no edits" in its own help text and wrote the file on
  // the first insistent prompt once workspace trust was granted.
  assert.doesNotMatch(source, /"plan"/);
  // --sandbox is accepted by the CLI and did not stop a workspace write, which
  // is the same trap agy's --mode plan set.
  assert.doesNotMatch(source, /"--sandbox"/);
  // --add-dir widens rules discovery; cwd alone already grants file access.
  assert.doesNotMatch(source, /"--add-dir"/);
  // --continue resumes "the previous session for the working directory" and
  // would cross-talk between concurrent delegations sharing a cwd.
  assert.doesNotMatch(source, /"--continue"/);
});

test("builds start and resume calls, always trusting the workspace", async () => {
  const server = startServer();
  const started = await server.request("tools/call", {
    name: "cursor",
    arguments: {
      prompt: "review this",
      "developer-instructions": "You are the Architect.",
      model: "composer-2.5-fast",
      cwd: server.workspacePath
    }
  });
  assert.equal(started.result.isError, undefined);
  assert.match(started.result.content[0].text, /start result/);

  const replied = await server.request("tools/call", {
    name: "cursor-reply",
    arguments: { threadId: "sess-start", prompt: "and now the tests", cwd: server.workspacePath }
  });
  assert.match(replied.result.content[0].text, /reply result/);

  const [startCall, replyCall] = readCalls(server.capturePath);

  assert.deepEqual(startCall.args.slice(0, 4), ["--model", "composer-2.5-fast", "--trust", "--force"]);
  assert.equal(startCall.args.at(-2), "--output-format");
  assert.equal(startCall.args.at(-1), "json");
  assert.match(startCall.args[startCall.args.indexOf("-p") + 1], /You are the Architect\./);
  assert.equal(startCall.cwd, server.workspacePath);

  // --trust is MANDATORY, not defensive: without it the CLI prints "Workspace
  // Trust Required" and exits 0 having executed nothing, which is
  // indistinguishable from a permission mode denying the task. Passing it on
  // both branches keeps `sandbox` the only variable between them.
  assert.ok(startCall.args.includes("--trust"));
  assert.ok(replyCall.args.includes("--trust"));

  assert.deepEqual(replyCall.args.slice(0, 4), ["--resume", "sess-start", "--trust", "--force"]);
  // Deviation asserted here rather than in the core: a cursor resume INHERITS
  // the model it started with, verified by starting on `auto` while the
  // configured default was composer-2.5-fast and observing no fallback. agy is
  // the opposite and its reply tool must re-pin the model; a shared test could
  // satisfy neither.
  assert.equal(replyCall.args.includes("--model"), false);
});

test("read-only reaches the CLI as ask mode on both tools", async () => {
  const server = startServer();
  await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "advise only", sandbox: "read-only", cwd: server.workspacePath }
  });
  await server.request("tools/call", {
    name: "cursor-reply",
    arguments: { threadId: "sess-start", prompt: "still advising", sandbox: "read-only", cwd: server.workspacePath }
  });

  for (const call of readCalls(server.capturePath)) {
    assert.equal(call.args[call.args.indexOf("--mode") + 1], "ask");
    assert.equal(call.args.includes("--force"), false);
  }
});

test("does not trust the exit code, because the CLI does not classify by it", async () => {
  const server = startServer();

  // Exit 1 with no JSON: a rejected model, reported before any work happens.
  const rejected = await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "REJECTED_MODEL", cwd: server.workspacePath }
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /Named models unavailable/);

  // Exit ZERO with no JSON: a transient backend failure. This is the one that
  // matters — a bridge keying off the exit code would hand the caller a
  // successful-looking empty answer for a run that never happened.
  const dropped = await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "CONNECTION_LOST", cwd: server.workspacePath }
  });
  assert.equal(dropped.result.isError, true);
  assert.match(dropped.result.content[0].text, /Connection lost/);

  // Exit zero WITH json, but is_error set.
  const failed = await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "IS_ERROR", cwd: server.workspacePath }
  });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /failed mid-run/);

  const empty = await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "NO_TEXT", cwd: server.workspacePath }
  });
  assert.equal(empty.result.isError, true);
});

test("fails loudly when Cursor resumes a different session", async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "cursor-reply",
    arguments: { threadId: "WRONG_SESSION", prompt: "WRONG_SESSION", cwd: server.workspacePath }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /resumed a different session/);
});

test("parses one JSON object and tolerates nothing that is not one", () => {
  const { parseCursorOutput } = require("./index.js");

  const object = '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s1"}';
  const parsed = parseCursorOutput(object + "\n");
  assert.deepEqual(parsed, { isError: false, response: "hi", sessionId: "s1", subtype: "success" });

  // Noise on EITHER side of the object. cursor-agent prints bare status lines --
  // "Connection lost, reconnecting to ... (attempt 1)" was measured as one -- and
  // an earlier version sliced from the first "{" to the end of stdout, which
  // survived a line before the result and broke on anything after it. That
  // turned a completed run into a reported failure and threw away the session_id
  // with it, so the caller could not even resume.
  const expected = { isError: false, response: "hi", sessionId: "s1", subtype: "success" };
  assert.deepEqual(parseCursorOutput("Connection lost, reconnecting (attempt 1)\n" + object), expected);
  assert.deepEqual(parseCursorOutput(object + "\nSome trailing warning"), expected);
  assert.deepEqual(parseCursorOutput("warn before\n" + object + "\nwarn after"), expected);

  // Not-JSON is a null, not a throw: the caller decides what the absence means,
  // and both non-JSON shapes (exit 1 and exit 0) reach that decision together.
  assert.equal(parseCursorOutput(""), null);
  assert.equal(parseCursorOutput("Connection lost, reconnecting\n"), null);
  assert.equal(parseCursorOutput("{ not json"), null);
  assert.equal(parseCursorOutput("[1,2,3]"), null);
});

test("refuses to delegate from inside an already delegated Cursor session", async () => {
  const server = startServer({ CLAUDE_DELEGATOR_CURSOR_DEPTH: "1" });
  const response = await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "delegate further", cwd: server.workspacePath }
  });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /already running inside a delegated Cursor session/);
});

test("severs caller identity but preserves unrelated environment", async () => {
  const server = startServer();
  await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "check the environment", cwd: server.workspacePath }
  });

  const [call] = readCalls(server.capturePath);
  assert.equal(call.hasAgentName, false);
  assert.equal(call.hasClaudeCode, false);
  assert.equal(call.hasAgentMailToken, false);
  assert.equal(call.hasHttpBearerToken, false);
  assert.equal(call.preservedValue, "keep-me");
  assert.equal(call.delegationDepth, "1");
});

test("rejects invalid inputs before invoking Cursor", async () => {
  const server = startServer();
  const cases = [
    [{ name: "cursor", arguments: {} }, /'prompt' is required/],
    [{ name: "cursor", arguments: { prompt: "x", model: "" } }, /'model' must be a non-empty string/],
    [{ name: "cursor", arguments: { prompt: "x", sandbox: "danger-full-access" } }, /sandbox/i],
    [{ name: "cursor-reply", arguments: { prompt: "x" } }, /'threadId' is required/],
    [{ name: "cursor-reply", arguments: { threadId: "latest", prompt: "x" } }, /explicit session id/],
    [{ name: "nope", arguments: { prompt: "x" } }, /Unknown tool/]
  ];
  for (const [params, expected] of cases) {
    const response = await server.request("tools/call", params);
    assert.match(response.error.message, expected, JSON.stringify(params));
  }
  assert.deepEqual(readCalls(server.capturePath), []);
});

test("falls back to the stable launcher and never to a versioned path", () => {
  const { cliFallbacks } = require("./index.js");
  const fallbacks = cliFallbacks();

  if (process.platform === "win32") {
    // Deliberately empty: cursor-agent's Windows install directory has not been
    // measured on any host here, and a guess is the WinGet\Packages mistake
    // removed in 1.7.0. PATH still finds it wherever the installer put it.
    assert.deepEqual(fallbacks, []);
    return;
  }

  assert.deepEqual(fallbacks, [path.join(os.homedir(), ".local", "bin", "cursor-agent")]);
  // ~/.local/bin/cursor-agent is a symlink into
  // ~/.local/share/cursor-agent/versions/<version>/. Only the stable name is a
  // fallback; recording the target would produce a list correct on exactly one
  // machine until Cursor next updates.
  for (const fallback of fallbacks) {
    assert.doesNotMatch(fallback, /versions/);
    assert.ok(path.isAbsolute(fallback));
  }
});

test("expands the Windows shim to the PowerShell script it wraps", () => {
  const { resolveWindowsShim } = require("./index.js");
  const dir = "C:\\Users\\mateu\\AppData\\Local\\cursor-agent";

  // Verbatim from a Windows host, like test/fixtures/copilot.cmd. It differs from
  // that one in every way that touches the resolver, which is why a reconstruction
  // was not good enough: it names its directory SCRIPT_DIR rather than dp0, it
  // STRIPS the trailing backslash before use, and its target is a .ps1 that cannot
  // be spawned as an image at all rather than a .js that node can run.
  const shim = fs.readFileSync(
    path.join(__dirname, "..", "..", "test", "fixtures", "cursor-agent.cmd"),
    "utf8"
  );

  assert.equal(
    resolveWindowsShim(`${dir}\\cursor-agent.cmd`, () => shim),
    `${dir}\\cursor-agent.ps1`
  );

  // The stripping is why this must be a real capture. SCRIPT_DIR holds no trailing
  // separator by the time it is used, and the shim supplies its own -- so an
  // expansion that appends one would produce a doubled backslash, and one that
  // assumed the variable still carried it would produce none.
  const resolved = resolveWindowsShim(`${dir}\\cursor-agent.cmd`, () => shim);
  assert.doesNotMatch(resolved, /\\\\/);
  assert.doesNotMatch(resolved, /%[A-Za-z_]/);

  // Windows installs it CRLF; git may hand it back either way depending on
  // autocrlf, and neither may change the answer.
  assert.equal(
    resolveWindowsShim(`${dir}\\cursor-agent.cmd`, () => shim.replace(/\n/g, "\r\n")),
    `${dir}\\cursor-agent.ps1`
  );
});

test("cancels an active Cursor process group and keeps the MCP server responsive", async () => {
  const server = startServer();
  // No initialize first: the cancellation names requestId 1, so tools/call must
  // be the first request on this connection.
  const pending = server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "TIMEOUT_FOREVER", cwd: server.workspacePath }
  });
  await waitFor(() => readCalls(server.capturePath).length > 0, "Cursor stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Cursor process remained alive");

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
  await server.close();
});

test("dispatches a cancellation coalesced with tools/call and remains responsive", async () => {
  const server = startServer();
  await server.request("initialize");
  // Deliberately does NOT assert the stub started. When the cancellation arrives
  // in the same write as the call, the abort can land before spawn — that is a
  // correct outcome, not a missed kill, and asserting a child pid here made this
  // test fail for the one reason it was not testing.
  const cancelled = await server.requestAndCancelInSingleWrite("tools/call", {
    name: "cursor",
    arguments: { prompt: "TIMEOUT_FOREVER", cwd: server.workspacePath }
  });
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
  await server.close();
});

test("terminates a hung Cursor CLI at the requested timeout", { timeout: 20_000 }, async () => {
  const server = startServer();
  const response = await server.request("tools/call", {
    name: "cursor",
    arguments: { prompt: "TIMEOUT_FOREVER", cwd: server.workspacePath, timeout: 10_000 }
  }, 15_000);

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /timed out|timeout/i);

  await waitFor(() => readCalls(server.capturePath).length > 0, "stub never started");
  const [call] = readCalls(server.capturePath);
  await waitFor(() => !processIsAlive(call.pid), "child survived the timeout");
});

test("stdin end and SIGTERM each terminate an active Cursor process group", async () => {
  for (const stop of ["stdin", "SIGTERM"]) {
    const server = startServer();
    server.request("tools/call", {
      name: "cursor",
      arguments: { prompt: "TIMEOUT_FOREVER", cwd: server.workspacePath }
    }).catch(() => {});

    await waitFor(() => readCalls(server.capturePath).length > 0, `stub never started (${stop})`);
    const [call] = readCalls(server.capturePath);

    await (stop === "stdin" ? server.close() : server.terminate("SIGTERM"));
    await waitFor(() => !processIsAlive(call.pid), `child survived ${stop}`);
  }
});
