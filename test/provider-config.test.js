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
  const agyBridge = require("../server/agy");
  const kimiBridge = require("../server/kimi");
  const copilotBridge = require("../server/copilot");

  for (const tool of [...agyBridge.toolDefinitions, ...kimiBridge.toolDefinitions, ...copilotBridge.toolDefinitions]) {
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
  assert.equal(timeoutRows.length, 4, "expected a timeout row for Agy, Kimi, Copilot and Claude");
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

test("the Agy bridge never claims a read-only guarantee agy cannot enforce", () => {
  const { sandboxArguments } = require("../server/agy");

  // agy has no provider-enforced read-only tier in headless print mode. --mode plan
  // is a slash-command expansion, inert under the --disable-slash-commands the bridge
  // must always pass, and even with slash commands enabled it let a write through
  // under an insistent prompt. Omitting --dangerously-skip-permissions soft-denies
  // run_command and nothing else.
  assert.deepEqual(sandboxArguments("read-only"), []);
  assert.deepEqual(sandboxArguments("workspace-write"), ["--dangerously-skip-permissions"]);

  // Saying "read-only" without saying what it does not cover is how an advisory
  // delegation quietly rewrites the workspace.
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  assert.match(rules, /\*\*Sandbox honesty\*\*/);
  assert.match(rules, /prompt-injection surface/);

  const agySource = fs.readFileSync(path.resolve(__dirname, "../server/agy/index.js"), "utf8");
  // --add-dir is what switches on repo-supplied AGENTS.md/GEMINI.md rules injection;
  // cwd alone already grants file access, so passing it would buy nothing.
  assert.doesNotMatch(agySource, /"--add-dir"/);
  // --effort conflicts with the reasoning tier baked into most agy model ids.
  assert.doesNotMatch(agySource, /"--effort"/);
  assert.match(agySource, /"--disable-slash-commands"/);
});

test("the Kimi bridge refuses a read-only tier kimi print mode cannot provide", () => {
  const kimiBridge = require("../server/kimi");
  const catalog = require("../config/model-catalog.json");

  // kimi -p rejects --plan, --yolo and --auto outright ("Cannot combine --prompt
  // with ...") and runs tools unattended regardless, so there is no tier to map.
  // The bridge refuses read-only instead of accepting an inert value.
  const source = fs.readFileSync(path.resolve(__dirname, "../server/kimi/index.js"), "utf8");
  assert.match(source, /'sandbox: read-only' is not supported by Kimi/);
  assert.doesNotMatch(source, /"--plan"/);
  assert.doesNotMatch(source, /"--yolo"/);
  assert.doesNotMatch(source, /"--auto"/);
  // --continue resumes "the previous session for the working directory", which
  // would cross-talk between concurrent delegations sharing a cwd.
  assert.doesNotMatch(source, /"--continue"/);

  assert.match(catalog.providers.kimi.permissionNote, /no permission tier/i);
  // A repository AGENTS.md is auto-loaded with no off switch; the rules must say so.
  assert.ok(catalog.providers.kimi.contextNote.includes("AGENTS.md"));
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  assert.match(rules, /\*\*Sandbox honesty\*\*/);
  assert.match(rules, /AGENTS\.md/);
});
