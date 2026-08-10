"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("CI analyzes the canonical Sonar project without dependency lifecycle scripts", () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, "../.github/workflows/ci.yml"), "utf8");
  const sonarProperties = fs.readFileSync(path.resolve(__dirname, "../sonar-project.properties"), "utf8");

  assert.match(workflow, /^\s+run: npm ci --ignore-scripts$/m);
  assert.match(sonarProperties, /^sonar\.projectKey=mateusz-klatt_claude-delegator$/m);
  assert.doesNotMatch(sonarProperties, /mateusz-klatt_snapper-delegate/);
});

test("rules document the timeout escape hatch with the values the bridges enforce", () => {
  const geminiBridge = require("../server/gemini");
  const copilotBridge = require("../server/copilot");

  for (const tool of [...geminiBridge.toolDefinitions, ...copilotBridge.toolDefinitions]) {
    const { timeout } = tool.inputSchema.properties;
    assert.equal(timeout.default, 900_000, `${tool.name} default timeout`);
    assert.equal(timeout.minimum, 10_000, `${tool.name} minimum timeout`);
    assert.equal(timeout.maximum, 3_600_000, `${tool.name} maximum timeout`);
  }

  // The Claude bridge resolves the Claude CLI at load and exits when it is absent,
  // as it is on CI runners, so lock its bounds by source instead of requiring it.
  const claudeSource = fs.readFileSync(path.resolve(__dirname, "../server/claude/index.js"), "utf8");
  assert.match(claudeSource, /^const DEFAULT_TIMEOUT_MS = 900_000;$/m);
  assert.match(claudeSource, /^const MAX_TIMEOUT_MS = 3_600_000;$/m);
  assert.match(claudeSource, /^const MIN_TIMEOUT_MS = 10_000;$/m);

  // Every provider reference table must advertise the parameter, or the orchestrator
  // never sets it and long implementation runs die at the 15-minute default.
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  const timeoutRows = rules.split(/\r?\n/).filter((line) => line.startsWith("| `timeout` |"));
  assert.equal(timeoutRows.length, 3, "expected a timeout row for Gemini, Copilot and Claude");
  for (const row of timeoutRows) {
    assert.match(row, /10000/);
    assert.match(row, /3600000/);
    assert.match(row, /900000/);
  }

  assert.match(rules, /\*\*Timeout guidance\*\*/);
  assert.match(rules, /not\*\* rolled back/);
});
