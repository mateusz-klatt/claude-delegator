#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const catalog = require("../config/providers.json");
const { cliFallbacks } = require("../server/grok");
const { isObject, MAX_TIMEOUT_MS, resolveCli, spawnTarget } = require("../server/shared/bridge");

const CLIENTS = ["copilot", "grok", "kimi"];
const ROOT = path.resolve(__dirname, "..");
const TOOL_TIMEOUT_MS = MAX_TIMEOUT_MS + 60_000;

function serversFor(client, root) {
  if (!CLIENTS.includes(client)) {
    throw new Error("Specify --client copilot, grok, or kimi.");
  }
  return Object.fromEntries(
    Object.entries({ ...catalog.providers, ...catalog.utilities })
      .filter(([name]) => name !== client)
      .map(([name, entry]) => {
        const prefix = "${CLAUDE_PLUGIN_ROOT}/";
        const args = entry.mcp.args.map((arg) =>
          arg.startsWith(prefix) ? path.join(root, arg.slice(prefix.length)) : arg);
        fs.accessSync(args[0], fs.constants.R_OK);
        return [name, {
          command: entry.mcp.command,
          args,
          tools: entry.tools || [name, `${name}-reply`]
        }];
      })
  );
}

function checkConflicts(servers, existing) {
  for (const [name, server] of Object.entries(servers)) {
    const previous = existing[name];
    if (previous === undefined) continue;
    if (!isObject(previous) || previous.command !== server.command ||
        JSON.stringify(previous.args) !== JSON.stringify(server.args)) {
      throw new Error(`MCP server "${name}" already belongs to another configuration; nothing was overwritten.`);
    }
  }
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${source}; configuration was not changed.`);
  }
}

function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && !fs.lstatSync(file, { throwIfNoEntry: false })) {
      return { data: {}, target: file, mode: 0o600 };
    }
    throw error;
  }
  const data = parseJson(text, file);
  if (!isObject(data) || (data.mcpServers !== undefined && !isObject(data.mcpServers))) {
    throw new Error(`Expected an object with an mcpServers object in ${file}; configuration was not changed.`);
  }
  const target = fs.realpathSync(file);
  return { data, target, mode: fs.statSync(target).mode & 0o777 };
}

function writeConfig({ data, target, mode }) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(directory, ".delegator-setup-"));
  try {
    const file = path.join(temporary, "mcp.json");
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode });
    fs.renameSync(file, target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function grokRunner(environment, home) {
  const binary = resolveCli("grok", { environment, fallbacks: cliFallbacks({ home }) });
  return (args) => {
    const target = spawnTarget(binary, args, { environment });
    return execFileSync(target.command, target.args, {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true
    });
  };
}

function setupClient(client, {
  home = os.homedir(),
  environment = process.env,
  root = ROOT,
  runGrok
} = {}) {
  const servers = serversFor(client, root);
  if (client === "grok") {
    const run = runGrok || grokRunner(environment, home);
    const listed = parseJson(run(["mcp", "list", "--json"]), "grok mcp list");
    if (!Array.isArray(listed) || listed.some((entry) => !isObject(entry) || typeof entry.name !== "string")) {
      throw new Error("grok mcp list returned an unexpected server list; configuration was not changed.");
    }
    for (const entry of listed) {
      if (Object.hasOwn(servers, entry.name) && entry.scope !== "user") {
        throw new Error(`MCP server "${entry.name}" is shadowed outside user scope; configuration was not changed.`);
      }
    }
    checkConflicts(servers, Object.fromEntries(listed.map((entry) => [entry.name, entry])));
    // `mcp list` omits Claude plugin servers; `inspect` includes their inheritance.
    const inspected = parseJson(run(["inspect", "--json"]), "grok inspect");
    if (!isObject(inspected) || !Array.isArray(inspected.mcpServers) ||
        inspected.mcpServers.some((entry) => !isObject(entry) || typeof entry.name !== "string")) {
      throw new Error("grok inspect returned an unexpected server list; configuration was not changed.");
    }
    const inheritedSelf = inspected.mcpServers.some((entry) =>
      entry.name === "grok" && entry.source === "plugin: claude-delegator");
    if (inheritedSelf) run(["mcp", "disable", "grok"]);
    for (const [name, server] of Object.entries(servers)) {
      run(["mcp", "add", "--scope", "user", name, "--", server.command, ...server.args]);
    }
    return { client, servers: Object.keys(servers), config: path.join(home, ".grok", "config.toml") };
  }

  const directory = client === "copilot"
    ? environment.COPILOT_HOME || path.join(home, ".copilot")
    : environment.KIMI_CODE_HOME || path.join(home, ".kimi-code");
  const file = path.resolve(directory, client === "copilot" ? "mcp-config.json" : "mcp.json");
  const config = readConfig(file);
  const previous = config.data.mcpServers || {};
  checkConflicts(servers, previous);
  const additions = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const { tools, ...transport } = server;
    const options = client === "copilot"
      ? { type: "local", tools, timeout: TOOL_TIMEOUT_MS }
      : { enabled: true, enabledTools: tools, startupTimeoutMs: 45_000, toolTimeoutMs: TOOL_TIMEOUT_MS };
    return [name, { ...previous[name], ...transport, ...options }];
  }));
  config.data.mcpServers = { ...previous, ...additions };
  writeConfig(config);
  return { client, servers: Object.keys(servers), config: file };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/setup-mcp.js --client copilot|grok|kimi");
  } else {
    try {
      if (args.length !== 2 || args[0] !== "--client") {
        throw new Error("Usage: node scripts/setup-mcp.js --client copilot|grok|kimi");
      }
      const result = setupClient(args[1]);
      console.log(`${result.client}: registered ${result.servers.join(", ")}\nConfig: ${result.config}`);
      console.log("Restart the client to load the MCP servers.");
    } catch (error) {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { setupClient };
