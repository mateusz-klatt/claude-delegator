"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const providers = require("../config/providers.json");
const mcpServers = require("../config/mcp-servers.example.json");
const manifest = require("../.claude-plugin/plugin.json");
const marketplace = require("../.claude-plugin/marketplace.json");

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

test("release metadata stays at one version until the dedicated release commit", () => {
  const packageJson = require("../package.json");
  const packageLock = require("../package-lock.json");
  const versions = [
    packageJson.version,
    packageLock.version,
    packageLock.packages[""].version,
    manifest.version,
    marketplace.plugins[0].version
  ];
  assert.equal(new Set(versions).size, 1, `release metadata drifted: ${versions.join(", ")}`);
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
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const sonarProjectKey = /^sonar\.projectKey=(.+)$/m.exec(sonarProperties)?.[1];

  assert.match(workflow, /^\s+run: npm ci --ignore-scripts$/m);
  assert.match(sonarProperties, /^sonar\.projectKey=mateusz-klatt_claude-delegator$/m);
  assert.doesNotMatch(sonarProperties, /mateusz-klatt_snapper-delegate/);
  assert.ok(sonarProjectKey, "sonar-project.properties must declare sonar.projectKey");
  assert.ok(
    readme.includes(`sonarcloud.io/project/overview?id=${sonarProjectKey}`),
    "README Sonar link must target the same project as sonar-project.properties"
  );
  assert.doesNotMatch(readme, /mateusz-klatt_snapper-delegate/);
  assert.match(
    readme,
    /\]\(https:\/\/www\.star-history\.com\/#mateusz-klatt\/claude-delegator&Date\)/
  );
  assert.doesNotMatch(readme, /\]\(https:\/\/star-history\.com\//);
});

test("README states the runtime and provider continuity contracts", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const setup = fs.readFileSync(path.resolve(__dirname, "../commands/setup.md"), "utf8");
  const packageJson = require("../package.json");
  const catalog = require("../config/model-catalog.json");
  const minimumNode = /\d+\.\d+\.\d+/.exec(packageJson.engines.node)?.[0];

  assert.ok(minimumNode, "package engines.node must contain a concrete minimum version");
  assert.ok(readme.includes(`Node.js ${minimumNode} or newer`));
  assert.ok(setup.includes(`Node.js ${minimumNode} or newer`));
  assert.match(setup, /NODE_TOO_OLD/);

  assert.match(readme, /repeat `sandbox: "read-only"` on every\s+reply/);
  assert.match(readme, /Agy replies must (?:also )?repeat[\s\S]{0,120}`model` and[\s\S]{0,40}`cwd`/);
  assert.match(readme, /same `cwd`[\s\S]{0,120}Kimi[\s\S]{0,120}Cursor/);
  assert.doesNotMatch(readme, /mcp__claude__claude/);

  for (const model of catalog.providers.cursor.models) {
    assert.ok(
      providers.providers.cursor.auth.includes(`\`${model}\``),
      `Cursor auth metadata must retain the verified live model ${model}`
    );
  }
});

test("shipped guidance does not claim Grok is the only enforcing bridge", () => {
  const files = ["README.md", "CLAUDE.md", "rules/orchestration.md", "rules/model-selection.md", "rules/triggers.md"];
  const customProviders = ["Claude", "Agy", "Kimi", "Copilot", "Grok", "Cursor"];

  for (const file of files) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /(?:only|one) bridge[^\n]*read-only[^\n]*(?:den(?:y|ies)|enforc)/i, file);
    assert.doesNotMatch(source, /one bridged provider whose `read-only` denies/i, file);
    assert.doesNotMatch(source, /only mapping[^\n]*denies/i, file);

    const permissionSummary = source.split(/\r?\n/).find((line) =>
      line.includes("Grok") && line.includes("Copilot") && line.includes("read-only")
    );
    assert.ok(permissionSummary, `${file}: missing provider-specific read-only summary`);
    for (const provider of customProviders) {
      assert.ok(permissionSummary.includes(provider), `${file}: read-only summary omits ${provider}`);
    }
  }
});

test("shared bridge guidance names every custom provider", () => {
  const customProviders = Object.keys(providers.providers)
    .filter((name) => name !== "codex")
    .map((name) => name === "agy" ? "Agy" : name[0].toUpperCase() + name.slice(1));
  const contracts = [
    ["rules/model-selection.md", /Claude, GPT \(Codex\),[^\n]+experts serve/],
    ["rules/model-selection.md", /1\. \*\*If multiple are available\*\*:[\s\S]+?2\. \*\*If only one is available\*\*/],
    ["rules/orchestration.md", /For the ([^.]+) bridges, do not manually inject/],
    ["rules/orchestration.md", /For the ([^.]+) bridges, pass the object only/],
    ["rules/model-selection.md", /The six custom bridges \(([^)]+)\) put a JSON envelope/],
    ["rules/triggers.md", /Codex native MCP[^\n]+?([^.]+) bridge calls should receive/]
  ];

  for (const [file, pattern] of contracts) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const contract = pattern.exec(source)?.[0];
    assert.ok(contract, `${file}: shared bridge contract not found`);
    for (const provider of customProviders) {
      assert.ok(contract.includes(provider), `${file}: shared bridge contract omits ${provider}`);
    }
  }
});

test("catalog refresh prose follows the catalog dates and response envelope types", () => {
  const catalog = require("../config/model-catalog.json");
  const selection = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  const orchestration = fs.readFileSync(path.resolve(__dirname, "../rules/orchestration.md"), "utf8");

  assert.ok(selection.includes(`Rosters were refreshed on ${catalog.verifiedAt}`));
  assert.ok(selection.includes(`CLI versions were rechecked on ${catalog.cliVersionsCheckedAt}`));
  assert.match(selection, /\| MCP result `content` \| content-block array \|/);
  assert.match(selection, /\| Envelope `content` \| string \|/);
  assert.match(selection, /JSON envelope `\{"threadId": "\.\.\.", "content": "\.\.\."\}`/);
  assert.match(selection, /Native Codex leaves the expert response as plain text/);
  assert.match(selection, /result\.structuredContent\.threadId/);
  assert.doesNotMatch(selection, /mirroring native Codex output/);

  const nativeExtraction = /const threadId = result\.threadId \?\? result\.structuredContent\?\.threadId/g;
  assert.equal(
    [...orchestration.matchAll(nativeExtraction)].length,
    3,
    "every native Codex example must use its actual top-level/structured result shape"
  );
  assert.match(orchestration, /Custom bridge extraction[\s\S]+JSON\.parse\(result\.content\[0\]\.text\)\.threadId/);
  assert.doesNotMatch(orchestration, /const \{ threadId \} = JSON\.parse\(result\.content\[0\]\.text\)/);
  assert.match(orchestration, /node "\$\{CLAUDE_PLUGIN_ROOT\}"\/server\/codex\/launcher\.js/);
});

test("coordination guidance follows the live Agent Mail delivery shape", () => {
  const files = [
    "prompts/agent-mail-coordination.md",
    "rules/orchestration.md",
    "rules/delegation-format.md"
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    assert.match(source, /deliveries\[0\]\.message\.id/, file);
    assert.doesNotMatch(source, /deliveries\[0\]\.payload\.id/, file);
  }

  const prompt = fs.readFileSync(
    path.resolve(__dirname, "../prompts/agent-mail-coordination.md"),
    "utf8"
  );
  const providerSessionLine = prompt.split(/\r?\n/).find((line) =>
    line.includes("provider session `threadId`")
  );
  assert.ok(providerSessionLine, "coordination prompt must distinguish provider sessions");
  for (const provider of Object.keys(providers.providers)) {
    assert.ok(providerSessionLine.includes(`\`${provider}\``), `coordination prompt omits ${provider}`);
  }

  const delegationFormat = fs.readFileSync(
    path.resolve(__dirname, "../rules/delegation-format.md"),
    "utf8"
  );
  const selection = fs.readFileSync(
    path.resolve(__dirname, "../rules/model-selection.md"),
    "utf8"
  );
  assert.match(delegationFormat, /Native Codex coordination \(optional; omit for custom bridges\)/);
  assert.match(delegationFormat, /pass its fields only through the\s+`coordination` argument/);
  assert.match(selection, /pass optional Agent Mail coordination through `coordination`, not by duplicating it here/);
});

test("reply guidance distinguishes defaulted arguments from inherited effort", () => {
  const sources = ["README.md", "CLAUDE.md", "rules/orchestration.md"]
    .map((file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /Reply calls do not inherit optional MCP arguments/);
    assert.match(source, /repeat[\s\S]{0,120}`sandbox`|repeat `sandbox:/);
    assert.match(source, /Claude and Copilot[\s\S]{0,160}(?:inherit|retain)[\s\S]{0,80}effort|`effort` on Claude and Copilot[\s\S]{0,160}inherit/);
  }
});

test("Copilot effort floors are documented as start-only", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const claude = fs.readFileSync(path.resolve(__dirname, "../CLAUDE.md"), "utf8");
  const orchestration = fs.readFileSync(path.resolve(__dirname, "../rules/orchestration.md"), "utf8");
  const selection = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");

  assert.match(readme, /start calls clamp verified per-model effort floors and ceilings/);
  assert.match(claude, /Start calls default to `max`[\s\S]{0,180}omit `effort`/);
  assert.match(orchestration, /On start, the bridge applies verified per-model bounds[\s\S]{0,260}omit `effort`/);
  assert.match(selection, /floors both `none` and `minimal` to `low` on start calls/);
  assert.match(selection, /explicit reply override is forwarded without that start-only floor/);
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
  assert.equal(timeoutRows.length, 12, "expected start and reply timeout rows for all six custom bridges");
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

test("every custom bridge stamps and enforces its provider-specific depth guard", () => {
  const customBridges = Object.keys(providers.providers).filter((name) => name !== "codex");
  assert.deepEqual(customBridges.sort(), ["agy", "claude", "copilot", "cursor", "grok", "kimi"]);
  const sharedRuntime = fs.readFileSync(
    path.resolve(__dirname, "../server/shared/provider-runtime.js"),
    "utf8"
  );
  assert.match(sharedRuntime, /if \(depth\.exceeded\(\)\)/);

  for (const name of customBridges) {
    const source = fs.readFileSync(path.resolve(__dirname, `../server/${name}/index.js`), "utf8");
    const marker = `CLAUDE_DELEGATOR_${name.toUpperCase()}_DEPTH`;
    assert.ok(
      source.includes(`createDepthGuard("${marker}")`),
      `${name} must create its provider-specific depth guard`
    );
    assert.match(source, /depth\.stamp\(/, `${name} must stamp its child environment`);
    if (source.includes("createProviderHandlers")) {
      assert.match(
        source,
        /createProviderHandlers\(\{[\s\S]+?\bdepth,/,
        `${name} must pass its guard to the shared runtime`
      );
    } else {
      assert.match(source, /depth\.exceeded\(\)/, `${name} must refuse a nested delegation`);
    }
  }
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
  const configuredServers = new Set([...setup.matchAll(
    /^\s+(plugin:claude-delegator:[a-z]+)(?:\s+\\)?\s*$/gm
  )].map((match) => match[1]));
  const expectedServers = Object.keys(servers)
    .map((name) => `plugin:${manifest.name}:${name}`);
  assert.deepEqual([...configuredServers].sort(), expectedServers.sort());
  assert.match(setup, /claude mcp get "\$server"/);
  const connectedPattern = "^[[:space:]]*Status:[[:space:]]+[^[:alnum:][:space:]]+[[:space:]]+Connected[[:space:]]*$";
  assert.ok(setup.includes(`grep -Eq '${connectedPattern}'`));
  const isConnectedStatus = (status) => status.split(/\r?\n/).some((line) =>
    /^[\t ]*Status:[\t ]+[^\p{L}\p{N}\s]+[\t ]+Connected[\t ]*$/u.test(line)
  );
  for (const status of ["Status: ✔ Connected\n", "Status: √ Connected\r\n", "  Status: ✓ Connected  \n"]) {
    assert.equal(isConnectedStatus(status), true, status);
  }
  for (const status of ["Status: Not Connected\n", "Status: Disconnected\n", "Status: Connected\n"]) {
    assert.equal(isConnectedStatus(status), false, status);
  }
  assert.doesNotMatch(setup, /grep -q ["']server\//);
  assert.match(setup, /cp "\$\{CLAUDE_PLUGIN_ROOT\}"\/rules\/\*\.md/);
  assert.match(
    setup,
    /"\$HOME\/\.grok\/bin\/grok" --version/,
    "setup must probe Grok's stable launcher even when it is absent from PATH"
  );
  assert.match(setup, /On Windows, only PATH is supported/);
  assert.doesNotMatch(setup, /advisory intent is enforced/);
  assert.doesNotMatch(setup, /denies shell only, never writes/);
  assert.match(setup, /\$\{LOCALAPPDATA:-\}[\s\S]+agy\/bin\/agy\.exe/);
  assert.match(setup, /\.kimi-code\/bin\/kimi\.exe[\s\S]+\.kimi-code\/bin\/kimi\.cmd/);
  assert.match(setup, /\.grok\/bin\/grok\.exe/);
  assert.match(setup, /\$\{APPDATA:-\}[\s\S]+npm\/copilot\.cmd/);

  const verification = /# Check 1: CLI versions[\s\S]+?(?=# Check 2:)/.exec(setup)?.[0];
  assert.ok(verification, "setup CLI verification block missing");
  assert.match(verification, /if \[ "\$\{OS:-\}" = "Windows_NT" \]; then/);
  assert.match(verification, /check_cli_version "Agy" "agy" "\$\{local_appdata:\+\$local_appdata\/agy\/bin\/agy\.exe\}"/);
  assert.match(verification, /check_cli_version "Kimi" "kimi" "\$windows_home\/\.kimi-code\/bin\/kimi\.exe" "\$windows_home\/\.kimi-code\/bin\/kimi\.cmd"/);
  assert.match(verification, /check_cli_version "Grok" "grok" "\$windows_home\/\.grok\/bin\/grok\.exe"/);
  assert.match(verification, /check_cli_version "Copilot" "copilot" "\$\{appdata:\+\$appdata\/npm\/copilot\.cmd\}"/);
  assert.match(
    verification,
    /check_cli_version "Cursor" "cursor-agent"[\s\S]+?else[\s\S]+?check_cli_version "Cursor" "cursor-agent" "\$HOME\/\.local\/bin\/cursor-agent"/,
    "setup must keep Cursor PATH-only on Windows and use its measured POSIX fallback"
  );
  assert.match(setup, /read-only` is a provider-specific opt-in and is not universally\s+enforced/);
});

test("upgrade and uninstall instructions handle the 1.9 manifest transition", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const setup = fs.readFileSync(path.resolve(__dirname, "../commands/setup.md"), "utf8");
  const uninstall = fs.readFileSync(path.resolve(__dirname, "../commands/uninstall.md"), "utf8");

  assert.match(readme, /before 1\.9\.0/);
  assert.match(uninstall, /before 1\.9\.0/);
  assert.doesNotMatch(`${readme}\n${uninstall}`, /before 1\.8\.0/);
  assert.match(
    uninstall,
    /claude plugin uninstall --scope user claude-delegator@jarrodwatts-claude-delegator/
  );
  assert.match(uninstall, /for s in codex agy kimi copilot grok cursor gemini; do/);
  const extractMigrationBlock = (source, heading) => {
    const normalized = source.replace(/\r\n?/g, "\n");
    return new RegExp(`${heading}[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\``).exec(normalized)?.[1];
  };
  const migrationSources = {
    README: [readme, "### Repair MCP registration after an upgrade"],
    setup: [setup, "### Clearing registrations from an older install"]
  };
  const migrationBlocks = Object.fromEntries(Object.entries(migrationSources).map(
    ([label, [source, heading]]) => [label, extractMigrationBlock(source, heading)]
  ));
  const expectedServers = Object.keys(manifest.mcpServers);
  const connectedPattern = "^[[:space:]]*Status:[[:space:]]+[^[:alnum:][:space:]]+[[:space:]]+Connected[[:space:]]*$";

  for (const [label, [source, heading]] of Object.entries(migrationSources)) {
    const crlf = source.replace(/\r?\n/g, "\r\n");
    assert.equal(
      extractMigrationBlock(crlf, heading),
      migrationBlocks[label],
      `${label}: migration parser must be invariant under CRLF checkout`
    );
  }

  for (const [label, block] of Object.entries(migrationBlocks)) {
    assert.ok(block, `${label}: migration block not found`);
    assert.match(block, /^# Keep[^\n]+\n#[^\n]+\n\(\nset -e\n/);
    assert.match(block, /claude_plugin_list=\$\(claude plugin list --json\)/);
    assert.match(block, /JSON\.parse\(process\.env\.CLAUDE_PLUGIN_LIST_JSON\)/);
    assert.doesNotMatch(block, /installed_plugins\.json/);
    assert.match(
      block,
      /claude plugin update --scope user claude-delegator@jarrodwatts-claude-delegator/,
      `${label}: migration must update the active install before inspecting it`
    );
    assert.doesNotMatch(
      block,
      /claude plugin (?:uninstall|install)\b/,
      `${label}: migration must not delete the working plugin before its replacement succeeds`
    );
    assert.match(block, /records\[0\]\["installPath"\]/);
    assert.doesNotMatch(block, /glob\.glob/);
    assert.match(block, /node - <<'NODE'/);
    assert.doesNotMatch(block, /python3/);
    assert.ok(block.includes(`grep -Eq '${connectedPattern}'`));
    const manifestGuard = /node - <<'NODE'\n([\s\S]*?)\nNODE/.exec(block)?.[1];
    assert.ok(manifestGuard, `${label}: manifest guard missing`);
    for (const server of expectedServers) {
      assert.ok(manifestGuard.includes(`"${server}"`), `${label}: manifest guard omits ${server}`);
    }

    assert.match(block, /legacy_servers="\$\(\n\s+node - <<'NODE'/);
    assert.match(block, /process\.env\.CLAUDE_CONFIG_DIR[\s\S]+?\.claude\.json/);
    assert.match(block, /user\.mcpServers\?\.\[name\]/);
    assert.match(block, /value\.split\("\/"\)\.includes\("claude-delegator"\)/);
    assert.match(block, /const oldEntrypoint = `\/server\/\$\{name\}\/`/);
    assert.equal([...block.matchAll(/for s in \$legacy_servers; do/g)].length, 2);
    assert.match(block, /\[ "\$s" = "gemini" \] && replacement="agy"/);
    assert.match(block, /server="plugin:claude-delegator:\$replacement"/);
    assert.match(block, /status_dir=\$\(mktemp -d\)/);
    assert.match(block, /trap 'rmdir "\$status_dir"[^']+' EXIT/);
    assert.match(
      block,
      /if ! legacy_config=\$\(CDPATH= cd -- "\$status_dir" && claude mcp get "\$s" 2>&1\); then[\s\S]+?preserving all recognized legacy registrations[\s\S]+?preflight_failed=1[\s\S]+?continue\n\s+fi/,
      `${label}: an unknown legacy inspection result must fail closed before removal`
    );
    assert.match(
      block,
      /replacement_config=\$\(CDPATH= cd -- "\$status_dir" && claude mcp get "\$server" 2>&1\) \|\| replacement_config=""/
    );
    assert.doesNotMatch(block, /for server in \\\s+plugin:claude-delegator:/);
    assert.match(block, /if ! is_connected "\$legacy_config"; then[\s\S]+?continue\n\s+fi/);
    assert.match(block, /if is_connected "\$replacement_config"; then[\s\S]+?else[\s\S]+?preflight_failed=1/);
    assert.match(block, /preserving all recognized legacy registrations/);
    assert.match(block, /if \[ "\$preflight_failed" -ne 0 \]; then\n\s+exit 1/);

    const preflightStart = block.indexOf("preflight_failed=0");
    const abortGate = block.indexOf('if [ "$preflight_failed" -ne 0 ]');
    const removalLoop = block.indexOf("for s in $legacy_servers; do", abortGate);
    assert.ok(preflightStart >= 0 && abortGate > preflightStart && removalLoop > abortGate);
    assert.doesNotMatch(
      block.slice(preflightStart, abortGate),
      /claude mcp remove/,
      `${label}: preflight must collect every pair before the first removal`
    );
    assert.match(block, /claude mcp remove --scope user "\$s"/);
    assert.match(block, /\n\)\s*$/);

    const scanner = /legacy_servers="\$\(\n\s+node - <<'NODE'\n([\s\S]*?)\nNODE\n\)"/.exec(block)?.[1];
    assert.ok(scanner, `${label}: legacy scanner missing`);
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-delegator-legacy-"));
    try {
      fs.writeFileSync(path.join(fixtureHome, ".claude.json"), JSON.stringify({
        mcpServers: {
          codex: {
            command: "node",
            args: ["C:\\Users\\dev\\.claude\\plugins\\cache\\vendor\\claude-delegator\\1.6.5\\server\\codex\\index.js"]
          },
          agy: { command: "node", args: ["/opt/unrelated/server/agy/index.js"] },
          kimi: { command: "node", args: ["/work/claude-delegator-fork/server/kimi/index.js"] },
          gemini: { command: "node", args: ["/cache/claude-delegator/1.4.0/server/gemini/index.js"] }
        }
      }));
      const scan = spawnSync(process.execPath, ["-e", scanner], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixtureHome,
          USERPROFILE: fixtureHome,
          CLAUDE_CONFIG_DIR: ""
        }
      });
      assert.equal(scan.status, 0, `${label}: scanner failed: ${scan.stderr}`);
      assert.deepEqual(
        scan.stdout.trim().split(/\r?\n/).filter(Boolean),
        ["codex", "gemini"],
        `${label}: scan must select only recognized user legacy entries and allow a partial install`
      );

      const customProfile = path.join(fixtureHome, "custom-profile");
      fs.mkdirSync(customProfile);
      fs.writeFileSync(path.join(customProfile, ".claude.json"), JSON.stringify({
        mcpServers: {
          cursor: { command: "node", args: ["/cache/claude-delegator/1.8.0/server/cursor/index.js"] }
        }
      }));
      const customScan = spawnSync(process.execPath, ["-e", scanner], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixtureHome,
          USERPROFILE: fixtureHome,
          CLAUDE_CONFIG_DIR: customProfile
        }
      });
      assert.equal(customScan.status, 0, `${label}: custom-profile scanner failed: ${customScan.stderr}`);
      assert.deepEqual(
        customScan.stdout.trim().split(/\r?\n/).filter(Boolean),
        ["cursor"],
        `${label}: CLAUDE_CONFIG_DIR must override the default user MCP state`
      );
    } finally {
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  }

  const migrationBlocked = (pairs) => pairs.some(({
    legacyConnected,
    replacementConnected,
    legacyInspectionOk = true,
    replacementInspectionOk = true
  }) => !legacyInspectionOk || !replacementInspectionOk || (legacyConnected && !replacementConnected));
  assert.equal(migrationBlocked([{ legacyConnected: true, replacementConnected: true }]), false);
  assert.equal(migrationBlocked([{ legacyConnected: true, replacementConnected: false }]), true);
  assert.equal(migrationBlocked([{ legacyConnected: false, replacementConnected: false }]), false);
  assert.equal(
    migrationBlocked([{ legacyInspectionOk: false }]),
    true,
    "a legacy inspection error must preserve every recognized registration"
  );
  assert.equal(
    migrationBlocked([{ legacyConnected: true, replacementInspectionOk: false }]),
    true,
    "a replacement inspection error must preserve every recognized registration"
  );
  assert.equal(
    migrationBlocked([
      { legacyConnected: true, replacementConnected: true },
      ...Array.from({ length: 5 }, () => ({ legacyConnected: false, replacementConnected: false }))
    ]),
    false,
    "a one-provider partial install must migrate"
  );
  assert.equal(
    migrationBlocked([{ legacyConnected: true, replacementConnected: false, legacy: "gemini", replacement: "agy" }]),
    true,
    "connected legacy Gemini requires a Connected Agy replacement"
  );
  assert.match(uninstall, /\/plugin install claude-delegator@jarrodwatts-claude-delegator/);
  assert.match(uninstall, /\/claude-delegator:setup/);
  assert.match(setup, /\/user\/starred\/mateusz-klatt\/claude-delegator/);
  assert.doesNotMatch(setup, /\/user\/starred\/jarrodwatts\/claude-delegator/);
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
