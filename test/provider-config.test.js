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
const bridgeCore = require("../server/shared/bridge");

const CODEX_MCP_EXAMPLE = fs.readFileSync(
  path.resolve(__dirname, "../config/codex-mcp.example.toml"),
  "utf8"
);

function resolveTestBash({
  platform = process.platform,
  environment = process.env,
  existsSync = fs.existsSync,
  probe,
  gitExecPath
} = {}) {
  if (platform !== "win32") return environment.CLAUDE_DELEGATOR_TEST_BASH || "bash";

  const isGnuBash = probe || ((candidate) => {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env: environment,
      windowsHide: true
    });
    return result.status === 0 && /GNU bash/i.test(`${result.stdout || ""}${result.stderr || ""}`);
  });
  let discoveredGitExecPath = gitExecPath;
  if (discoveredGitExecPath === undefined) {
    const result = spawnSync("git", ["--exec-path"], {
      encoding: "utf8",
      env: environment,
      windowsHide: true
    });
    discoveredGitExecPath = result.status === 0 ? result.stdout.trim() : "";
  }

  const candidates = [];
  const addCandidate = (candidate) => {
    if (typeof candidate === "string" && candidate) candidates.push(candidate);
  };
  addCandidate(environment.CLAUDE_DELEGATOR_TEST_BASH);
  if (discoveredGitExecPath) {
    addCandidate(path.win32.resolve(discoveredGitExecPath, "..", "..", "..", "bin", "bash.exe"));
  }
  for (const root of [
    environment.ProgramFiles,
    environment.ProgramW6432,
    environment["ProgramFiles(x86)"]
  ]) {
    if (root) addCandidate(path.win32.join(root, "Git", "bin", "bash.exe"));
  }
  if (environment.LOCALAPPDATA) {
    addCandidate(path.win32.join(environment.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  for (const directory of (environment.PATH || "").split(path.win32.delimiter)) {
    if (directory) addCandidate(path.win32.join(directory, "bash.exe"));
  }

  const banned = new Set(["C:\\Windows\\System32\\bash.exe"]);
  if (environment.SystemRoot && bridgeCore.isFullyQualifiedWindowsPath(environment.SystemRoot)) {
    banned.add(path.win32.join(environment.SystemRoot, "System32", "bash.exe"));
  }
  const normalizedBanned = new Set(
    [...banned].map((candidate) => path.win32.normalize(candidate).toLowerCase())
  );
  const seen = new Set();
  for (const candidate of candidates) {
    if (!bridgeCore.isFullyQualifiedWindowsPath(candidate)) continue;
    const normalized = path.win32.normalize(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key) || normalizedBanned.has(key)) continue;
    seen.add(key);
    if (existsSync(normalized) && isGnuBash(normalized)) return normalized;
  }
  throw new Error(
    "Git Bash is required for Windows shell fixtures; System32\\bash.exe is a WSL launcher and is never used"
  );
}

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

test("coverage exclusions are shell-independent on Windows and POSIX", () => {
  const packageJson = require("../package.json");
  const coverage = require("../.c8rc.json");

  assert.equal(packageJson.scripts["test:coverage"], "c8 npm test");
  assert.deepEqual(coverage.src, ["server"]);
  assert.deepEqual(coverage.exclude, ["**/*.test.js", "test/**"]);
  assert.deepEqual(coverage.reporter, ["text", "lcov"]);
  assert.equal(coverage.all, true);
  assert.doesNotMatch(
    packageJson.scripts["test:coverage"],
    /--exclude|['"]\*\*\//,
    "coverage globs must be JSON data, not shell-quoted npm-script arguments"
  );
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
    assert.equal(server.startup_timeout_sec, 45, `${name}: startup timeout`);
    assert.ok(
      server.startup_timeout_sec * 1_000 >= bridgeCore.CLI_VERSION_TIMEOUT_MS + 15_000,
      `${name}: startup timeout must leave 15s above the CLI version probe`
    );
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

test("the manual MCP probe outlives CLI discovery and the host startup budget", () => {
  const probe = fs.readFileSync(path.resolve(__dirname, "mcp-probe.mjs"), "utf8");
  const defaultProbeTimeout = /MCP_PROBE_TIMEOUT_MS \|\| "(\d+)"/.exec(probe)?.[1];
  assert.equal(Number(defaultProbeTimeout), 60_000);
  assert.ok(Number(defaultProbeTimeout) > 45_000);
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
  assert.doesNotMatch(readme, /star-history\.com|Star History/i);
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
  const mandatoryTemplate = /## The 7-Section Format \(MANDATORY\)[\s\S]*?```\n([\s\S]*?)\n```/.exec(
    delegationFormat.replace(/\r\n?/g, "\n")
  )?.[1];
  assert.ok(mandatoryTemplate, "mandatory seven-section template missing");
  for (const field of ["projectKey", "callerAgentName", "mailTopic", "checkpointIntervalSeconds"]) {
    assert.doesNotMatch(
      mandatoryTemplate,
      new RegExp(`\\b${field}\\b`),
      `${field} is transport metadata, not a mandatory task section`
    );
  }
  assert.match(delegationFormat, /## Optional Coordination Transport/);
  assert.match(delegationFormat, /append the[\s\S]+separate envelope after[\s\S]+seven-section task/);
  assert.match(delegationFormat, /pass its\s+fields only through the\s+`coordination` argument/);
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

  for (const [name, bridge] of Object.entries(bridges)) {
    const fallbacks = bridge.cliFallbacks();
    assert.ok(Array.isArray(fallbacks), `${name} must expose its fallbacks`);
    assert.ok(fallbacks.length > 0, `${name} has no install-location fallback`);
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
  assert.match(setup, /rules_root="\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/rules\/delegator"/);
  assert.match(setup, /cp "\$\{CLAUDE_PLUGIN_ROOT\}"\/rules\/\*\.md "\$rules_root\/"/);
  assert.doesNotMatch(setup, /~\/\.claude\/rules\/delegator|"\$HOME\/\.claude\/rules\/delegator/);
  assert.match(
    setup,
    /"\$HOME\/\.grok\/bin\/grok" --version/,
    "setup must probe Grok's stable launcher even when it is absent from PATH"
  );
  assert.doesNotMatch(setup, /On Windows, only PATH is supported|no stable fallback has been measured/);
  assert.doesNotMatch(setup, /advisory intent is enforced/);
  assert.doesNotMatch(setup, /denies shell only, never writes/);
  assert.match(setup, /\$\{LOCALAPPDATA:-\}[\s\S]+agy\/bin\/agy\.exe/);
  assert.match(setup, /\.kimi-code\/bin\/kimi\.exe[\s\S]+\.kimi-code\/bin\/kimi\.cmd/);
  assert.match(setup, /\.grok\/bin\/grok\.exe/);
  assert.match(setup, /Programs\/OpenAI\/Codex\/bin\/codex\.exe/);
  assert.match(setup, /cursor-agent\/cursor-agent\.cmd/);
  assert.match(setup, /\$\{APPDATA:-\}[\s\S]+npm\/codex\.cmd/);
  assert.match(setup, /\$\{APPDATA:-\}[\s\S]+npm\/copilot\.cmd/);

  const verification = /# Check 1: CLI versions[\s\S]+?(?=# Check 2:)/.exec(setup)?.[0];
  assert.ok(verification, "setup CLI verification block missing");
  assert.match(verification, /if \[ "\$\{OS:-\}" = "Windows_NT" \]; then/);
  assert.match(verification, /check_cli_version "Codex" "codex" "\$\{local_appdata:\+\$local_appdata\/Programs\/OpenAI\/Codex\/bin\/codex\.exe\}" "\$\{appdata:\+\$appdata\/npm\/codex\.cmd\}"/);
  assert.match(verification, /check_cli_version "Agy" "agy" "\$\{local_appdata:\+\$local_appdata\/agy\/bin\/agy\.exe\}"/);
  assert.match(verification, /check_cli_version "Kimi" "kimi" "\$\{windows_home:\+\$windows_home\/\.kimi-code\/bin\/kimi\.exe\}" "\$\{windows_home:\+\$windows_home\/\.kimi-code\/bin\/kimi\.cmd\}"/);
  assert.match(verification, /check_cli_version "Grok" "grok" "\$\{windows_home:\+\$windows_home\/\.grok\/bin\/grok\.exe\}"/);
  assert.match(verification, /check_cli_version "Copilot" "copilot" "\$\{appdata:\+\$appdata\/npm\/copilot\.cmd\}"/);
  assert.match(verification, /check_cli_version "Cursor" "cursor-agent" "\$\{local_appdata:\+\$local_appdata\/cursor-agent\/cursor-agent\.cmd\}"/);
  assert.match(verification, /else[\s\S]+?check_cli_version "Cursor" "cursor-agent" "\$HOME\/\.local\/bin\/cursor-agent"/);
  assert.match(verification, /resolved_binary=\$\(command -v "\$cli" 2>\/dev\/null\)/);
  assert.match(
    verification,
    /is_runnable_cli_candidate\(\) \{[\s\S]*?Windows_NT:\*\.\[Cc\]\[Mm\]\[Dd\][\s\S]*?Windows_NT:\*\.\[Bb\]\[Aa\]\[Tt\][\s\S]*?\[ -f "\$1" \][\s\S]*?\[ -x "\$1" \][\s\S]*?\n\}/,
    "Windows command/batch shims must be regular files; native candidates must remain executable"
  );
  assert.match(
    verification,
    /is_shell_absolute_path "\$resolved_binary" && is_runnable_cli_candidate "\$resolved_binary"/
  );
  assert.match(
    verification,
    /is_shell_absolute_path "\$fallback" && is_runnable_cli_candidate "\$fallback"/
  );
  assert.match(verification, /CODEX_BIN="\$binary"/);
  assert.match(setup, /codex_auth_output=\$\("\$CODEX_BIN" login status 2>&1\)/);
  assert.match(setup, /CODEX_AUTH_EXIT_STATUS=\$\?/);
  assert.doesNotMatch(setup, /(?:^|\n)codex login status|login status[^\n]*\|/);
  assert.match(
    verification,
    /core\.isFullyQualifiedWindowsPath\(process\.argv\[2\]\)/,
    "setup must reuse the runtime's drive/UNC validator"
  );
  assert.doesNotMatch(verification, /\^\/\/\[\^\/\]\+\/\[\^\/\]\+/);
  const windowsDependencyBlocks = [...setup.matchAll(
    /elif \[ "\$\{OS:-\}" = "Windows_NT" \]; then([\s\S]*?)(?=\n(?:elif|else|fi)\b)/g
  )].map((match) => match[1]);
  assert.equal(windowsDependencyBlocks.length, 6, "every provider dependency check needs a Windows branch");
  for (const block of windowsDependencyBlocks) {
    assert.match(block, /is_windows_fully_qualified_root/);
    assert.match(block, /core\.isFullyQualifiedWindowsPath/);
    assert.match(block, /is_runnable_cli_candidate\(\)/);
    assert.match(block, /Windows_NT:\*\.\[Cc\]\[Mm\]\[Dd\]/);
    assert.match(block, /Windows_NT:\*\.\[Bb\]\[Aa\]\[Tt\]/);
    assert.ok(
      [...block.matchAll(/is_runnable_cli_candidate/g)].length >= 2,
      "every Windows dependency check must apply the portable candidate predicate"
    );
  }
  assert.match(setup, /read-only` is a provider-specific opt-in and is not universally\s+enforced/);
});

test("Windows shell fixtures never select the System32 WSL launcher", () => {
  const systemRoot = String.raw`C:\Windows`;
  const systemBash = String.raw`C:\Windows\System32\bash.exe`;
  const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
  const existing = new Set([systemBash, gitBash].map((candidate) => candidate.toLowerCase()));
  const selected = resolveTestBash({
    platform: "win32",
    environment: {
      SystemRoot: systemRoot,
      ProgramFiles: String.raw`C:\Program Files`,
      PATH: `${path.win32.dirname(systemBash)};${path.win32.dirname(gitBash)}`
    },
    existsSync: (candidate) => existing.has(candidate.toLowerCase()),
    probe: () => true,
    gitExecPath: ""
  });
  assert.equal(selected, gitBash);

  assert.throws(
    () => resolveTestBash({
      platform: "win32",
      environment: {
        CLAUDE_DELEGATOR_TEST_BASH: systemBash,
        SystemRoot: systemRoot,
        PATH: path.win32.dirname(systemBash)
      },
      existsSync: () => true,
      probe: () => true,
      gitExecPath: ""
    }),
    /System32\\bash\.exe is a WSL launcher/
  );
});

test("setup reuses the resolved Codex binary and preserves auth exit status", {
  skip: process.platform === "win32"
}, () => {
  const setup = fs.readFileSync(path.resolve(__dirname, "../commands/setup.md"), "utf8");
  const resolver = /(is_shell_absolute_path\(\) \{[\s\S]*?\n\}\n\nis_windows_fully_qualified_root\(\) \{[\s\S]*?\n\}\n\nis_runnable_cli_candidate\(\) \{[\s\S]*?\n\}\n\nCODEX_BIN=""\ncheck_cli_version\(\) \{[\s\S]*?\n\})(?=\n\nif \[)/.exec(setup)?.[1];
  const auth = /(# Check 4: Codex auth status[\s\S]*?\nfi)(?=\n```)/.exec(setup)?.[1];
  assert.ok(resolver, "could not extract the Codex resolver from setup");
  assert.ok(auth, "could not extract the Codex auth check from setup");

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-fixture-"));
  const fixtureDirectory = path.join(fixtureRoot, "fallback bin with spaces");
  const fixtureBinary = path.join(fixtureDirectory, "codex fixture");
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  fs.writeFileSync(fixtureBinary, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex fixture 1.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  case "\${AUTH_MODE:-success}" in
    success) printf '%s\\n' 'Logged in from fallback'; exit 0 ;;
    failure) printf '%s\\n' 'fixture auth rejected'; exit 7 ;;
    silent) exit 9 ;;
  esac
fi
exit 64
`);
  fs.chmodSync(fixtureBinary, 0o755);

  const harness = `${resolver}
check_cli_version "Codex" "codex-not-on-path" "$FIXTURE_CODEX" || true
${auth}
printf 'FIXTURE_BIN=%s\\nFIXTURE_STATUS=%s\\n' "$CODEX_BIN" "$CODEX_AUTH_EXIT_STATUS"
`;
  const run = (mode, binary = fixtureBinary) => spawnSync(resolveTestBash(), ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      AUTH_MODE: mode,
      FIXTURE_CODEX: binary
    }
  });

  try {
    const success = run("success");
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Codex auth: Logged in from fallback/);
    assert.ok(success.stdout.includes(`FIXTURE_BIN=${fixtureBinary}`));
    assert.match(success.stdout, /FIXTURE_STATUS=0/);

    const failure = run("failure");
    assert.equal(failure.status, 0, failure.stderr);
    assert.match(failure.stdout, /Codex auth: FAILED \(exit 7\): fixture auth rejected/);
    assert.match(failure.stdout, /FIXTURE_STATUS=7/);

    const silent = run("silent");
    assert.equal(silent.status, 0, silent.stderr);
    assert.match(silent.stdout, /Codex auth: FAILED \(exit 9\): \(no output\)/);
    assert.match(silent.stdout, /FIXTURE_STATUS=9/);

    const missing = run("success", path.join(fixtureRoot, "missing codex"));
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /Codex auth: SKIPPED \(no verified Codex binary from Check 1\)/);
    assert.match(missing.stdout, /FIXTURE_BIN=\s*\nFIXTURE_STATUS=127/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("setup accepts non-executable Windows command shims without weakening native checks", {
  skip: process.platform === "win32"
}, () => {
  const setup = fs.readFileSync(path.resolve(__dirname, "../commands/setup.md"), "utf8");
  const predicate = /(is_runnable_cli_candidate\(\) \{[\s\S]*?\n\})/.exec(
    /# Check 1: CLI versions[\s\S]+?(?=# Check 2:)/.exec(setup)?.[0] || ""
  )?.[1];
  assert.ok(predicate, "could not extract the portable CLI candidate predicate");

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "setup-candidate-fixture-"));
  const fixtureDirectory = path.join(fixtureRoot, "Windows bin with spaces");
  const commandShim = path.join(fixtureDirectory, "codex fixture.CmD");
  const batchShim = path.join(fixtureDirectory, "copilot fixture.bAt");
  const nativeExecutable = path.join(fixtureDirectory, "native executable");
  const nativeNonExecutable = path.join(fixtureDirectory, "native not executable");
  const missingShim = path.join(fixtureDirectory, "missing.cmd");
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  for (const candidate of [commandShim, batchShim, nativeExecutable, nativeNonExecutable]) {
    fs.writeFileSync(candidate, "fixture\n");
  }
  fs.chmodSync(commandShim, 0o644);
  fs.chmodSync(batchShim, 0o644);
  fs.chmodSync(nativeExecutable, 0o755);
  fs.chmodSync(nativeNonExecutable, 0o644);

  const check = (candidate, osName = "Windows_NT") => spawnSync(
    resolveTestBash(),
    ["-c", `${predicate}\nis_runnable_cli_candidate "$FIXTURE_CANDIDATE"`],
    {
      encoding: "utf8",
      env: { ...process.env, OS: osName, FIXTURE_CANDIDATE: candidate }
    }
  );

  try {
    assert.equal(check(commandShim).status, 0, "a .cmd regular file with spaces must be accepted on Git Bash");
    assert.equal(check(batchShim).status, 0, "a case-insensitive .bat regular file must be accepted on Git Bash");
    assert.equal(check(nativeExecutable).status, 0, "an executable native candidate must be accepted");
    assert.equal(check(nativeNonExecutable).status, 1, "a non-executable native candidate must be rejected");
    assert.equal(check(missingShim).status, 1, "a missing .cmd candidate must be rejected");
    assert.equal(check(commandShim, "").status, 1, "POSIX must not treat a non-executable .cmd as runnable");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("upgrade and uninstall instructions handle the 1.9 manifest transition", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const contributing = fs.readFileSync(path.resolve(__dirname, "../CONTRIBUTING.md"), "utf8");
  const setup = fs.readFileSync(path.resolve(__dirname, "../commands/setup.md"), "utf8");
  const uninstall = fs.readFileSync(path.resolve(__dirname, "../commands/uninstall.md"), "utf8");

  assert.match(contributing, /mcp__plugin_claude-delegator_codex__codex/);
  assert.doesNotMatch(contributing, /mcp__codex__codex/);
  assert.match(
    readme,
    /https:\/\/github\.com\/mateusz-klatt\/claude-delegator\/actions\/workflows\/ci\.yml/
  );
  assert.doesNotMatch(readme, /\]\(\.github\/workflows\/ci\.yml\)/);
  assert.match(readme, /before 1\.9\.0/);
  assert.match(uninstall, /before 1\.9\.0/);
  assert.doesNotMatch(`${readme}\n${uninstall}`, /before 1\.8\.0/);
  for (const [label, source] of [["setup", setup], ["uninstall", uninstall]]) {
    assert.match(
      source,
      /rules_root="\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/rules\/delegator"/,
      `${label}: rules must follow the active Claude profile`
    );
    assert.doesNotMatch(
      source,
      /~\/\.claude\/rules\/delegator|"\$HOME\/\.claude\/rules\/delegator/,
      `${label}: rules path must not bypass CLAUDE_CONFIG_DIR`
    );
  }
  assert.doesNotMatch(setup, /find "\$rules_root" -maxdepth/);
  assert.match(setup, /for rule in "\$rules_root"\/\*\.md; do[\s\S]+?\[ -f "\$rule" \] \|\| continue[\s\S]+?rule_count=\$\(\(rule_count \+ 1\)\)/);
  assert.match(uninstall, /rm -rf -- "\$rules_root"/);
  assert.match(
    uninstall,
    /claude plugin uninstall --scope user claude-delegator@jarrodwatts-claude-delegator/
  );
  assert.doesNotMatch(uninstall, /for s in codex agy kimi copilot grok cursor gemini; do/);
  const uninstallBlock = /## Remove MCP Configuration[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(
    uninstall.replace(/\r\n?/g, "\n")
  )?.[1];
  assert.ok(uninstallBlock, "uninstall MCP block missing");
  assert.match(uninstallBlock, /for s in \$legacy_servers; do/);
  assert.match(uninstallBlock, /claude_plugin_list=\$\(claude plugin list --json/);
  assert.match(uninstallBlock, /legacy_scan_status=\$\?/);
  assert.match(uninstallBlock, /preserving all bare MCP registrations/);
  assert.match(uninstallBlock, /legacy_removed=""/);
  assert.match(uninstallBlock, /legacy_remove_failed=""/);
  assert.match(
    uninstallBlock,
    /if claude mcp remove --scope user "\$s"[^\n]+; then[\s\S]+?legacy_removed=/
  );
  assert.doesNotMatch(uninstallBlock, /claude mcp remove[^\n]+\|\| true/);
  assert.match(uninstallBlock, /Preserved all bare MCP registrations because their ownership could not be verified/);
  assert.match(uninstallBlock, /Removed recognized legacy user-scoped MCP registrations: \$legacy_removed/);
  assert.match(uninstallBlock, /No recognized legacy user-scoped MCP registrations required removal/);
  assert.match(uninstallBlock, /Failed to remove legacy user-scoped MCP registrations: \$legacy_remove_failed/);
  const removalReporting = /(legacy_removed=""[\s\S]*?)\n# Remove the plugin/.exec(uninstallBlock)?.[1];
  assert.ok(removalReporting, "uninstall legacy removal reporting block missing");
  const runRemovalReporting = ({ scanStatus = 0, servers = "", failures = "" } = {}) => spawnSync(
    resolveTestBash(),
    ["-c", `
claude() {
  case " $REMOVE_FAILURES " in
    *" $5 "*) return 1 ;;
    *) return 0 ;;
  esac
}
legacy_scan_status=${scanStatus}
legacy_servers=${JSON.stringify(servers)}
REMOVE_FAILURES=${JSON.stringify(failures)}
${removalReporting}
`],
    { encoding: "utf8" }
  );
  const preserved = runRemovalReporting({ scanStatus: 1, servers: "codex" });
  assert.equal(preserved.status, 0);
  assert.match(preserved.stdout, /Preserved all bare MCP registrations/);
  assert.doesNotMatch(preserved.stdout, /Removed recognized legacy/);
  const partial = runRemovalReporting({ servers: "codex agy", failures: "agy" });
  assert.equal(partial.status, 0);
  assert.match(partial.stdout, /Removed recognized legacy user-scoped MCP registrations: codex/);
  assert.match(partial.stderr, /Failed to remove legacy user-scoped MCP registrations: agy/);
  const empty = runRemovalReporting();
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /No recognized legacy user-scoped MCP registrations required removal/);
  const extractLegacyScanner = (block) =>
    /legacy_servers="\$\(\n\s+CLAUDE_PLUGIN_LIST_JSON="\$claude_plugin_list" node - <<'NODE'\n([\s\S]*?)\nNODE\n\)"/.exec(block)?.[1];
  const uninstallScanner = extractLegacyScanner(uninstallBlock);
  assert.ok(uninstallScanner, "uninstall must scan legacy registration provenance");
  const canonicalPathSource = /(function canonicalAbsolutePath\(value, forceWindows = process\.platform === "win32"\) \{[\s\S]*?\n\})(?=\nconst canonicalInstall)/.exec(
    uninstallScanner
  )?.[1];
  const historicalEntrypointSource = /(function isHistoricalEntrypoint\(value, name\) \{[\s\S]*?\n\})(?=\nfor \(const name)/.exec(
    uninstallScanner
  )?.[1];
  assert.ok(canonicalPathSource, "legacy scanner canonical path classifier missing");
  assert.ok(historicalEntrypointSource, "legacy scanner entrypoint predicate missing");
  const invalidUncComponent = /[\u0000-\u001F<>:"|?*]/;
  const cacheVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const canonicalAbsolutePath = Function(
    "path",
    "invalidUncComponent",
    `"use strict";\n${canonicalPathSource}\nreturn canonicalAbsolutePath;`
  )(path, invalidUncComponent);
  const historicalEntrypointFor = (pathApi, versionsRoot) => Function(
    "path",
    "pathApi",
    "versionsRoot",
    "cacheVersion",
    "invalidUncComponent",
    `"use strict";\n${canonicalPathSource}\n${historicalEntrypointSource}\nreturn isHistoricalEntrypoint;`
  )(path, pathApi, versionsRoot, cacheVersion, invalidUncComponent);

  // path.win32.resolve inherits a drive for root-relative values. On a C: host,
  // the old isAbsolute -> normalize -> relative sequence could therefore turn
  // this unqualified argv[0] into the exact owned lineage. Exercise the bypass
  // deterministically instead of relying on the test runner's platform/cwd.
  const windowsVersionsRoot = String.raw`C:\Users\alice\.claude\plugins\cache\jarrodwatts-claude-delegator\claude-delegator`;
  const rootRelative = String.raw`\Users\alice\.claude\plugins\cache\jarrodwatts-claude-delegator\claude-delegator\1.6.5\server\agy\index.js`;
  const slashRootRelative = "/Users/alice/.claude/plugins/cache/jarrodwatts-claude-delegator/claude-delegator/1.6.5/server/agy/index.js";
  const inheritedDrivePath = path.win32.resolve(String.raw`C:\host\working-directory`, rootRelative);
  assert.equal(
    path.win32.relative(windowsVersionsRoot, inheritedDrivePath),
    String.raw`1.6.5\server\agy\index.js`,
    "same-drive resolution reproduces the historical root-relative bypass"
  );
  const windowsHistoricalEntrypoint = historicalEntrypointFor(path.win32, windowsVersionsRoot);
  const drivePositive = String.raw`C:\Users\alice\.claude\plugins\cache\jarrodwatts-claude-delegator\claude-delegator\1.6.5\server\agy\index.js`;
  assert.equal(windowsHistoricalEntrypoint(drivePositive, "agy"), true);
  assert.equal(windowsHistoricalEntrypoint(rootRelative, "agy"), false);
  assert.equal(windowsHistoricalEntrypoint(slashRootRelative, "agy"), false);
  assert.equal(canonicalAbsolutePath(rootRelative, true), null);
  assert.equal(canonicalAbsolutePath(slashRootRelative, true), null);
  assert.equal(canonicalAbsolutePath(String.raw`C:Users\alice\entrypoint.js`, true), null);
  assert.equal(canonicalAbsolutePath(String.raw`\\?\C:\Users\alice\entrypoint.js`, true), null);
  assert.equal(canonicalAbsolutePath(String.raw`\\server`, true), null);
  assert.equal(canonicalAbsolutePath(String.raw`\\server?\share\entrypoint.js`, true), null);
  assert.equal(
    canonicalAbsolutePath(String.raw`C:\Users\alice\cache\1.9.1\..\1.6.5\server\agy\index.js`, true),
    null
  );

  const uncVersionsRoot = String.raw`\\server\share\cache\jarrodwatts-claude-delegator\claude-delegator`;
  const uncPositive = String.raw`\\server\share\cache\jarrodwatts-claude-delegator\claude-delegator\1.6.5\server\agy\index.js`;
  assert.equal(historicalEntrypointFor(path.win32, uncVersionsRoot)(uncPositive, "agy"), true);
  assert.equal(canonicalAbsolutePath(uncPositive, true)?.pathApi, path.win32);

  const posixVersionsRoot = "/home/alice/.claude/plugins/cache/jarrodwatts-claude-delegator/claude-delegator";
  const posixPositive = `${posixVersionsRoot}/1.6.5/server/agy/index.js`;
  assert.equal(historicalEntrypointFor(path.posix, posixVersionsRoot)(posixPositive, "agy"), true);
  assert.equal(canonicalAbsolutePath(posixPositive, false)?.pathApi, path.posix);
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

    assert.match(block, /legacy_servers="\$\(\n\s+CLAUDE_PLUGIN_LIST_JSON="\$claude_plugin_list" node - <<'NODE'/);
    assert.match(block, /process\.env\.CLAUDE_CONFIG_DIR[\s\S]+?\.claude\.json/);
    assert.match(block, /user\.mcpServers\?\.\[name\]/);
    assert.match(block, /function isHistoricalEntrypoint\(value, name\)/);
    assert.match(block, /records\[0\]\.installPath/);
    assert.match(block, /records\[0\]\.version !== activeVersion/);
    assert.match(block, /process\.platform === "win32"/);
    assert.match(block, /const windowsDevice =/);
    assert.match(block, /function canonicalAbsolutePath\(value, forceWindows/);
    assert.match(block, /pathApi\.basename\(versionsRoot\) !== "claude-delegator"/);
    assert.match(block, /pathApi\.basename\(marketplaceRoot\) !== "jarrodwatts-claude-delegator"/);
    assert.doesNotMatch(block, /pathApi\.basename\(cacheRoot\) !== "cache"/);
    assert.match(block, /canonicalAbsolutePath\(value, pathApi === path\.win32\)/);
    assert.match(block, /canonicalValue\.pathApi !== pathApi/);
    assert.match(block, /pathApi\.relative\(versionsRoot, canonicalValue\.normalized\)/);
    assert.doesNotMatch(block, /pathApi\.relative\(versionsRoot, pathApi\.normalize\(value\)\)/);
    assert.match(block, /activeManifest\.mcpServers/);
    assert.match(block, /activeManifest\.name !== "claude-delegator"/);
    assert.match(block, /activeManifest\.version !== activeVersion/);
    assert.match(block, /entry\.command !== "node"/);
    assert.match(block, /isHistoricalEntrypoint\(entry\.args\[0\], name\)/);
    assert.match(block, /allowedEntrypoints = name === "codex" \? \["launcher\.js", "index\.js"\]/);
    assert.doesNotMatch(block, /const candidates = \[entry\.command/);
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

    const scanner = extractLegacyScanner(block);
    assert.ok(scanner, `${label}: legacy scanner missing`);
    assert.equal(
      scanner,
      uninstallScanner,
      `${label}: repair and uninstall must apply the same provenance boundary`
    );
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-delegator-legacy-"));
    const pluginRecord = (installPath, version = manifest.version) => ({
      id: "claude-delegator@jarrodwatts-claude-delegator",
      scope: "user",
      version,
      installPath
    });
    const writeVerifiedInstall = (installPath, overrides = {}) => {
      const manifestDirectory = path.join(installPath, ".claude-plugin");
      fs.mkdirSync(manifestDirectory, { recursive: true });
      fs.writeFileSync(path.join(manifestDirectory, "plugin.json"), JSON.stringify({
        name: "claude-delegator",
        version: path.basename(installPath),
        mcpServers: manifest.mcpServers,
        ...overrides
      }));
    };
    const runScanner = ({ profile = "", pluginList }) => spawnSync(process.execPath, ["-e", scanner], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixtureHome,
        USERPROFILE: fixtureHome,
        CLAUDE_CONFIG_DIR: profile,
        CLAUDE_PLUGIN_LIST_JSON: JSON.stringify(pluginList)
      }
    });
    const outputNames = (scan) => scan.stdout.trim().split(/\r?\n/).filter(Boolean);
    try {
      const defaultVersionsRoot = path.join(
        fixtureHome, ".claude", "plugins", "cache",
        "jarrodwatts-claude-delegator", "claude-delegator"
      );
      const activeInstall = path.join(defaultVersionsRoot, manifest.version);
      writeVerifiedInstall(activeInstall);
      const historical = (root, version, name, entrypoint = "index.js") =>
        path.join(root, version, "server", name, entrypoint);
      const foreignVersionsRoot = path.join(
        fixtureHome, "foreign-prefix", "plugins", "cache",
        "jarrodwatts-claude-delegator", "claude-delegator"
      );
      fs.writeFileSync(path.join(fixtureHome, ".claude.json"), JSON.stringify({
        mcpServers: {
          codex: {
            command: "node",
            args: [historical(defaultVersionsRoot, "1.6.5", "codex", "launcher.js")]
          },
          // Exact terminal marketplace lineage under another root is foreign.
          agy: { command: "node", args: [historical(foreignVersionsRoot, "1.6.5", "agy")] },
          // The historical command always placed the entrypoint in argv[0].
          kimi: { command: "node", args: ["--loader", historical(defaultVersionsRoot, "1.6.5", "kimi")] },
          // The historical transport used literal `node`, never an absolute lookalike.
          copilot: { command: path.join(fixtureHome, "bin", "node"), args: [historical(defaultVersionsRoot, "1.6.5", "copilot")] },
          grok: { command: "node", args: [`${historical(defaultVersionsRoot, "1.6.5", "grok")}${path.sep}extra`] },
          cursor: { command: "node", args: [historical(defaultVersionsRoot, "01.02.03", "cursor")] },
          gemini: { command: "node", args: [path.join(fixtureHome, "work", "claude-delegator", "server", "gemini", "index.js")] }
        }
      }));
      const defaultRecord = pluginRecord(activeInstall);
      const scan = runScanner({ pluginList: [defaultRecord] });
      assert.equal(scan.status, 0, `${label}: scanner failed: ${scan.stderr}`);
      assert.deepEqual(
        outputNames(scan),
        ["codex"],
        `${label}: only argv[0] below the verified cache family is owned`
      );

      const customProfile = path.join(fixtureHome, "custom-profile");
      fs.mkdirSync(customProfile);
      // CLAUDE_CODE_PLUGIN_CACHE_DIR can point directly at an arbitrary cache
      // root; requiring literal plugins/cache ancestors would reject this.
      const customVersionsRoot = path.join(
        fixtureHome, "overridden-plugin-cache",
        "jarrodwatts-claude-delegator", "claude-delegator"
      );
      const customInstall = path.join(customVersionsRoot, manifest.version);
      writeVerifiedInstall(customInstall);
      fs.writeFileSync(path.join(customProfile, ".claude.json"), JSON.stringify({
        mcpServers: {
          cursor: { command: "node", args: [historical(customVersionsRoot, "1.8.0", "cursor")] },
          copilot: { command: "node", args: [historical(customVersionsRoot, "1.9.0-rc.1+build.5", "copilot")] },
          gemini: { command: "node", args: [historical(customVersionsRoot, "1.4.0", "gemini")] },
          agy: { command: "node", args: [historical(foreignVersionsRoot, "1.8.0", "agy")] }
        }
      }));
      const customScan = runScanner({
        profile: customProfile,
        pluginList: [pluginRecord(customInstall)]
      });
      assert.equal(customScan.status, 0, `${label}: custom-profile scanner failed: ${customScan.stderr}`);
      assert.deepEqual(
        outputNames(customScan),
        ["copilot", "cursor", "gemini"],
        `${label}: profile and cache overrides must stay independent and authoritative`
      );

      const invalidRoots = [
        ["zero active records", []],
        ["ambiguous active records", [defaultRecord, { ...defaultRecord }]],
        ["noncanonical installPath", [pluginRecord(`${activeInstall}${path.sep}..${path.sep}${manifest.version}`)]],
        ["malformed installPath", [pluginRecord(path.join(fixtureHome, "unowned", manifest.version))]],
        ["root-relative Windows installPath", [pluginRecord("\\plugins\\cache\\jarrodwatts-claude-delegator\\claude-delegator\\1.9.1")]],
        ["device-namespace installPath", [pluginRecord("//?/C:/plugins/cache/jarrodwatts-claude-delegator/claude-delegator/1.9.1")]]
      ];
      if (process.platform === "win32") {
        invalidRoots.push([
          "forward-slash root-relative Windows installPath",
          [pluginRecord("/plugins/cache/jarrodwatts-claude-delegator/claude-delegator/1.9.1")]
        ]);
      }
      for (const [caseName, pluginList] of invalidRoots) {
        const failed = runScanner({ pluginList });
        assert.notEqual(failed.status, 0, `${label}: ${caseName} must fail closed`);
        assert.deepEqual(outputNames(failed), [], `${label}: ${caseName} emitted a removal candidate`);
        if (/root-relative|device-namespace|noncanonical/.test(caseName)) {
          assert.match(failed.stderr, /not canonical and fully qualified/);
          assert.doesNotMatch(failed.stderr, /ENOENT/);
        }
      }

      const missingManifestInstall = path.join(
        fixtureHome, "missing-manifest-cache",
        "jarrodwatts-claude-delegator", "claude-delegator", manifest.version
      );
      fs.mkdirSync(missingManifestInstall, { recursive: true });
      const missingManifest = runScanner({ pluginList: [pluginRecord(missingManifestInstall)] });
      assert.notEqual(missingManifest.status, 0, `${label}: missing active manifest must fail closed`);
      assert.deepEqual(outputNames(missingManifest), []);

      const mismatchInstall = path.join(
        fixtureHome, "mismatch-cache",
        "jarrodwatts-claude-delegator", "claude-delegator", manifest.version
      );
      writeVerifiedInstall(mismatchInstall, { mcpServers: { codex: manifest.mcpServers.codex } });
      const mismatchedManifest = runScanner({ pluginList: [pluginRecord(mismatchInstall)] });
      assert.notEqual(mismatchedManifest.status, 0, `${label}: incomplete active manifest must fail closed`);
      assert.deepEqual(outputNames(mismatchedManifest), []);
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

test("maintenance docs describe the active profile and conditional Codex self-disable accurately", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
  const maintainerGuide = fs.readFileSync(path.resolve(__dirname, "../CLAUDE.md"), "utf8");

  assert.doesNotMatch(readme, /Codex entry disables its own nested/);
  assert.match(readme, /static plugin manifest cannot safely disable `mcp_servers\.codex`/i);
  assert.match(readme, /add `-c mcp_servers\.codex\.enabled=false`/);
  assert.match(
    readme,
    /`CODEX_DELEGATOR_CODEX_BIN` override must be a POSIX absolute path or a fully-qualified Windows drive\/UNC path/
  );
  assert.match(readme, /root-relative \(`\\path`\) and drive-relative \(`C:path`\) values are rejected/);
  assert.match(readme, /device-namespace, malformed UNC, and\s+dot-segment roots are ignored/);
  assert.match(
    maintainerGuide,
    /`server\/shared\/provider-runtime\.js` \| Shared custom-provider runtime/
  );
  assert.match(
    maintainerGuide,
    /active Claude profile at `\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}\/rules\/delegator\/`/
  );
  assert.doesNotMatch(maintainerGuide, /Installed to `~\/\.claude\/rules\/delegator\/`/);
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

  // commands/setup.md copies rules/*.md into the active Claude profile, so these
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
