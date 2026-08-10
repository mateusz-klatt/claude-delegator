#!/usr/bin/env node

/**
 * Manual MCP stdio probe.
 *
 * List tools:
 *   node test/mcp-probe.mjs -- node server/claude/index.js
 *
 * Call a tool after the handshake:
 *   node test/mcp-probe.mjs --call claude --args '{"prompt":"Reply OK"}' -- \
 *     node server/claude/index.js
 *
 * Set MCP_PROBE_TIMEOUT_MS for live model calls (default: 30000).
 */

import { spawn } from "node:child_process";
import process from "node:process";

const separator = process.argv.indexOf("--");
if (separator === -1 || separator === process.argv.length - 1) {
  console.error("Usage: node test/mcp-probe.mjs [--call TOOL --args JSON] -- COMMAND [ARG ...]");
  process.exit(2);
}

const options = process.argv.slice(2, separator);
const commandParts = process.argv.slice(separator + 1);
let toolName = null;
let toolArguments = {};
let describedTool = null;
let replyTool = null;
let replyArguments = null;

for (let index = 0; index < options.length; index += 1) {
  if (options[index] === "--call" && options[index + 1]) {
    toolName = options[++index];
  } else if (options[index] === "--describe" && options[index + 1]) {
    describedTool = options[++index];
  } else if (options[index] === "--args" && options[index + 1]) {
    try {
      toolArguments = JSON.parse(options[++index]);
    } catch (error) {
      console.error(`Invalid --args JSON: ${error.message}`);
      process.exit(2);
    }
  } else if (options[index] === "--reply" && options[index + 1]) {
    replyTool = options[++index];
  } else if (options[index] === "--reply-args" && options[index + 1]) {
    try {
      replyArguments = JSON.parse(options[++index]);
    } catch (error) {
      console.error(`Invalid --reply-args JSON: ${error.message}`);
      process.exit(2);
    }
  } else {
    console.error(`Unknown option: ${options[index]}`);
    process.exit(2);
  }
}

const timeoutMs = Number.parseInt(process.env.MCP_PROBE_TIMEOUT_MS || "30000", 10);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("MCP_PROBE_TIMEOUT_MS must be a positive integer");
  process.exit(2);
}

const child = spawn(commandParts[0], commandParts.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = "";
let stderr = "";
let nextId = 1;
const pending = new Map();

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(new Error(`Non-JSON stdout from MCP server: ${line}\n${error.message}`));
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  }
});

child.on("error", fail);
child.on("exit", (code, signal) => {
  if (pending.size > 0) {
    fail(new Error(`MCP server exited early (code=${code}, signal=${signal})`));
  }
});

let failed = false;
function fail(error) {
  if (failed) return;
  failed = true;
  const detail = stderr.trim() ? `\nServer stderr:\n${stderr.trim()}` : "";
  console.error(`${error.message}${detail}`);
  child.kill("SIGTERM");
  process.exitCode = 1;
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method} after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "claude-delegator-probe", version: "1.0.0" }
  });
  notify("notifications/initialized");
  const listed = await request("tools/list");
  const tools = Array.isArray(listed.tools) ? listed.tools : [];

  if (describedTool) {
    const definition = tools.find((tool) => tool.name === describedTool);
    if (!definition) {
      throw new Error(`Tool ${JSON.stringify(describedTool)} not advertised; available: ${tools.map((tool) => tool.name).join(", ")}`);
    }
    console.log(JSON.stringify({
      serverInfo: initialized.serverInfo || null,
      tool: definition
    }, null, 2));
  } else if (!toolName) {
    console.log(JSON.stringify({
      serverInfo: initialized.serverInfo || null,
      protocolVersion: initialized.protocolVersion || null,
      tools: tools.map((tool) => tool.name)
    }, null, 2));
  } else {
    if (!tools.some((tool) => tool.name === toolName)) {
      throw new Error(`Tool ${JSON.stringify(toolName)} not advertised; available: ${tools.map((tool) => tool.name).join(", ")}`);
    }
    const result = await request("tools/call", { name: toolName, arguments: toolArguments });
    let reply = null;
    if (replyTool) {
      const threadId = result.threadId || result.structuredContent?.threadId;
      if (!threadId) throw new Error(`Tool ${JSON.stringify(toolName)} did not return a threadId`);
      if (!tools.some((tool) => tool.name === replyTool)) {
        throw new Error(`Reply tool ${JSON.stringify(replyTool)} not advertised`);
      }
      reply = await request("tools/call", {
        name: replyTool,
        arguments: { ...(replyArguments || {}), threadId }
      });
    }
    console.log(JSON.stringify({
      serverInfo: initialized.serverInfo || null,
      tool: toolName,
      result,
      ...(replyTool ? { replyTool, reply } : {})
    }, null, 2));
  }
} catch (error) {
  fail(error);
} finally {
  child.stdin.end();
  if (!failed) child.kill("SIGTERM");
}
