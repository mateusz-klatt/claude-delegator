"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const providers = require("../config/providers.json");
const mcpServers = require("../config/mcp-servers.example.json");
const manifest = require("../.claude-plugin/plugin.json");

const CODEX_MCP_EXAMPLE = fs.readFileSync(
  path.resolve(__dirname, "../config/codex-mcp.example.toml"),
  "utf8"
);

function parseCodexMcpExample(source) {
  const servers = {};
  let current;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const section = line.match(/^\[mcp_servers\.([a-z0-9_-]+)\]$/i);
    if (section) {
      current = {};
      servers[section[1]] = current;
      continue;
    }

    assert.ok(current, `property outside an mcp_servers table: ${line}`);
    const property = line.match(/^([a-z0-9_]+)\s*=\s*(.+)$/i);
    assert.ok(property, `cannot parse Codex MCP example line: ${line}`);
    const [, key, literal] = property;
    if (literal.startsWith('"') || literal.startsWith("[")) {
      current[key] = JSON.parse(literal);
    } else if (literal === "true" || literal === "false") {
      current[key] = literal === "true";
    } else {
      const value = Number(literal);
      assert.ok(Number.isFinite(value), `unsupported Codex MCP value: ${literal}`);
      current[key] = value;
    }
  }

  return servers;
}

function normalizeEntrypoint(args) {
  const normalized = [...args];
  normalized[0] = normalized[0].replace(
    /^(?:\$\{CLAUDE_PLUGIN_ROOT\}|\/absolute\/path\/to\/claude-delegator)[\\/]/,
    ""
  );
  return normalized;
}

function withoutCodexSelfDisable(args) {
  const normalized = [...args];
  const override = normalized.indexOf("mcp_servers.codex.enabled=false");
  assert.ok(override > 0, "nested Codex must disable its inherited self-target");
  assert.equal(normalized[override - 1], "-c");
  normalized.splice(override - 1, 2);
  return normalized;
}

// `-c mcp_servers.codex.enabled=false` is deliberately absent. A `-c` override
// CREATES `mcp_servers.codex` when config.toml has no such section, and Codex
// refuses to start on any `mcp_servers.<name>` that declares no transport:
// measured on codex-cli 0.147.0 against two isolated CODEX_HOME directories,
// the flag gave "error loading config: invalid transport" without the section
// and started normally with it. A config carrying no self-reference is the
// ordinary case, so these distributed configurations shipped a Codex server
// that failed as CONNECTION_CLOSED — a symptom naming neither flag nor config.
//
// The manifest, providers catalog and Claude JSON example cannot guarantee that
// a Codex table exists, so omitting the flag is correct for them. The separate
// Codex-orchestrator TOML deliberately declares that table and disables it.
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

test("provider catalog, plugin manifest and MCP examples stay in parity", () => {
  const canonical = Object.keys(providers.providers);
  const claudeCodeTargets = canonical.filter((name) => name !== "claude");
  const codexExample = parseCodexMcpExample(CODEX_MCP_EXAMPLE);

  // Claude Code must not target itself. Codex can target Claude, and the
  // self-target Codex table remains available for explicitly nested runs.
  assert.deepEqual(Object.keys(manifest.mcpServers).sort(), claudeCodeTargets.sort());
  assert.deepEqual(Object.keys(mcpServers.mcpServers).sort(), claudeCodeTargets.sort());
  assert.deepEqual(Object.keys(codexExample).sort(), canonical.sort());
  assert.equal(Object.hasOwn(manifest.mcpServers, "claude"), false);
  assert.equal(Object.hasOwn(mcpServers.mcpServers, "claude"), false);
  assert.ok(Object.hasOwn(codexExample, "claude"));

  for (const name of claudeCodeTargets) {
    assert.deepEqual(
      manifest.mcpServers[name],
      providers.providers[name].mcp,
      `${name}: plugin manifest must match the canonical provider transport`
    );
    assert.deepEqual(
      mcpServers.mcpServers[name],
      providers.providers[name].mcp,
      `${name}: JSON example must match the canonical provider transport`
    );
  }

  for (const name of canonical) {
    const server = codexExample[name];
    assert.equal(server.command, providers.providers[name].mcp.command, `${name}: command`);
    assert.deepEqual(server.enabled_tools, [name, `${name}-reply`], `${name}: enabled tools`);
    assert.equal(server.startup_timeout_sec, 20, `${name}: startup timeout`);
    assert.equal(server.tool_timeout_sec, 3600, `${name}: tool timeout`);
    assert.equal(server.required, false, `${name}: optional server`);

    const actualArgs = name === "codex" ? withoutCodexSelfDisable(server.args) : server.args;
    assert.deepEqual(
      normalizeEntrypoint(actualArgs),
      normalizeEntrypoint(providers.providers[name].mcp.args),
      `${name}: Codex example must use the canonical provider entrypoint`
    );
  }
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

  // All six custom bridges take these bounds from the shared core rather than
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
  const servers = manifest.mcpServers;
  assert.ok(servers, "plugin.json must declare mcpServers");

  // Registering by hand with `claude mcp add ... ${CLAUDE_PLUGIN_ROOT}/...` let the
  // SHELL expand the variable at setup time, writing a path like
  // .../claude-delegator/1.6.5/server/agy/index.js into ~/.claude.json. That entry
  // died the moment the version directory did: three bridges failed with
  // CONNECTION_CLOSED after a routine cache cleanup, with nothing explaining why.
  // Declared here instead, Claude Code resolves the variable on every launch.
  const expected = Object.keys(providers.providers).filter((name) => name !== "claude");
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

  // Manifest-owned servers are addressable by their plugin-qualified names.
  // Bare lookups report "No MCP server found" even when the plugin is healthy.
  const configuredServers = [...setup.matchAll(
    /^\s+(plugin:claude-delegator:[a-z]+)(?:\s+\\)?\s*$/gm
  )].map((match) => match[1]);
  const expectedServers = Object.keys(servers)
    .map((name) => `plugin:${manifest.name}:${name}`);
  assert.deepEqual(configuredServers.sort(), expectedServers.sort());
  assert.match(setup, /claude mcp get "\$server"/);
  assert.match(setup, /grep -q 'Status: \.\*Connected'/);
  assert.doesNotMatch(setup, /grep -q ["']server\//);
  assert.match(
    setup,
    /"\$HOME\/\.grok\/bin\/grok" --version/,
    "setup must probe Grok's stable launcher even when it is absent from PATH"
  );
});

test("upgrade and uninstall instructions handle the 1.9 manifest transition", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const uninstall = fs.readFileSync(path.resolve(__dirname, "../commands/uninstall.md"), "utf8");

  assert.match(readme, /before 1\.9\.0/);
  assert.match(uninstall, /before 1\.9\.0/);
  assert.doesNotMatch(`${readme}\n${uninstall}`, /before 1\.8\.0/);
  assert.match(
    uninstall,
    /claude plugin uninstall --scope user claude-delegator@jarrodwatts-claude-delegator/
  );
  assert.match(uninstall, /for s in codex agy kimi copilot grok cursor gemini; do/);
});

test("no distributed config passes a -c override that would CREATE a config table", () => {
  // Stated as a property rather than by comparing against EXPECTED_CODEX_ARGS,
  // because that literal is exactly the construction which entrenched the defect:
  // adding the flag back to both the literal and the manifest would keep a
  // deepEqual green. A `-c mcp_servers.<name>.<key>` override CREATES that table
  // when config.toml has no such section, and Codex then refuses to start on an
  // entry declaring no transport -- surfacing as CONNECTION_CLOSED, which names
  // neither the flag nor the config. It shipped in three distributed configs and
  // no test saw it, because the bridges answer a hand-written `initialize` while
  // the launcher only parses config once it is running as an MCP server.
  //
  // This cannot prove Codex starts -- that needs the CLI installed and is a
  // developer-host check. It does catch the exact shape that reached a release.
  const sources = {
    "plugin.json": manifest.mcpServers.codex.args,
    "providers.json": providers.providers.codex.mcp.args,
    "mcp-servers.example.json": mcpServers.mcpServers.codex.args
  };

  for (const [where, args] of Object.entries(sources)) {
    const overrides = args.filter((argument, index) => args[index - 1] === "-c");
    for (const override of overrides) {
      assert.doesNotMatch(
        override,
        /^mcp_servers\./,
        `${where} must not -c into mcp_servers.*; it creates the table it means to disable`
      );
    }
    // The effort pin is the legitimate use of -c and must survive.
    assert.ok(
      overrides.some((override) => override.startsWith("model_reasoning_effort=")),
      `${where} should still pin the reasoning effort`
    );
  }
});

test("shipped rules name the tools the plugin actually advertises", () => {
  const shipped = ["rules/orchestration.md", "rules/model-selection.md", "rules/triggers.md",
                   "CLAUDE.md", "README.md"];

  // commands/setup.md copies rules/*.md into ~/.claude/rules/delegator/, so these
  // files are the orchestrator's instructions, not just prose. Declaring the
  // servers in the manifest renamed every tool -- mcp__agy__agy became
  // mcp__plugin_claude-delegator_agy__agy -- and left 70 references to names that
  // no longer resolve. The release would have shipped instructions telling Claude
  // Code to call tools it cannot see.
  for (const file of shipped) {
    const text = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    for (const server of Object.keys(manifest.mcpServers)) {
      assert.doesNotMatch(
        text,
        new RegExp(`mcp__${server}__`),
        `${file} still names mcp__${server}__*, which no longer exists`
      );
    }
  }

  // The Claude bridge is the deliberate exception and must NOT be rewritten: it is
  // absent from the manifest by decision 9, so an external orchestrator registers
  // it itself and it keeps the bare name.
  const orchestration = fs.readFileSync(path.resolve(__dirname, "../rules/orchestration.md"), "utf8");
  assert.match(orchestration, /mcp__claude__claude/);
  assert.equal(Object.hasOwn(manifest.mcpServers, "claude"), false);
});
