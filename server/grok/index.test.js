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

function createGrokStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const workspacePath = path.join(directory, "workspace");
  const scriptPath = path.join(directory, "grok-stub.js");
  fs.mkdirSync(workspacePath);

  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("grok 1.0.4 (d846eb93d9) [stable]\\n");
  process.exit(0);
}
const promptIndex = args.indexOf("-p");
const prompt = promptIndex === -1 ? "" : args[promptIndex + 1];
const resumeIndex = args.indexOf("-r");
const requestedSession = resumeIndex === -1 ? null : args[resumeIndex + 1];

fs.appendFileSync(process.env.GROK_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  cwd: process.cwd(),
  hasAgentName: Object.prototype.hasOwnProperty.call(process.env, "AGENT_NAME"),
  hasClaudeCode: Object.prototype.hasOwnProperty.call(process.env, "CLAUDECODE"),
  hasAgentMailToken: Object.prototype.hasOwnProperty.call(process.env, "AGENT_MAIL_REGISTRATION_TOKEN"),
  hasHttpBearerToken: Object.prototype.hasOwnProperty.call(process.env, "HTTP_BEARER_TOKEN"),
  preservedValue: process.env.PRESERVED_VALUE,
  delegationDepth: process.env.CLAUDE_DELEGATOR_GROK_DEPTH
}) + "\\n");

if (prompt.includes("TIMEOUT_FOREVER")) {
  setInterval(() => {}, 1_000);
  return;
}
if (prompt.includes("CLI_FAILURE")) {
  process.stderr.write("error: request failed\\n");
  process.exit(1);
}
if (prompt.includes("DENIED")) {
  // A run cut short: text stops mid-action, stopReason is cancelled, exit is 0.
  // Measured on one of three hosts running an identical denied prompt; the other
  // two finished with end_turn and reported the tool errors in full. So this is
  // the truncation shape, not the denial shape.
  process.stdout.write(JSON.stringify({
    text: "I'll write the file now.", stopReason: "cancelled", sessionId: "01a0-start"
  }) + "\\n");
  process.exit(0);
}
if (prompt.includes("NO_TEXT")) {
  process.stdout.write(JSON.stringify({ stopReason: "end_turn", sessionId: "01a0-start" }) + "\\n");
  process.exit(0);
}
if (prompt.includes("WRONG_SESSION")) {
  process.stdout.write(JSON.stringify({
    text: "fresh session", stopReason: "end_turn", sessionId: "01a0-somewhere-else"
  }) + "\\n");
  process.exit(0);
}

const suffix = requestedSession ? "reply" : "start";
// A diagnostic line can precede the object; the parser must look past it.
process.stdout.write("grok diagnostic noise that is not JSON\\n");
process.stdout.write(JSON.stringify({
  text: suffix + " result",
  stopReason: "end_turn",
  sessionId: requestedSession || "01a0-start",
  usage: { input_tokens: 10, output_tokens: 2 },
  total_cost_usd: 0.0287
}) + "\\n");
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    const shimPath = path.join(directory, "grok.cmd");
    fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, "grok");
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
      GROK_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-agent-mail-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      PRESERVED_VALUE: "keep-me",
      CLAUDE_DELEGATOR_GROK_DEPTH: ""
    }
  };
}

function startServer(extraEnv = {}) {
  const stub = createGrokStub();
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


test("advertises the uniform grok/grok-reply MCP contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-grok");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["grok", "grok-reply"]);
  const [startSchema, replySchema] = listed.result.tools.map((tool) => tool.inputSchema);

  assert.equal(startSchema.additionalProperties, false);
  assert.equal(startSchema.properties.model.default, "grok-4.6");
  assert.deepEqual(startSchema.required, ["prompt"]);
  // Unlike agy-reply, a resume needs no model re-pin: grok's -r keeps the model.
  assert.deepEqual(replySchema.required, ["threadId", "prompt"]);
  assert.equal(replySchema.properties.model, undefined);
  assert.deepEqual(startSchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  // effort is free-form on purpose: the CLI does not enumerate its values, so an
  // allowlist here would be invented rather than measured.
  assert.equal(startSchema.properties.effort.enum, undefined);
});

test("maps read-only to a denial the caller's own settings cannot relax", async () => {
  const { sandboxArguments, READ_ONLY_DENY_RULES } = require("./index.js");

  // --permission-mode plan alone was measured being defeated by a permissive
  // allow list in the caller's ~/.claude settings, which grok reads. The deny
  // rules are what make the outcome the same on every host — and hosts differ:
  // 7 rules loaded on WSL, 1 on macOS, 0 on Linux and Windows.
  const readOnly = sandboxArguments("read-only");
  assert.deepEqual(readOnly.slice(0, 2), ["--permission-mode", "plan"]);
  for (const rule of READ_ONLY_DENY_RULES) {
    assert.ok(readOnly.includes(rule), `read-only must deny ${rule}`);
    assert.equal(readOnly[readOnly.indexOf(rule) - 1], "--deny", `${rule} must follow --deny`);
  }
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.ok(READ_ONLY_DENY_RULES.includes(tool), `${tool} must be denied outright`);
    assert.ok(READ_ONLY_DENY_RULES.includes(`${tool}(*)`), `${tool}(*) must be denied too`);
  }

  assert.deepEqual(sandboxArguments("workspace-write"), ["--permission-mode", "bypassPermissions"]);
  // --sandbox is never emitted: --sandbox read-only is accepted by the CLI and
  // did not stop a write, so using it would advertise a guarantee it lacks.
  assert.equal(readOnly.includes("--sandbox"), false);
  assert.equal(sandboxArguments("workspace-write").includes("--sandbox"), false);
});

test("builds start and resume calls and always forces json output", async () => {
  const server = startServer();
  await server.request("initialize");

  const start = await server.request("tools/call", {
    name: "grok",
    arguments: {
      prompt: "smoke",
      "developer-instructions": "You are the Architect.",
      effort: "high",
      cwd: server.workspacePath
    }
  });
  assert.deepEqual(JSON.parse(start.result.content[0].text), {
    threadId: "01a0-start",
    content: "start result"
  });
  assert.equal(start.result.threadId, "01a0-start");

  await waitFor(() => readCalls(server.capturePath).length > 0, "Grok stub did not start");
  const [startCall] = readCalls(server.capturePath);
  assert.equal(startCall.cwd, server.workspacePath);
  assert.deepEqual(startCall.args.slice(-2), ["--output-format", "json"]);
  assert.equal(startCall.args[startCall.args.indexOf("-m") + 1], "grok-4.6");
  assert.equal(startCall.args[startCall.args.indexOf("--reasoning-effort") + 1], "high");
  // --verbatim stops the CLI reinterpreting a prompt that opens with something
  // it would otherwise treat as its own directive.
  assert.ok(startCall.args.includes("--verbatim"));
  assert.match(startCall.args[startCall.args.indexOf("-p") + 1], /^You are the Architect\.\n\nsmoke$/);

  const reply = await server.request("tools/call", {
    name: "grok-reply",
    arguments: { threadId: "01a0-start", prompt: "again", cwd: server.workspacePath }
  });
  assert.deepEqual(JSON.parse(reply.result.content[0].text), {
    threadId: "01a0-start",
    content: "reply result"
  });

  await waitFor(() => readCalls(server.capturePath).length > 1, "Grok reply stub did not start");
  const replyCall = readCalls(server.capturePath)[1];
  assert.equal(replyCall.args[replyCall.args.indexOf("-r") + 1], "01a0-start");
  // --continue resumes "the most recent session for the current working
  // directory" and would cross-talk between concurrent delegations sharing a cwd.
  assert.equal(replyCall.args.includes("--continue"), false);
  assert.equal(replyCall.args.includes("-c"), false);
  // A resume inherits its model; sending one would silently re-pin it.
  assert.equal(replyCall.args.includes("-m"), false);
});

test("reports an enforced denial instead of an empty answer", async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "grok",
    arguments: { prompt: "DENIED please write the file", sandbox: "read-only" }
  });

  // grok exits 0 here, so a bridge that only watched the exit code would hand
  // back a truncated answer as if the work had been considered and declined.
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled/);
  assert.match(response.result.content[0].text, /cut short/);
  assert.match(response.result.content[0].text, /workspace-write/);

  // It must NOT claim a tool was denied, and must NOT offer a mechanism either.
  // Two explanations were measured away: denial (a denial finishes the turn and
  // is reported in the text) and persistence (a rerun went 7 turns / 12 model
  // calls with 16 denials and finished cleanly, far longer than runs ending at
  // 2). The signal carries neither cause, so the message must not imply one.
  assert.doesNotMatch(response.result.content[0].text, /denied by the permission mode/);
  assert.doesNotMatch(response.result.content[0].text, /kept retrying|most often means/);
  assert.match(response.result.content[0].text, /cause is not established/);
});

test("reports CLI failures and missing text", async () => {
  const server = startServer();
  await server.request("initialize");

  const failure = await server.request("tools/call", {
    name: "grok",
    arguments: { prompt: "CLI_FAILURE" }
  });
  assert.equal(failure.result.isError, true);
  assert.match(failure.result.content[0].text, /request failed/);

  const empty = await server.request("tools/call", {
    name: "grok",
    arguments: { prompt: "NO_TEXT" }
  });
  assert.equal(empty.result.isError, true);
  assert.match(empty.result.content[0].text, /no text/i);
});

test("fails loudly when grok resumes a different session", async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "grok-reply",
    arguments: { threadId: "01a0-original", prompt: "WRONG_SESSION" }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /resumed a different session/);
  assert.match(response.result.content[0].text, /01a0-original/);
});

test("refuses to delegate from inside an already delegated grok session", async () => {
  const server = startServer({ CLAUDE_DELEGATOR_GROK_DEPTH: "1" });
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "grok",
    arguments: { prompt: "nested" }
  });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /already running inside a delegated Grok session/);
  assert.equal(fs.existsSync(server.capturePath), false);
});

test("rejects invalid inputs before invoking Grok", async () => {
  const server = startServer();
  await server.request("initialize");

  const cases = [
    [{ name: "grok", arguments: {} }, /'prompt' is required/],
    [{ name: "grok", arguments: { prompt: "x", model: "grok-9" } }, /'model' must be one of/],
    [{ name: "grok", arguments: { prompt: "x", sandbox: "danger-full-access" } }, /'sandbox'/],
    [{ name: "grok", arguments: { prompt: "x", effort: "  " } }, /'effort'/],
    [{ name: "grok", arguments: { prompt: "x", timeout: 5 } }, /'timeout'/],
    [{ name: "grok", arguments: { prompt: "x", cwd: "  " } }, /'cwd'/],
    [{ name: "grok-reply", arguments: { prompt: "x" } }, /'threadId' is required/],
    [{ name: "grok-reply", arguments: { threadId: "latest", prompt: "x" } }, /explicit session id/],
    [{ name: "nope", arguments: { prompt: "x" } }, /Unknown tool/]
  ];

  for (const [params, pattern] of cases) {
    const response = await server.request("tools/call", params);
    assert.equal(response.error.code, -32602, JSON.stringify(params));
    assert.match(response.error.message, pattern, JSON.stringify(params));
  }
  // Nothing above may reach the CLI.
  assert.equal(fs.existsSync(server.capturePath), false);
});

test("cancels an active Grok process group and keeps the MCP server responsive", async () => {
  const server = startServer();
  // No initialize first: the cancellation names requestId 1, so tools/call must
  // be the first request on this connection.
  const pending = server.request("tools/call", {
    name: "grok",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });
  await waitFor(() => readCalls(server.capturePath).length > 0, "Grok stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Grok process remained alive");

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
  await server.close();
});

test("dispatches a cancellation coalesced with tools/call and remains responsive", async () => {
  const server = startServer();
  await server.request("initialize");
  // The cancellation arrives in the same write as the call, so the server must
  // register the request before it can dispatch the notification.
  const cancelled = await server.requestAndCancelInSingleWrite("tools/call", {
    name: "grok",
    arguments: { prompt: "TIMEOUT_FOREVER" }
  });
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
  await server.close();
});

test("stdin end, SIGTERM, and SIGINT each terminate an active Grok process group", async () => {
  for (const shutdownMode of ["stdin-end", "SIGTERM", "SIGINT"]) {
    const server = startServer();
    await server.request("initialize");
    server.request("tools/call", { name: "grok", arguments: { prompt: "TIMEOUT_FOREVER" } }).catch(() => {});
    await waitFor(() => readCalls(server.capturePath).length > 0, `Grok stub did not start for ${shutdownMode}`);
    const [{ pid }] = readCalls(server.capturePath);

    if (shutdownMode === "stdin-end") await server.close();
    else await server.terminate(shutdownMode);

    await waitFor(() => !processIsAlive(pid), `${shutdownMode} left the Grok process alive`, 5_000);
  }
});

test("terminates a hung Grok CLI at the requested timeout and remains responsive", { timeout: 20_000 }, async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "grok",
    arguments: { prompt: "TIMEOUT_FOREVER", timeout: 10_000 }
  }, 18_000);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Grok CLI timed out after 10s/);

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
});

test("parses the result past a diagnostic line and rejects unusable output", () => {
  const { parseGrokOutput } = require("./index.js");

  const parsed = parseGrokOutput('grok noise\n{"text":" hi ","stopReason":"end_turn","sessionId":" 01a0 "}');
  assert.deepEqual(parsed, { response: "hi", sessionId: "01a0", stopReason: "end_turn" });

  // A missing sessionId must read as "no resume available", not crash.
  assert.equal(parseGrokOutput('{"text":"hi"}').sessionId, "unknown");
  assert.throws(() => parseGrokOutput("   "), /no output/);
  assert.throws(() => parseGrokOutput("not json at all"), /no JSON/);
  assert.throws(() => parseGrokOutput("{oops"), /unparsable JSON/);
});

test("stamps the delegation depth while scrubbing caller Agent Mail identity", () => {
  const { buildGrokEnv } = require("./index.js");
  const child = buildGrokEnv({
    AGENT_NAME: "CallerAgent",
    AGENT_MAIL_REGISTRATION_TOKEN: "caller-token",
    HTTP_BEARER_TOKEN: "caller-http-token",
    CLAUDECODE: "nested-session-marker",
    PRESERVED_VALUE: "keep-me"
  });

  assert.equal(child.CLAUDE_DELEGATOR_GROK_DEPTH, "1");
  assert.equal(child.PRESERVED_VALUE, "keep-me");
  assert.equal(Object.hasOwn(child, "AGENT_NAME"), false);
  assert.equal(Object.hasOwn(child, "AGENT_MAIL_REGISTRATION_TOKEN"), false);
  assert.equal(Object.hasOwn(child, "HTTP_BEARER_TOKEN"), false);
});

test("binds the shared shim resolver to its own CLI name", () => {
  const { resolveWindowsShim } = require("./index.js");
  const dir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
  const node = "C:\\Program Files\\nodejs\\node.exe";

  assert.equal(
    resolveWindowsShim(dir + "\\grok.cmd", () => `@echo off\r\n"${node}" "%dp0%\\grok-stub.js" %*\r\n`),
    dir + "\\grok-stub.js"
  );
  assert.throws(
    () => resolveWindowsShim(dir + "\\grok.cmd", () => `@echo off\r\n"${node}" "%dp0%\\other-stub.js" %*\r\n`),
    /could not resolve grok/
  );
});

test("accepts only fully-qualified Windows home fallback roots", () => {
  const { cliFallbacks } = require("./index.js");
  for (const home of [
    "relative\\home",
    "C:drive-relative",
    "\\root-relative",
    "C:\\profiles\\dev\\..\\Windows",
    "\\\\fileserver\\profiles\\dev/../Windows"
  ]) {
    assert.deepEqual(cliFallbacks({ home, isWindows: true }), [], home);
  }
  assert.deepEqual(cliFallbacks({ home: "C:\\Users\\dev", isWindows: true }), [
    "C:\\Users\\dev\\.grok\\bin\\grok.exe"
  ]);
  assert.deepEqual(cliFallbacks({
    home: "\\\\fileserver\\profiles\\dev",
    isWindows: true
  }), ["\\\\fileserver\\profiles\\dev\\.grok\\bin\\grok.exe"]);
});

test("falls back to the install root, not only to the convenience symlink", () => {
  const { cliFallbacks } = require("./index.js");
  const fallbacks = cliFallbacks();
  assert.ok(fallbacks.length > 0);
  for (const fallback of fallbacks) assert.ok(path.isAbsolute(fallback));

  // ~/.grok/bin is the install root on every platform measured — ~/.grok/bin/grok
  // on macOS, ~\.grok\bin\grok.exe on Windows — so it must be present on both
  // branches. This test previously asserted ~/.local/bin as the *sole* POSIX
  // entry, which was wrong: `command -v grok` answers ~/.local/bin/grok on WSL
  // only because the installer left a symlink there pointing into ~/.grok/bin.
  // A host without that link had no usable fallback at all, and the assertion
  // hid it by demanding exactly the path that made the mistake.
  const root = process.platform === "win32"
    ? path.join(".grok", "bin", "grok.exe")
    : path.join(".grok", "bin", "grok");
  assert.ok(
    fallbacks.some((f) => f.endsWith(root)),
    `${fallbacks.join(", ")} should include one ending with ${root}`
  );
  assert.ok(fallbacks[0].endsWith(root), "the real install root must be tried first");
});
