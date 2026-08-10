"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const providers = require("../config/providers.json");
const mcpServers = require("../config/mcp-servers.example.json");

const EXPECTED_CODEX_ARGS = [
  "-m", "gpt-5.6-sol",
  "-s", "danger-full-access",
  "-a", "never",
  "-c", "model_reasoning_effort=ultra",
  "-c", "mcp_servers.codex.enabled=false",
  "mcp-server"
];

function assertTransparentCodexLauncher(configuration) {
  assert.equal(configuration.command, "node");
  assert.match(configuration.args[0], /server[\\/]codex[\\/]launcher\.js$/);
  assert.deepEqual(configuration.args.slice(1), EXPECTED_CODEX_ARGS);
  assert.equal(path.basename(configuration.args[0]), "launcher.js");
}

test("distributed configurations run native Codex through the identity-boundary launcher", () => {
  assertTransparentCodexLauncher(providers.providers.codex.mcp);
  assertTransparentCodexLauncher(mcpServers.mcpServers.codex);
});
