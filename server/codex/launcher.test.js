"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const LAUNCHER_PATH = path.join(__dirname, "launcher.js");
const temporaryDirectories = [];
const runningLaunchers = new Set();

afterEach(() => {
  for (const launcher of runningLaunchers) launcher.kill();
  runningLaunchers.clear();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

function createCodexStub() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-test-"));
  temporaryDirectories.push(directory);
  const capturePath = path.join(directory, "capture.json");
  const scriptPath = path.join(directory, "codex-stub.js");
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
fs.writeFileSync(process.env.CODEX_STUB_CAPTURE, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  agentName: process.env.AGENT_NAME,
  agentMailToken: process.env.AGENT_MAIL_REGISTRATION_TOKEN,
  mcpAgentMailToken: process.env.MCP_AGENT_MAIL_TOKEN,
  httpBearer: process.env.HTTP_BEARER_TOKEN,
  integrationBearer: process.env.INTEGRATION_BEARER_TOKEN,
  claudeCode: process.env.CLAUDECODE,
  override: process.env.CODEX_DELEGATOR_CODEX_BIN,
  providerAuth: process.env.OPENAI_API_KEY,
  preserved: process.env.PRESERVED_VALUE
}));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (!Object.prototype.hasOwnProperty.call(request, "id")) continue;
    const result = request.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "native-codex-stub", version: "1" } }
      : { tools: [{ name: "codex" }, { name: "codex-reply" }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});
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
    env: {
      ...process.env,
      PATH: [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter),
      CODEX_STUB_CAPTURE: capturePath,
      AGENT_NAME: "caller-agent",
      AGENT_MAIL_AGENT: "caller-agent",
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-registration-token",
      MCP_AGENT_MAIL_TOKEN: "caller-project-token",
      HTTP_BEARER_TOKEN: "caller-http-token",
      INTEGRATION_BEARER_TOKEN: "caller-integration-token",
      CLAUDECODE: "nested-claude-marker",
      OPENAI_API_KEY: "provider-auth",
      PRESERVED_VALUE: "keep-me"
    }
  };
}

function startLauncher() {
  const stub = createCodexStub();
  const args = [
    LAUNCHER_PATH,
    "-m", "gpt-test",
    "-s", "danger-full-access",
    "-a", "never",
    "mcp-server"
  ];
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(__dirname, "../.."),
    env: stub.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  runningLaunchers.add(child);

  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || "";
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
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("exit", () => {
    runningLaunchers.delete(child);
    for (const waiter of pending.values()) waiter.reject(new Error(`launcher exited: ${stderr}`));
    pending.clear();
  });

  return {
    capturePath: stub.capturePath,
    child,
    request(method, params = {}) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP response timed out: ${stderr}`)), 5_000);
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
  };
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

test("passes through native MCP stdio and scrubs the caller identity", async () => {
  const launcher = startLauncher();
  const initialized = await launcher.request("initialize");
  assert.equal(initialized.result.serverInfo.name, "native-codex-stub");
  const listed = await launcher.request("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["codex", "codex-reply"]);

  const capture = JSON.parse(fs.readFileSync(launcher.capturePath, "utf8"));
  assert.deepEqual(capture.args, [
    "-m", "gpt-test",
    "-s", "danger-full-access",
    "-a", "never",
    "mcp-server"
  ]);
  for (const field of ["agentName", "agentMailToken", "mcpAgentMailToken", "httpBearer", "integrationBearer", "claudeCode", "override"]) {
    assert.equal(capture[field], undefined);
  }
  assert.equal(capture.providerAuth, "provider-auth");
  assert.equal(capture.preserved, "keep-me");

  const exited = new Promise((resolve) => launcher.child.once("exit", resolve));
  launcher.child.stdin.end();
  await exited;
});

test("terminating the launcher terminates the native Codex process tree", async () => {
  const launcher = startLauncher();
  await waitFor(() => fs.existsSync(launcher.capturePath), "Codex stub did not start");
  const { pid } = JSON.parse(fs.readFileSync(launcher.capturePath, "utf8"));

  const exited = new Promise((resolve) => launcher.child.once("exit", resolve));
  launcher.child.kill("SIGTERM");
  await exited;
  await waitFor(() => !processIsAlive(pid), "Codex child survived launcher termination");
});
