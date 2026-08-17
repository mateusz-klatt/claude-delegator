"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const providers = require("../config/providers.json");
const mcpServers = require("../config/mcp-servers.example.json");

// `-c mcp_servers.codex.enabled=false` is deliberately absent. A `-c` override
// CREATES `mcp_servers.codex` when config.toml has no such section, and Codex
// refuses to start on any `mcp_servers.<name>` that declares no transport:
// measured on codex-cli 0.147.0 against two isolated CODEX_HOME directories,
// the flag gave "error loading config: invalid transport" without the section
// and started normally with it. A config carrying no self-reference is the
// ordinary case, so these distributed configurations shipped a Codex server
// that failed as CONNECTION_CLOSED — a symptom naming neither flag nor config.
//
// These files are static, so they cannot test for the section the way
// `commands/setup.md` does; omitting the flag is correct for them. An operator
// who really has a self-referential [mcp_servers.codex] adds it back by hand.
const EXPECTED_CODEX_ARGS = [
  "-m", "gpt-5.6-sol",
  "-s", "danger-full-access",
  "-a", "never",
  "-c", "model_reasoning_effort=ultra",
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
  const claudeBridge = require("../server/claude");
  const grokBridge = require("../server/grok");
  const cursorBridge = require("../server/cursor");

  for (const tool of [
    ...agyBridge.toolDefinitions,
    ...kimiBridge.toolDefinitions,
    ...copilotBridge.toolDefinitions,
    ...claudeBridge.toolDefinitions,
    ...grokBridge.toolDefinitions,
    ...cursorBridge.toolDefinitions
  ]) {
    const { timeout } = tool.inputSchema.properties;
    assert.equal(timeout.default, 900_000, `${tool.name} default timeout`);
    assert.equal(timeout.minimum, 10_000, `${tool.name} minimum timeout`);
    assert.equal(timeout.maximum, 3_600_000, `${tool.name} maximum timeout`);
  }

  // All four bridges now take these bounds from the shared core rather than
  // declaring their own, so lock the single definition too. Previously the Claude
  // bridge could only be checked by regex over its source, because it resolved the
  // CLI at load and exited when it was absent, as it is on CI runners.
  const core = require("../server/shared/bridge");
  assert.equal(core.DEFAULT_TIMEOUT_MS, 900_000);
  assert.equal(core.MAX_TIMEOUT_MS, 3_600_000);
  assert.equal(core.MIN_TIMEOUT_MS, 10_000);

  // Every provider reference table must advertise the parameter, or the orchestrator
  // never sets it and long implementation runs die at the 15-minute default.
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  const timeoutRows = rules.split(/\r?\n/).filter((line) => line.startsWith("| `timeout` |"));
  assert.equal(timeoutRows.length, 6, "expected a timeout row for Agy, Kimi, Grok, Cursor, Copilot and Claude");
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

test("every bridge guards against the minimal PATH an MCP server inherits", () => {
  // Two bridges silently had no fallbacks at all, through many releases. The
  // symptom appears only under a stripped PATH — the environment the bridges
  // actually run in, not the one they are tested in — so nothing ever said so:
  // measured on three hosts, claude and copilot would not start while their
  // binaries sat in ~/.local/bin, the canonical install location.
  const bridges = {
    agy: require("../server/agy"),
    kimi: require("../server/kimi"),
    copilot: require("../server/copilot"),
    claude: require("../server/claude"),
    grok: require("../server/grok"),
    cursor: require("../server/cursor")
  };

  // cursor-agent's Windows install directory has not been measured on any host
  // here. An empty list is the honest state — PATH still resolves it wherever the
  // installer put itself — and a guessed entry is the WinGet\\Packages mistake
  // removed in 1.7.0. Named rather than silent, so it cannot rot: delete this the
  // moment someone reports the real location.
  const noMeasuredWindowsLocation = process.platform === "win32" ? new Set(["cursor"]) : new Set();

  for (const [name, bridge] of Object.entries(bridges)) {
    const fallbacks = bridge.cliFallbacks();
    assert.ok(Array.isArray(fallbacks), `${name} must expose its fallbacks`);
    if (!noMeasuredWindowsLocation.has(name)) {
      assert.ok(fallbacks.length > 0, `${name} has no install-location fallback`);
    }
    for (const fallback of fallbacks) {
      assert.ok(path.isAbsolute(fallback), `${name}: ${fallback} must be absolute`);
      assert.ok(
        path.basename(fallback).startsWith(name),
        `${name}: ${fallback} must name its own CLI`
      );
    }
  }

  // A fallback only ever adds reach. selectCandidate ranks provenance above
  // extension, so a guess cannot displace what the user's PATH selects — the
  // property that makes it safe to hand fallbacks to bridges that had none.
  const core = require("../server/shared/bridge");
  const onDisk = new Set(["/usr/local/bin/cli", "/home/dev/.local/bin/cli"]);
  assert.equal(
    core.selectCandidate([["/usr/local/bin/cli"], ["/home/dev/.local/bin/cli"]], (c) => onDisk.has(c), false),
    "/usr/local/bin/cli"
  );
});

test("the plugin declares its MCP servers, so no version-stamped path is ever stored", () => {
  const manifest = require("../.claude-plugin/plugin.json");
  const servers = manifest.mcpServers;
  assert.ok(servers, "plugin.json must declare mcpServers");

  // Registering by hand with `claude mcp add ... ${CLAUDE_PLUGIN_ROOT}/...` let the
  // SHELL expand the variable at setup time, writing a path like
  // .../claude-delegator/1.6.5/server/agy/index.js into ~/.claude.json. That entry
  // died the moment the version directory did: three bridges failed with
  // CONNECTION_CLOSED after a routine cache cleanup, with nothing explaining why.
  // Declared here instead, Claude Code resolves the variable on every launch.
  const expected = ["codex", "agy", "kimi", "copilot", "grok", "cursor"];
  assert.deepEqual(Object.keys(servers).sort(), [...expected].sort());

  for (const [name, server] of Object.entries(servers)) {
    assert.equal(server.type, "stdio", name);
    assert.equal(server.command, "node", name);
    const script = server.args[0];
    assert.ok(script.startsWith("${CLAUDE_PLUGIN_ROOT}/"), `${name} must stay relative to the plugin root`);
    assert.doesNotMatch(script, /\d+\.\d+\.\d+/, `${name} must not carry a version in its path`);
    assert.doesNotMatch(script, /plugins[\\/]cache/, `${name} must not point into the version cache`);
  }

  // The Claude bridge is deliberately absent: registering it here would make
  // Claude Code a target of itself (decision 9).
  assert.equal(Object.hasOwn(servers, "claude"), false);

  // Codex keeps the same launcher invocation the other distributed configs use.
  assert.deepEqual(servers.codex.args.slice(1), EXPECTED_CODEX_ARGS);

  // setup.md must not grow the hand-registration block back.
  const setup = fs.readFileSync(path.resolve(__dirname, "../commands/setup.md"), "utf8");
  assert.doesNotMatch(setup, /^claude mcp add /m);
});
