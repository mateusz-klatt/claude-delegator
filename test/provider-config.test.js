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

test("rules document the Codex effort ceiling a per-call model override must respect", () => {
  const catalog = require("../config/model-catalog.json");
  const codex = catalog.providers.codex;

  // The launcher pins the server-level effort, and the transparent passthrough
  // cannot lower it when a call overrides `model`, so the caller must do it.
  assert.ok(
    EXPECTED_CODEX_ARGS.includes(`model_reasoning_effort=${codex.defaultEffort}`),
    "launcher args must pin the catalog default effort"
  );

  const capped = codex.models
    .filter((model) => !model.efforts.includes(codex.defaultEffort))
    .map((model) => model.id);
  assert.ok(capped.length > 0, "expected models that cannot take the pinned default effort");

  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  const guidance = rules
    .split(/\r?\n/)
    .find((line) => line.startsWith("**Effort guidance**"));

  assert.ok(guidance, "expected an Effort guidance paragraph in the Codex reference");
  assert.match(guidance, /model_reasoning_effort/);
  for (const id of capped) {
    assert.ok(
      guidance.includes(id),
      `Effort guidance must name ${id}, which rejects ${codex.defaultEffort}`
    );
  }
});

test("the Gemini bridge defaults the workspace-trust hatch on, and preserves an explicit value", () => {
  const { buildGeminiEnv } = require("../server/gemini");

  // Gemini fails outright in an untrusted folder — it overrides the approval mode
  // back to "default" and a headless child cannot answer the trust prompt — so both
  // sandbox modes depend on this default being applied.
  assert.equal(buildGeminiEnv({ PATH: "/usr/bin" }).GEMINI_CLI_TRUST_WORKSPACE, "true");

  // An operator restoring the gate must not have it silently re-enabled.
  assert.equal(
    buildGeminiEnv({ GEMINI_CLI_TRUST_WORKSPACE: "false" }).GEMINI_CLI_TRUST_WORKSPACE,
    "false"
  );

  // The caller's Agent Mail identity stays scrubbed regardless of the trust default.
  assert.equal(buildGeminiEnv({ agent_name: "gemini-mac-host-1" }).agent_name, undefined);

  // Documenting the tradeoff is the point: silently trusting every workspace without
  // saying so in the rules is how the prompt-injection surface goes unnoticed.
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  assert.match(rules, /\*\*Workspace trust\*\*/);
  assert.match(rules, /GEMINI_CLI_TRUST_WORKSPACE=true/);
  assert.match(rules, /GEMINI_CLI_TRUST_WORKSPACE=false/);
  assert.match(rules, /prompt-injection surface/);
});
