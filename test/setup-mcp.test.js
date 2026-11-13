"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const catalog = require("../config/providers.json");
const { MAX_TIMEOUT_MS } = require("../server/shared/bridge");
const { setupClient } = require("../scripts/setup-mcp");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "setup-mcp.js");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "delegator-setup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function expectedNames(client) {
  return [...Object.keys(catalog.providers), ...Object.keys(catalog.utilities)]
    .filter((name) => name !== client).sort();
}

for (const client of ["copilot", "kimi"]) {
  test(`${client} setup preserves other MCP servers and is repeatable`, (t) => {
    const home = fixture(t);
    const directory = path.join(home, client === "copilot" ? ".copilot" : ".kimi-code");
    const file = path.join(directory, client === "copilot" ? "mcp-config.json" : "mcp.json");
    const iris = { command: "iris", args: ["mcp", "--client", client], env: { KEEP: "unchanged" } };
    fs.mkdirSync(directory);
    fs.writeFileSync(file, JSON.stringify({ custom: true, mcpServers: { iris } }), { mode: 0o600 });

    const result = setupClient(client, { home, environment: {} });
    const first = fs.readFileSync(file, "utf8");
    setupClient(client, { home, environment: {} });
    assert.equal(fs.readFileSync(file, "utf8"), first);
    assert.deepEqual(result.servers.sort(), expectedNames(client));
    const config = JSON.parse(first);
    assert.equal(config.custom, true);
    assert.deepEqual(config.mcpServers.iris, iris);
    assert.equal(Object.hasOwn(config.mcpServers, client), false);
    assert.deepEqual(config.mcpServers.claude.args, [path.join(ROOT, "server", "claude", "index.js")]);
    if (client === "copilot") {
      assert.equal(config.mcpServers.claude.type, "local");
      assert.deepEqual(config.mcpServers.claude.tools, ["claude", "claude-reply"]);
      assert.ok(config.mcpServers.claude.timeout > MAX_TIMEOUT_MS);
    } else {
      assert.equal(config.mcpServers.claude.enabled, true);
      assert.deepEqual(config.mcpServers.claude.enabledTools, ["claude", "claude-reply"]);
      assert.equal(config.mcpServers.claude.startupTimeoutMs, 45_000);
      assert.ok(config.mcpServers.claude.toolTimeoutMs > MAX_TIMEOUT_MS);
    }
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
  });

  test(`${client} setup respects its home override and creates a missing configuration`, (t) => {
    const home = fixture(t);
    const override = path.join(home, "custom home");
    const key = client === "copilot" ? "COPILOT_HOME" : "KIMI_CODE_HOME";
    const result = setupClient(client, { home, environment: { [key]: override } });
    assert.equal(path.dirname(result.config), override);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(result.config)).mcpServers).sort(), expectedNames(client));
    if (process.platform !== "win32") assert.equal(fs.statSync(result.config).mode & 0o777, 0o600);
  });
}

test("JSON setup preflights all collisions and leaves malformed or unrelated configuration untouched", (t) => {
  const home = fixture(t);
  const directory = path.join(home, ".kimi-code");
  const file = path.join(directory, "mcp.json");
  fs.mkdirSync(directory);
  for (const source of [
    '{"mcpServers":',
    '{"mcpServers":[]}',
    '{"mcpServers":{"usage":{"command":"another-server","args":[]}}}'
  ]) {
    fs.writeFileSync(file, source);
    assert.throws(() => setupClient("kimi", { home, environment: {} }), /not changed|nothing was overwritten/);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("JSON setup preserves a symlinked configuration and existing bridge overrides", {
  skip: process.platform === "win32" ? "file symlinks require Windows developer privileges" : false
}, (t) => {
  const home = fixture(t);
  const target = path.join(home, "dotfiles.json");
  const directory = path.join(home, ".kimi-code");
  const file = path.join(directory, "mcp.json");
  fs.mkdirSync(directory);
  fs.writeFileSync(target, JSON.stringify({
    mcpServers: { claude: { command: "node", args: [path.join(ROOT, "server", "claude", "index.js")], env: { KEEP: "yes" } } }
  }));
  fs.symlinkSync(target, file);
  setupClient("kimi", { home, environment: {} });
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(target)).mcpServers.claude.env, { KEEP: "yes" });
});

// grok 1.0.77's `inspect --json` entry for the delegator plugin's own grok server.
const INHERITED_GROK = {
  name: "grok",
  transport: "stdio",
  target: "node index.js",
  source: { type: "plugin", plugin_name: "claude-delegator", path: "/plugins/claude-delegator/3.3.2" }
};

// Stands in for the grok CLI. Like grok 1.0.77, every `mcp` write rewrites
// config.toml and drops its comments.
function fakeGrok(home, { inherited = [INHERITED_GROK], configured = [] } = {}) {
  const config = path.join(home, ".grok", "config.toml");
  const state = { calls: [], configured: [...configured] };
  const rewrite = (prefix = "") => {
    const text = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, prefix + text.split("\n").filter((line) => !line.startsWith("#")).join("\n"));
  };
  state.run = (args) => {
    state.calls.push(args);
    if (args[0] === "inspect") return JSON.stringify({ mcpServers: [...state.configured, ...inherited] });
    if (args[1] === "list") return JSON.stringify(state.configured);
    if (args[1] === "disable") {
      rewrite('disabled_mcp_servers = ["grok"]\n');
      return "";
    }
    const [, , , scope, name, , command, ...serverArgs] = args;
    state.configured = [...state.configured.filter((server) => server.name !== name),
      { name, scope, command, args: serverArgs, enabled: true }];
    rewrite();
    return "";
  };
  return state;
}

test("Grok setup uses its native user-scope configuration command and excludes Grok itself", (t) => {
  const home = fixture(t);
  const grok = fakeGrok(home, {
    configured: [{ name: "iris", command: "iris", args: ["mcp"], scope: "user", enabled: true }]
  });
  setupClient("grok", { home, runGrok: grok.run });
  const first = structuredClone(grok.configured);
  const firstCalls = grok.calls.length;
  setupClient("grok", { home, runGrok: grok.run });
  assert.deepEqual(grok.configured, first);
  assert.deepEqual(grok.configured.filter(({ name }) => name !== "iris").map(({ name }) => name).sort(), expectedNames("grok"));
  const adds = grok.calls.filter((args) => args[1] === "add");
  assert.equal(adds.length, expectedNames("grok").length);
  assert.ok(adds.every((args) => args[2] === "--scope" && args[3] === "user"));
  assert.deepEqual(grok.calls.filter((args) => args[1] === "disable"), [["mcp", "disable", "grok"]]);
  // The second run finds everything in place and writes nothing, so it cannot
  // cost Iris its markers.
  assert.deepEqual(grok.calls.slice(firstCalls), [["mcp", "list", "--json"], ["inspect", "--json"]]);
  assert.deepEqual(grok.configured.find(({ name }) => name === "claude").args, [path.join(ROOT, "server", "claude", "index.js")]);
});

test("Grok setup also recognises the inherited self-target in its string form", (t) => {
  const home = fixture(t);
  const grok = fakeGrok(home, { inherited: [{ name: "grok", source: "plugin: claude-delegator" }] });
  setupClient("grok", { home, runGrok: grok.run });
  assert.deepEqual(grok.calls.filter((args) => args[1] === "disable"), [["mcp", "disable", "grok"]]);
});

test("Grok setup warns when grok drops Iris's markers, and only then", (t) => {
  const marked = '[cli]\n# >>> iris >>>\n[mcp_servers.iris]\ncommand = "iris"\n# <<< iris <<<\n';
  for (const [initial, warned] of [[marked, true], ["[cli]\n", false]]) {
    const home = fixture(t);
    fs.mkdirSync(path.join(home, ".grok"));
    fs.writeFileSync(path.join(home, ".grok", "config.toml"), initial);
    const grok = fakeGrok(home);
    const { warnings } = setupClient("grok", { home, runGrok: grok.run });
    assert.equal(warnings.length, warned ? 1 : 0);
    if (warned) assert.match(warnings[0], /iris setup --clients grok --yes/);

    // Once Iris has restored its block, a repeat run leaves it alone.
    fs.appendFileSync(path.join(home, ".grok", "config.toml"), "\n# >>> iris >>>\n# <<< iris <<<\n");
    assert.deepEqual(setupClient("grok", { home, runGrok: grok.run }).warnings, []);
  }
});

test("Grok setup refuses collisions, project shadows, and invalid listings before adding anything", () => {
  for (const listing of [
    "not JSON",
    "{}",
    JSON.stringify([{ name: "usage", scope: "user", command: "unrelated", args: [] }]),
    JSON.stringify([{ name: "claude", scope: "project", command: "node", args: [path.join(ROOT, "server", "claude", "index.js")] }])
  ]) {
    const calls = [];
    assert.throws(() => setupClient("grok", {
      runGrok: (args) => { calls.push(args); return listing; }
    }), /not changed|nothing was overwritten/);
    assert.deepEqual(calls, [["mcp", "list", "--json"]]);
  }
});

test("Grok setup does not disable missing or unrelated same-named MCP servers", (t) => {
  for (const mcpServers of [
    [],
    [{ name: "grok", source: "plugin: unrelated" }],
    [{ name: "grok", source: { type: "plugin", plugin_name: "unrelated", path: "/plugins/unrelated" } }],
    [{ name: "grok", source: { type: "configToml", path: "/home/user/.grok/config.toml" } }]
  ]) {
    const calls = [];
    setupClient("grok", {
      home: fixture(t),
      runGrok: (args) => {
        calls.push(args);
        if (args[1] === "list") return "[]";
        if (args[0] === "inspect") return JSON.stringify({ mcpServers });
        return "";
      }
    });
    assert.equal(calls.some((args) => args[1] === "disable"), false);
  }
});

test("Grok setup rejects an invalid inheritance inspection before applying changes", () => {
  for (const inspection of ["not JSON", "{}", '{"mcpServers":[null]}']) {
    const calls = [];
    assert.throws(() => setupClient("grok", {
      runGrok: (args) => {
        calls.push(args);
        return args[1] === "list" ? "[]" : inspection;
      }
    }), /not changed/);
    assert.deepEqual(calls, [["mcp", "list", "--json"], ["inspect", "--json"]]);
  }
});

test("native registration failures are surfaced instead of reporting success", (t) => {
  assert.throws(() => setupClient("grok", {
    home: fixture(t),
    runGrok: (args) => {
      if (args[1] === "list") return "[]";
      if (args[0] === "inspect") return '{"mcpServers":[]}';
      throw new Error("grok could not save config");
    }
  }), /grok could not save config/);
});

test("the setup CLI requires an explicit supported client", () => {
  for (const args of [[], ["--client", "claude"], ["--client", "copilot", "--unexpected"]]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Setup failed:/);
  }
});
