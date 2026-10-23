"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const core = require("../shared/bridge.js");
const catalog = require("../../config/model-catalog.json");
const bridge = require("./index.js");

const SERVER_PATH = path.join(__dirname, "index.js");
const CODEX = catalog.providers.codex;
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

// On Windows process.env carries `Path`; drop every case variant before setting
// the restricted value so the child cannot inherit the real one.
function withPath(source, value) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^path$/i.test(key)));
  env.PATH = value;
  return env;
}

function createCodexStub() {
  // macOS reports /var for a directory the kernel resolves to /private/var, so the cwd
  // the child reports back would never equal the path we asked for. Resolve it up front.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-test-")));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "calls.jsonl");
  const workspacePath = path.join(directory, "workspace");
  const scriptPath = path.join(directory, "codex-stub.js");
  fs.mkdirSync(workspacePath);

  // Event shapes are copied from live `codex exec --json` runs on 0.164.0.
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.164.0\\n");
  process.exit(0);
}
const separator = args.indexOf("--");
const positionals = separator === -1 ? [] : args.slice(separator + 1);
const isResume = args[0] === "exec" && args[1] === "resume";
const requestedThread = isResume ? positionals[0] : null;
const prompt = positionals.at(-1) || "";
const outputIndex = args.indexOf("-o");
const outputFile = outputIndex === -1 || outputIndex > separator ? null : args[outputIndex + 1];

fs.appendFileSync(process.env.CODEX_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args,
  outputFile,
  cwd: process.cwd(),
  hasAgentName: Object.prototype.hasOwnProperty.call(process.env, "AGENT_NAME"),
  hasAgentMailToken: Object.prototype.hasOwnProperty.call(process.env, "AGENT_MAIL_REGISTRATION_TOKEN"),
  hasHttpBearerToken: Object.prototype.hasOwnProperty.call(process.env, "HTTP_BEARER_TOKEN"),
  hasOverride: Object.keys(process.env).some((key) => key.toLowerCase() === "codex_delegator_codex_bin"),
  providerAuth: process.env.OPENAI_API_KEY,
  preservedValue: process.env.PRESERVED_VALUE,
  delegationDepth: process.env.CLAUDE_DELEGATOR_CODEX_DEPTH
}) + "\\n");

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const threadId = requestedThread || "01a0-thread-start";
if (!isResume) process.stderr.write("Reading additional input from stdin...\\n");

if (prompt.includes("TIMEOUT_FOREVER")) {
  setInterval(() => {}, 1_000);
  return;
}
if (prompt.includes("RESUME_UNKNOWN")) {
  process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id " + threadId + " (code -32600)\\n");
  process.exit(1);
}
if (prompt.includes("TURN_FAILED")) {
  const backend = JSON.stringify({
    type: "error",
    status: 400,
    error: { type: "invalid_request_error", message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." }
  });
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata for \`gpt-x\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." } });
  emit({ type: "turn.started" });
  emit({ type: "error", message: backend });
  emit({ type: "turn.failed", error: { message: backend } });
  process.exit(1);
}
emit({ type: "thread.started", thread_id: prompt.includes("WRONG_THREAD") ? "01a0-somewhere-else" : threadId });
if (prompt.includes("NO_TURN")) process.exit(0);
emit({ type: "turn.started" });
if (prompt.includes("WARN_MISMATCH")) {
  emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "This session was recorded with model \`gpt-6-luna\` but is resuming with \`gpt-6.1-sol\`." } });
}
const finalText = (isResume ? "reply" : "start") + " result\\n";
if (!prompt.includes("NO_MESSAGE")) {
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I'll look first." } });
  // RECOVERED_FINAL: the stream misses the final item, which 0.164.0 then
  // recovers from the turn snapshot into --output-last-message only.
  if (!prompt.includes("RECOVERED_FINAL")) {
    emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: finalText } });
  }
}
emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
// Codex writes the last-message file only for a completed turn, and writes it
// empty, with a warning, when the turn produced no message.
if (outputFile && !prompt.includes("NO_LAST_FILE")) {
  const lastMessage = prompt.includes("NO_MESSAGE") ? ""
    : prompt.includes("RECOVERED_FINAL") ? "recovered final answer" : finalText;
  fs.writeFileSync(outputFile, lastMessage);
  if (!lastMessage) process.stderr.write("Warning: no last agent message; wrote empty content to " + outputFile + "\\n");
}
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(directory, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
    );
  } else {
    const executablePath = path.join(directory, "codex");
    fs.copyFileSync(scriptPath, executablePath);
    fs.chmodSync(executablePath, 0o755);
  }

  const systemBinaryPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  return {
    capturePath,
    scriptPath,
    workspacePath,
    env: {
      ...withPath(process.env, [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter)),
      CODEX_STUB_CAPTURE: capturePath,
      CLAUDECODE: "nested-session-marker",
      AGENT_NAME: "CallerAgent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-agent-mail-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      OPENAI_API_KEY: "provider-auth",
      PRESERVED_VALUE: "keep-me",
      CLAUDE_DELEGATOR_CODEX_DEPTH: "",
      CODEX_DELEGATOR_CODEX_BIN: ""
    }
  };
}

function startServer(extraEnv = {}, stub = createCodexStub()) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...stub.env, ...(typeof extraEnv === "function" ? extraEnv(stub) : extraEnv) },
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
      // A reader can arrive mid-append and see a truncated final line.
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

async function callOnce(server, name, args) {
  const before = readCalls(server.capturePath).length;
  const response = await server.request("tools/call", { name, arguments: args });
  await waitFor(() => readCalls(server.capturePath).length > before, `${name} did not reach the Codex stub`);
  return { response, call: readCalls(server.capturePath)[before] };
}

function configValue(args, key) {
  const entry = args.find((arg, index) => args[index - 1] === "-c" && arg.startsWith(`${key}=`));
  return entry === undefined ? undefined : entry.slice(key.length + 1);
}

// The bridge adds `-o <private temp file>` in front of `--`. Its path is random,
// so the exact-argv assertions compare everything else.
function withoutOutputFile(args) {
  const index = args.indexOf("-o");
  assert.ok(index !== -1 && index < args.indexOf("--"), "-o must precede the option terminator");
  assert.ok(path.isAbsolute(args[index + 1]), "-o must name an absolute path");
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

test("advertises the uniform codex/codex-reply MCP contract", async () => {
  const server = startServer();
  const initialized = await server.request("initialize");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.serverInfo.name, "claude-delegator-codex");

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["codex", "codex-reply"]);
  const [startSchema, replySchema] = listed.result.tools.map((tool) => tool.inputSchema);

  assert.equal(startSchema.additionalProperties, false);
  assert.deepEqual(startSchema.required, ["prompt"]);
  assert.deepEqual(replySchema.required, ["threadId", "prompt"]);
  assert.deepEqual(startSchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(startSchema.properties.model.default, CODEX.defaultModel);
  // Free-form, like kimi and cursor: the backend rejects an unknown id itself.
  assert.equal(startSchema.properties.model.enum, undefined);
  assert.deepEqual(startSchema.properties.effort.enum, CODEX.efforts);
  assert.equal(startSchema.properties.effort.default, CODEX.defaultEffort);
  // A resume inherits neither model nor effort, so the reply advertises both
  // with the start defaults instead of omitting them like grok-reply does.
  assert.equal(replySchema.properties.model.default, CODEX.defaultModel);
  assert.equal(replySchema.properties.effort.default, CODEX.defaultEffort);
  assert.ok(startSchema.properties.coordination);
  assert.ok(replySchema.properties.coordination);
});

test("builds an exec start call with the expert prompt on Codex's own channel", async () => {
  const server = startServer();
  await server.request("initialize");

  const { response, call } = await callOnce(server, "codex", {
    prompt: "smoke",
    "developer-instructions": 'You are the Architect.\nSay "hi" \\ bye.',
    cwd: server.workspacePath
  });
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    threadId: "01a0-thread-start",
    content: "start result"
  });
  assert.equal(response.result.threadId, "01a0-thread-start");

  assert.equal(call.cwd, server.workspacePath);
  assert.deepEqual(withoutOutputFile(call.args), [
    "exec", "--json", "--skip-git-repo-check",
    "-m", CODEX.defaultModel,
    "-c", `model_reasoning_effort="${CODEX.defaultEffort}"`,
    "-c", 'sandbox_mode="danger-full-access"',
    "-c", 'approval_policy="never"',
    "-c", String.raw`developer_instructions="You are the Architect.\nSay \"hi\" \\ bye."`,
    "--", "smoke"
  ]);
  // The last-message file lives in a private directory that is gone afterwards.
  assert.equal(fs.existsSync(path.dirname(call.outputFile)), false);
});

test("answers from --output-last-message, which outranks the JSONL stream", async () => {
  const server = startServer();
  await server.request("initialize");

  // The stream carries only a progress note; 0.164.0 recovers the real answer
  // from the turn snapshot into the file alone.
  const recovered = await callOnce(server, "codex", { prompt: "RECOVERED_FINAL" });
  assert.deepEqual(JSON.parse(recovered.response.result.content[0].text), {
    threadId: "01a0-thread-start",
    content: "recovered final answer"
  });
  assert.equal(fs.existsSync(path.dirname(recovered.call.outputFile)), false);

  // Without a file, the last streamed agent message is the fallback.
  const fallback = await callOnce(server, "codex-reply", {
    threadId: "01a0-thread-start",
    prompt: "NO_LAST_FILE"
  });
  assert.equal(JSON.parse(fallback.response.result.content[0].text).content, "reply result");
});

test("re-pins model, effort and sandbox on every resume and never uses --last", async () => {
  const server = startServer();
  await server.request("initialize");

  const { response, call } = await callOnce(server, "codex-reply", {
    threadId: "01a0-thread-start",
    prompt: "again",
    cwd: server.workspacePath
  });
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    threadId: "01a0-thread-start",
    content: "reply result"
  });
  assert.equal(call.cwd, server.workspacePath);
  assert.deepEqual(withoutOutputFile(call.args), [
    "exec", "resume", "--json", "--skip-git-repo-check",
    "-m", CODEX.defaultModel,
    "-c", `model_reasoning_effort="${CODEX.defaultEffort}"`,
    "-c", 'sandbox_mode="danger-full-access"',
    "-c", 'approval_policy="never"',
    "--", "01a0-thread-start", "again"
  ]);
  assert.equal(call.args.includes("--last"), false);

  const repinned = await callOnce(server, "codex-reply", {
    threadId: "01a0-thread-start",
    prompt: "again",
    model: "gpt-6-luna",
    effort: "low",
    sandbox: "read-only"
  });
  assert.equal(repinned.call.args[repinned.call.args.indexOf("-m") + 1], "gpt-6-luna");
  assert.equal(configValue(repinned.call.args, "model_reasoning_effort"), '"low"');
  assert.equal(configValue(repinned.call.args, "sandbox_mode"), '"read-only"');
});

test("maps read-only to Codex's OS-enforced sandbox and workspace-write to full access", async () => {
  assert.deepEqual(bridge.sandboxArguments("read-only"), [
    "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'
  ]);
  for (const sandbox of ["workspace-write", undefined]) {
    assert.deepEqual(bridge.sandboxArguments(sandbox), [
      "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"'
    ]);
  }

  const server = startServer();
  await server.request("initialize");
  const { call } = await callOnce(server, "codex", { prompt: "look only", sandbox: "read-only" });
  assert.equal(configValue(call.args, "sandbox_mode"), '"read-only"');
  // `exec resume` has no -s, so neither call uses it.
  assert.equal(call.args.includes("-s"), false);
  assert.equal(call.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("clamps effort to the catalogued levels and passes unknown models through", async () => {
  assert.equal(bridge.resolveEffort("gpt-6-luna", "ultra"), "max");
  assert.equal(bridge.resolveEffort("gpt-6.1-sol", "ultra"), "ultra");
  assert.equal(bridge.resolveEffort("gpt-6-luna", undefined), "max");
  assert.equal(bridge.resolveEffort("gpt-6-luna", "low"), "low");
  assert.equal(bridge.resolveEffort("gpt-future", "ultra"), "ultra");
  assert.equal(bridge.resolveEffort(CODEX.defaultModel, undefined), CODEX.defaultEffort);

  const server = startServer();
  await server.request("initialize");
  const { call } = await callOnce(server, "codex", { prompt: "x", model: "gpt-6-luna", effort: "ultra" });
  assert.equal(call.args[call.args.indexOf("-m") + 1], "gpt-6-luna");
  assert.equal(configValue(call.args, "model_reasoning_effort"), '"max"');
});

test("keeps a prompt that opens with a dash behind the option terminator", async () => {
  const server = startServer();
  await server.request("initialize");
  const { call } = await callOnce(server, "codex", { prompt: "--help is not a flag here" });
  assert.deepEqual(call.args.slice(-2), ["--", "--help is not a flag here"]);
});

test("reports a failed turn with the backend's own reason", async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "codex",
    arguments: { prompt: "TURN_FAILED", model: "gpt-x" }
  });
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.match(text, /Codex turn failed: The 'gpt-x' model is not supported when using Codex with a ChatGPT account\. \(HTTP 400 invalid_request_error\)/);
  assert.match(text, /\(Codex warning: Model metadata for `gpt-x` not found/);
  // The escaped backend object must not reach the caller verbatim.
  assert.doesNotMatch(text, /\\"status\\"/);
});

test("surfaces stderr when a failed resume prints no JSON, without the stdin noise line", async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "codex-reply",
    arguments: { threadId: "01a0-missing", prompt: "RESUME_UNKNOWN" }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /no rollout found for thread id 01a0-missing \(code -32600\)/);
  assert.doesNotMatch(response.result.content[0].text, /Reading additional input/);
});

test("fails loudly on a different thread, a missing turn or a missing answer", async () => {
  const server = startServer();
  await server.request("initialize");

  const wrong = await server.request("tools/call", {
    name: "codex-reply",
    arguments: { threadId: "01a0-original", prompt: "WRONG_THREAD" }
  });
  assert.equal(wrong.result.isError, true);
  assert.match(wrong.result.content[0].text, /resumed a different session/);
  assert.match(wrong.result.content[0].text, /01a0-original/);

  const noTurn = await server.request("tools/call", { name: "codex", arguments: { prompt: "NO_TURN" } });
  assert.equal(noTurn.result.isError, true);
  assert.match(noTurn.result.content[0].text, /exited without completing a turn/);

  const noMessage = await server.request("tools/call", { name: "codex", arguments: { prompt: "NO_MESSAGE" } });
  assert.equal(noMessage.result.isError, true);
  assert.match(noMessage.result.content[0].text, /without a final message/);
});

test("appends Codex's own warnings to a successful answer", async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "codex-reply",
    arguments: { threadId: "01a0-thread-start", prompt: "WARN_MISMATCH" }
  });
  assert.equal(response.result.isError, undefined);
  const { content } = JSON.parse(response.result.content[0].text);
  assert.equal(
    content,
    "reply result\n\n(Codex warning: This session was recorded with model `gpt-6-luna` but is resuming with `gpt-6.1-sol`.)"
  );
});

test("scrubs the caller identity and the binary override while stamping the depth", async () => {
  const server = startServer((stub) => ({ CODEX_DELEGATOR_CODEX_BIN: stub.scriptPath }));
  await server.request("initialize");
  const { response, call } = await callOnce(server, "codex", { prompt: "env check" });
  assert.equal(response.result.isError, undefined);

  // The explicit override selected the stub's JS loader, and stayed with the bridge.
  assert.equal(call.hasOverride, false);
  assert.equal(call.hasAgentName, false);
  assert.equal(call.hasAgentMailToken, false);
  assert.equal(call.hasHttpBearerToken, false);
  assert.equal(call.providerAuth, "provider-auth");
  assert.equal(call.preservedValue, "keep-me");
  assert.equal(call.delegationDepth, "1");
});

test("refuses to delegate from inside an already delegated Codex session", async () => {
  const server = startServer({ CLAUDE_DELEGATOR_CODEX_DEPTH: "1" });
  await server.request("initialize");

  const response = await server.request("tools/call", { name: "codex", arguments: { prompt: "nested" } });
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /already running inside a delegated Codex session/);
  assert.equal(fs.existsSync(server.capturePath), false);
});

test("rejects invalid inputs before invoking Codex", async () => {
  const server = startServer();
  await server.request("initialize");

  const cases = [
    [{ name: "codex", arguments: {} }, /'prompt' is required/],
    // Codex reads a lone "-" from stdin even after `--`, and stdin is closed.
    [{ name: "codex", arguments: { prompt: "-" } }, /lone '-'/],
    [{ name: "codex-reply", arguments: { threadId: "01a0", prompt: "-" } }, /lone '-'/],
    [{ name: "codex", arguments: { prompt: "x", effort: "turbo" } }, /'effort' must be one of/],
    [{ name: "codex", arguments: { prompt: "x", model: "  " } }, /'model'/],
    [{ name: "codex", arguments: { prompt: "x", model: "--oss" } }, /'model'/],
    [{ name: "codex", arguments: { prompt: "x", sandbox: "danger-full-access" } }, /'sandbox'/],
    [{ name: "codex", arguments: { prompt: "x", timeout: 5 } }, /'timeout'/],
    [{ name: "codex", arguments: { prompt: "x", cwd: "  " } }, /'cwd'/],
    [{ name: "codex-reply", arguments: { prompt: "x" } }, /'threadId' is required/],
    [{ name: "codex-reply", arguments: { threadId: "latest", prompt: "x" } }, /explicit thread id/],
    [{ name: "nope", arguments: { prompt: "x" } }, /Unknown tool/]
  ];

  for (const [params, pattern] of cases) {
    const response = await server.request("tools/call", params);
    assert.equal(response.error.code, -32602, JSON.stringify(params));
    assert.match(response.error.message, pattern, JSON.stringify(params));
  }
  assert.equal(fs.existsSync(server.capturePath), false);
});

test("cancels an active Codex process group and keeps the MCP server responsive", async () => {
  const server = startServer();
  // No initialize first: the cancellation names requestId 1.
  const pending = server.request("tools/call", { name: "codex", arguments: { prompt: "TIMEOUT_FOREVER" } });
  await waitFor(() => readCalls(server.capturePath).length > 0, "Codex stub did not start");
  const [{ pid }] = readCalls(server.capturePath);

  server.notify("notifications/cancelled", { requestId: 1, reason: "test cancellation" });
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /Codex CLI call cancelled/);
  await waitFor(() => !processIsAlive(pid), "cancelled Codex process remained alive");

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
  await server.close();
});

test("stdin end, SIGTERM, and SIGINT each terminate an active Codex process group", async () => {
  for (const shutdownMode of ["stdin-end", "SIGTERM", "SIGINT"]) {
    const server = startServer();
    await server.request("initialize");
    server.request("tools/call", { name: "codex", arguments: { prompt: "TIMEOUT_FOREVER" } }).catch(() => {});
    await waitFor(() => readCalls(server.capturePath).length > 0, `Codex stub did not start for ${shutdownMode}`);
    const [{ pid }] = readCalls(server.capturePath);

    if (shutdownMode === "stdin-end") await server.close();
    else await server.terminate(shutdownMode);

    await waitFor(() => !processIsAlive(pid), `${shutdownMode} left the Codex process alive`, 5_000);
  }
});

test("terminates a hung Codex CLI at the requested timeout and remains responsive", { timeout: 20_000 }, async () => {
  const server = startServer();
  await server.request("initialize");

  const response = await server.request("tools/call", {
    name: "codex",
    arguments: { prompt: "TIMEOUT_FOREVER", timeout: 10_000 }
  }, 18_000);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Codex CLI timed out after 10s/);

  const listed = await server.request("tools/list");
  assert.equal(listed.result.tools.length, 2);
});

test("encodes developer instructions as a TOML basic string that always parses", () => {
  const { tomlString } = bridge;
  // JSON string syntax is a TOML basic string for everything JSON.stringify emits…
  const ordinary = 'Line one\nTab\there "quoted" \\ back\u0001ctrl zażółć';
  assert.equal(tomlString(ordinary), JSON.stringify(ordinary));
  // …except DEL, which TOML forbids raw, and lone surrogates, which TOML's \u
  // escape cannot express. Either would make Codex fall back to the raw text.
  assert.equal(tomlString("a\u007fb"), String.raw`"a\u007fb"`);
  assert.equal(tomlString("x\ud800y"), JSON.stringify("x\ufffdy"));
  assert.equal(tomlString("😀"), JSON.stringify("😀"));
});

test("unwraps backend errors and reads only the last agent message", () => {
  const { errorText, parseCodexOutput } = bridge;
  const backend = JSON.stringify({
    type: "error", status: 400, error: { type: "invalid_request_error", message: "nope" }
  });
  assert.equal(errorText(backend), "nope (HTTP 400 invalid_request_error)");
  assert.equal(errorText("  plain failure  "), "plain failure");
  assert.equal(errorText('{"unrelated":true}'), '{"unrelated":true}');
  assert.equal(errorText(undefined), "");

  const parsed = parseCodexOutput([
    "not json",
    JSON.stringify({ type: "thread.started", thread_id: " 01a0 " }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "progress" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    JSON.stringify({ type: "turn.completed", usage: {} })
  ].join("\n"));
  assert.equal(parsed.threadId, "01a0");
  assert.equal(parsed.message, "final");
  assert.equal(parsed.completed, true);
  assert.equal(parsed.failure, "");
  assert.deepEqual(parsed.warnings, []);

  assert.equal(parseCodexOutput("").threadId, "unknown");
});

test("binds the shared shim resolver to its own CLI name", () => {
  const dir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
  const node = "C:\\Program Files\\nodejs\\node.exe";
  assert.equal(
    bridge.resolveWindowsShim(`${dir}\\codex.cmd`, () => `@echo off\r\n"${node}" "%dp0%\\codex-stub.js" %*\r\n`),
    `${dir}\\codex-stub.js`
  );
  assert.throws(
    () => bridge.resolveWindowsShim(`${dir}\\codex.cmd`, () => `@echo off\r\n"${node}" "%dp0%\\other-stub.js" %*\r\n`),
    /could not resolve codex/
  );
});

test("explicit Codex override must be absolute on POSIX and Windows", () => {
  for (const [configured, isWindows] of [
    ["relative/codex.js", false],
    ["relative\\codex.cmd", true],
    ["C:drive-relative\\codex.exe", true],
    ["\\projects\\codex.exe", true],
    ["C:\\profiles\\dev\\..\\codex.exe", true],
    ["\\\\fileserver\\profiles\\dev/../codex.exe", true]
  ]) {
    assert.throws(
      () => bridge.resolveCodexBinary({
        environment: { CODEX_DELEGATOR_CODEX_BIN: configured },
        isWindows
      }),
      /must be an absolute path/
    );
  }
});

test("explicit Codex JS loaders do not need an executable bit", {
  skip: process.platform === "win32"
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-override-test-"));
  temporaryDirectories.push(directory);
  const loader = path.join(directory, "codex-loader.js");
  fs.writeFileSync(loader, "process.stdout.write('ok\\n');\n", { mode: 0o644 });
  fs.chmodSync(loader, 0o644);

  assert.equal(bridge.resolveCodexBinary({
    environment: { CODEX_DELEGATOR_CODEX_BIN: loader },
    isWindows: false
  }), loader);
  assert.equal(core.spawnTarget(loader, []).command, process.execPath);

  const native = path.join(directory, "codex-native");
  fs.writeFileSync(native, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  fs.chmodSync(native, 0o644);
  assert.throws(
    () => bridge.resolveCodexBinary({
      environment: { CODEX_DELEGATOR_CODEX_BIN: native },
      isWindows: false
    }),
    /EACCES|permission denied/i
  );
});

test("feeds the measured install locations to the shared resolver as fallbacks", () => {
  const environment = {
    LOCALAPPDATA: "C:\\Users\\mateu\\AppData\\Local",
    APPDATA: "C:\\Users\\mateu\\AppData\\Roaming"
  };
  const fallbacks = bridge.cliFallbacks({ environment, isWindows: true });
  assert.deepEqual(fallbacks, [
    "C:\\Users\\mateu\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    "C:\\Users\\mateu\\AppData\\Roaming\\npm\\codex.cmd"
  ]);
  assert.deepEqual(bridge.cliFallbacks({ environment: {}, isWindows: true }), []);
  for (const [localAppData, appData] of [
    ["relative\\local", "relative\\roaming"],
    ["\\root-relative", "C:drive-relative"],
    ["C:\\profiles\\dev\\..\\Local", "\\\\fileserver\\profiles\\dev/../Roaming"]
  ]) {
    assert.deepEqual(bridge.cliFallbacks({
      environment: { LOCALAPPDATA: localAppData, APPDATA: appData },
      isWindows: true
    }), []);
  }
  assert.deepEqual(bridge.cliFallbacks({
    environment: {
      LOCALAPPDATA: "\\\\fileserver\\profiles\\mateu\\Local",
      APPDATA: "\\\\fileserver\\profiles\\mateu\\Roaming"
    },
    isWindows: true
  }), [
    "\\\\fileserver\\profiles\\mateu\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    "\\\\fileserver\\profiles\\mateu\\Roaming\\npm\\codex.cmd"
  ]);

  // POSIX: the standalone installer's stable link, never its version-stamped
  // release directory.
  assert.deepEqual(
    bridge.cliFallbacks({ environment, home: "/home/dev", isWindows: false }),
    [path.join("/home/dev", ".local", "bin", "codex")]
  );

  let resolverCall;
  const selected = bridge.resolveCodexBinary({
    environment,
    isWindows: true,
    resolver: (command, options) => {
      resolverCall = { command, options };
      return "C:\\on-path\\codex.exe";
    }
  });
  assert.equal(selected, "C:\\on-path\\codex.exe");
  assert.deepEqual(resolverCall, { command: "codex", options: { environment, fallbacks } });

  // Native installers stay native; npm's stable .cmd is expanded to its loader.
  assert.equal(core.resolveWindowsShim(fallbacks[0], "codex"), fallbacks[0]);
  const npmShim = [
    "@ECHO off",
    '"%~dp0\\node.exe" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
  ].join("\r\n");
  assert.equal(
    core.resolveWindowsShim(fallbacks[1], "codex", () => npmShim),
    "C:\\Users\\mateu\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"
  );
});
