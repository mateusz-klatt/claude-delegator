"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { afterEach, test } = require("node:test");

const usage = require("./index.js");

const SERVER_PATH = path.join(__dirname, "index.js");
const temporaryDirectories = [];
const runningServers = new Set();

afterEach(() => {
  for (const server of runningServers) server.kill();
  runningServers.clear();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

function withPath(source, value) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^path$/i.test(key)));
  env.PATH = value;
  return env;
}

const CLAUDE_USAGE_TEXT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 12% used · resets Nov 5, 9:10pm (UTC)",
  "Current week (all models): 80% used · resets Nov 6, 7am (UTC)",
  "",
  "What's contributing to your usage?"
].join("\n");

const COPILOT_USER = {
  login: "octo",
  copilot_plan: "individual_pro",
  access_type_sku: "plus_monthly_subscriber_quota",
  quota_reset_date: "2026-12-01",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 7000,
      remaining: 1702,
      percent_remaining: 24.3,
      unlimited: false,
      overage_permitted: true,
      overage_entitlement: 500,
      overage_count: 0,
      token_based_billing: true
    }
  }
};

const COPILOT_CATALOG = [
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    model_picker_enabled: true,
    capabilities: { supports: { reasoning_effort: ["low", "max"] } },
    billing: {
      restricted_to: ["pro_plus", "max"],
      auto_discount: 0.1,
      token_prices: {
        batch_size: 1_000_000,
        default: { input_price: 200, cache_read_price: 10, cache_write_price: 250, output_price: 1000, max_prompt_tokens: 272000 }
      }
    }
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    model_picker_enabled: true,
    capabilities: { supports: {} },
    billing: { token_prices: { default: { input_price: 100, output_price: 500 } } }
  },
  { id: "gpt-4o", model_picker_enabled: false, billing: {} }
];

function writeStub(directory, name, body) {
  const scriptPath = path.join(directory, `${name}-stub.js`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n"use strict";\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nif (args.includes("--version")) { process.stdout.write("${name} 1.0.0\\n"); process.exit(0); }\nif (process.env.USAGE_STUB_CAPTURE) fs.appendFileSync(process.env.USAGE_STUB_CAPTURE, JSON.stringify({ name: ${JSON.stringify(name)}, args, cwd: process.cwd(), agentMailToken: process.env.AGENT_MAIL_REGISTRATION_TOKEN }) + "\\n");\n${body}\n`, { mode: 0o755 });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(directory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const executablePath = path.join(directory, name);
    fs.copyFileSync(scriptPath, executablePath);
    fs.chmodSync(executablePath, 0o755);
  }
}

function createStubs() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "usage-server-test-")));
  temporaryDirectories.push(directory);
  const cacheHome = path.join(directory, "cache");
  fs.mkdirSync(path.join(cacheHome, "copilot"), { recursive: true });
  fs.writeFileSync(path.join(cacheHome, "copilot", "copilot-user-cache.json"),
    "// Disposable cache for Copilot user responses, safe to delete.\n" + JSON.stringify({
      copilotUserCache: {
        "v1:old": { retrievedAt: "2026-11-01T00:00:00.000Z", response: { ...COPILOT_USER, copilot_plan: "individual" } },
        "v1:new": { retrievedAt: "2026-11-05T17:12:53.031Z", response: { ...COPILOT_USER, quota_snapshots: { premium_interactions: { ...COPILOT_USER.quota_snapshots.premium_interactions, remaining: 1718 } } } },
        // Another account's token, cached later: it must never be reported for octo.
        "v1:other": { retrievedAt: "2026-11-05T18:00:00.000Z", response: { ...COPILOT_USER, login: "someone-else", quota_snapshots: { premium_interactions: { ...COPILOT_USER.quota_snapshots.premium_interactions, remaining: 9 } } } }
      }
    }));

  writeStub(directory, "codex", `
if (args[0] !== "app-server") process.exit(2);
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  if (message.method === "initialize") reply({ userAgent: "stub" });
  if (message.method === "account/rateLimits/read") reply({
    rateLimits: { limitId: "codex", planType: "plus" },
    rateLimitsByLimitId: { codex: {
      limitId: "codex", planType: "plus",
      primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1793916732 },
      secondary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: 1794383583 },
      credits: { hasCredits: false, unlimited: false, balance: "0" }, rateLimitReachedType: null
    } }
  });
  if (message.method === "model/list") reply({ data: [
    { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", hidden: false, isDefault: true, defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
      serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }] },
    { id: "hidden-model", hidden: true }
  ] });
});`);

  writeStub(directory, "claude", `
const turns = process.env.CLAUDE_STUB_RAN_MODEL === "1" ? 1 : 0;
process.stdout.write(JSON.stringify({ is_error: false, num_turns: turns, total_cost_usd: turns * 0.01, usage: { input_tokens: turns * 10, output_tokens: 0 }, result: process.env.CLAUDE_STUB_TEXT }));`);

  writeStub(directory, "copilot", `
if (process.env.COPILOT_STUB_RAN_MODEL === "1") { process.stdout.write("OK\\n"); process.exit(0); }
// The real CLI records a session under COPILOT_HOME even for a rejected model.
const sessionDirectory = path.join(process.env.COPILOT_HOME, "session-state", "11111111-2222-3333-4444-555555555555");
fs.mkdirSync(path.join(sessionDirectory, "checkpoints"), { recursive: true });
fs.writeFileSync(path.join(sessionDirectory, "workspace.yaml"), "id: 11111111-2222-3333-4444-555555555555\\ncwd: " + process.cwd() + "\\n");
fs.mkdirSync(path.join(process.env.COPILOT_HOME, "session-state", ".session-operation-locks"), { recursive: true });
fs.writeFileSync(path.join(process.env.COPILOT_HOME, "session-state", ".session-operation-locks", "11111111-2222-3333-4444-555555555555.lock"), "");
const logDirectory = args[args.indexOf("--log-dir") + 1];
fs.mkdirSync(logDirectory, { recursive: true });
fs.writeFileSync(path.join(logDirectory, "process.log"),
  "2026-11-05T17:13:37.434Z [DEBUG] [rust:capi_models] fetched model catalog from CAPI " +
  JSON.stringify({ count: 3, models: process.env.COPILOT_STUB_CATALOG }) + "\\n");
process.stderr.write('Error: Model "' + args[args.indexOf("--model") + 1] + '" from --model flag is not available.\\n');
process.exit(1);`);

  writeStub(directory, "agy", `
if (process.env.AGY_STUB_HANG === "1") { setTimeout(() => {}, 120000); return; }
process.stdout.write(JSON.stringify(process.env.AGY_STUB_RAN_MODEL === "1"
  ? { status: "SUCCESS", response: "I cannot show usage", num_turns: 1, usage: { total_tokens: 42 } }
  : { status: "SUCCESS", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: {
      description: "Within each group, models share a weekly limit.",
      groups: [{ name: "Gemini Models", description: "Gemini Flash, Gemini Pro", buckets: [
        { window: "weekly", remaining_fraction: 0.281523197889328, reset_time: "2026-11-10T09:10:52Z" }] }]
    } } }));`);

  writeStub(directory, "cursor-agent", `
if (args[0] !== "about" || args[2] !== "json") process.exit(2);
process.stdout.write(JSON.stringify({ cliVersion: "2026.11.05-86047df", model: "Auto", subscriptionTier: "Free", userEmail: "octo@example.com" }));`);

  writeStub(directory, "kimi", `
if (args.join(" ") !== "provider list --json") process.exit(2);
process.stdout.write(process.env.KIMI_STUB_PROVIDERS || JSON.stringify({ providers: {}, models: {} }));`);

  writeStub(directory, "grok", `
if (args.join(" ") !== "agent stdio") process.exit(2);
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }) + "\\n");
  if (message.method === "initialize") reply({ result: { protocolVersion: 1, _meta: { modelState: { availableModels: [
    { modelId: "grok-4.7", name: "Grok 4.7", _meta: { totalContextTokens: 256000, reasoningEfforts: [{ value: "xhigh" }, { value: "high" }] } },
    { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast", description: "Fast variant. 2x the price." }
  ] } } } });
  else if (message.method === "_x.ai/billing") reply({ result: { subscription_tier: "SuperGrok", config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-02T17:20:28Z", end: "2026-11-09T17:20:28Z" },
    creditUsagePercent: 12.5, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 } } } });
  else reply({ error: { code: -32601, message: "Method not found" } });
});`);

  const home = path.join(directory, "home");
  const copilotHome = path.join(home, ".copilot");
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.writeFileSync(path.join(copilotHome, "config.json"),
    "// This file is managed automatically.\n" + JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "octo" } }));

  writeStub(directory, "gh", `
if (process.env.GH_STUB_FAIL === "1") { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
process.stdout.write(process.env.GH_STUB_USER);`);

  const systemBinaryPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  const env = withPath(process.env, [directory, path.dirname(process.execPath), systemBinaryPath].join(path.delimiter));
  delete env.CODEX_DELEGATOR_CODEX_BIN;
  return {
    directory,
    copilotHome,
    capturePath: path.join(directory, "calls.jsonl"),
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      COPILOT_HOME: copilotHome,
      XDG_CACHE_HOME: cacheHome,
      USAGE_STUB_CAPTURE: path.join(directory, "calls.jsonl"),
      CLAUDE_STUB_TEXT: CLAUDE_USAGE_TEXT,
      COPILOT_STUB_CATALOG: JSON.stringify(COPILOT_CATALOG),
      GH_STUB_USER: JSON.stringify(COPILOT_USER),
      AGENT_MAIL_REGISTRATION_TOKEN: "caller-registration-token"
    }
  };
}

function readCalls(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function startServer(extraEnv = {}) {
  const stubs = createStubs();
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...stubs.env, ...extraEnv },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  runningServers.add(child);
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  return {
    ...stubs,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}: ${stderr}`)), 30_000);
        pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
  };
}

async function callUsage(server, args = {}) {
  const response = await server.request("tools/call", { name: "usage", arguments: args });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return JSON.parse(response.result.content[0].text);
}

test("advertises one usage tool that names every provider", async () => {
  const server = startServer();
  const initialize = await server.request("initialize", {});
  assert.equal(initialize.result.serverInfo.name, "claude-delegator-usage");
  const list = await server.request("tools/list", {});
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["usage"]);
  assert.deepEqual(list.result.tools[0].inputSchema.properties.provider.enum,
    ["codex", "claude", "copilot", "agy", "kimi", "grok", "cursor", "all"]);
});

test("reports every provider without running a model on any of them", async () => {
  const server = startServer();
  const report = await callUsage(server);
  const { codex, claude, copilot, agy, kimi, grok, cursor } = report.providers;

  assert.deepEqual(agy.groups, [{ name: "Gemini Models", models: "Gemini Flash, Gemini Pro",
    windows: [{ label: "weekly", usedPercent: 71.8, resetsAt: "2026-11-10T09:10:52Z" }] }]);
  // kimi reports no Moonshot provider here, so nothing is sent anywhere.
  assert.match(kimi.error, /no provider of type kimi on a Moonshot host/);
  assert.deepEqual({ plan: grok.plan, period: grok.period.type, usedPercent: grok.usedPercent, onDemand: grok.onDemand },
    { plan: "SuperGrok", period: "weekly", usedPercent: 12.5, onDemand: { cap: 0, used: 0 } });
  assert.deepEqual(grok.models.map((model) => [model.id, model.efforts, model.contextTokens]),
    [["grok-4.7", ["xhigh", "high"], 256000], ["grok-4.7-build-fast", [], null]]);
  assert.deepEqual(cursor, { source: "cursor-agent about", plan: "Free", model: "Auto", cliVersion: "2026.11.05-86047df",
    windows: cursor.windows });
  assert.doesNotMatch(JSON.stringify(report), /octo@example\.com/);

  assert.equal(codex.planType, "plus");
  assert.deepEqual(codex.limits[0].windows.map((window) => [window.label, window.usedPercent]), [["5h", 4], ["weekly", 36]]);
  assert.equal(codex.limits[0].windows[0].resetsAt, "2026-11-05T22:12:12.000Z");
  assert.deepEqual(codex.models, [{
    id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, efforts: ["low", "ultra"], defaultEffort: "low",
    serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }]
  }]);

  assert.deepEqual(claude.windows.map((window) => [window.kind, window.usedPercent]), [["session", 12], ["weekly", 80]]);
  assert.equal(claude.windows[1].resets, "Nov 6, 7am (UTC)");

  assert.equal(copilot.source, "gh api /copilot_internal/user");
  assert.deepEqual([copilot.account, copilot.identityVerified, copilot.stale], ["octo", true, undefined]);
  assert.deepEqual(copilot.monthly, {
    unit: "AI credits", entitlement: 7000, remaining: 1702, used: 5298, usedPercent: 75.7, unlimited: false,
    overagePermitted: true, overageEntitlement: 500, overageUsed: 0, resetsOn: "2026-12-01"
  });
  assert.deepEqual(copilot.models.map((model) => [model.id, model.availableOnPlan]), [["gpt-6.1-sol", true], ["claude-haiku-4.5", true]]);
  assert.equal(copilot.models[0].pricePerMillionTokens.output, 1000);

  const calls = readCalls(server.capturePath);
  const claudeCall = calls.find((call) => call.name === "claude");
  assert.deepEqual(claudeCall.args.slice(0, 4), ["-p", "/usage", "--setting-sources", ""]);
  assert.ok(claudeCall.args.includes("--no-session-persistence"));
  const copilotCall = calls.find((call) => call.name === "copilot");
  assert.equal(copilotCall.args[copilotCall.args.indexOf("--model") + 1], "claude-delegator-usage-probe-not-a-model");
  for (const call of calls) assert.equal(call.agentMailToken, undefined, `${call.name} must not see Agent Mail credentials`);
  // The probe's session is removed; nothing it recorded survives.
  assert.deepEqual(fs.readdirSync(path.join(server.copilotHome, "session-state")).filter((name) => !name.startsWith(".")), []);
  assert.deepEqual(fs.readdirSync(path.join(server.copilotHome, "session-state", ".session-operation-locks")), []);
});

test("falls back to the Copilot plan cache when gh cannot answer", async () => {
  const server = startServer({ GH_STUB_FAIL: "1" });
  const report = await callUsage(server, { provider: "copilot", includeModels: false });
  const { copilot } = report.providers;
  assert.deepEqual(Object.keys(report.providers), ["copilot"]);
  assert.equal(copilot.source, "copilot plan cache");
  // The newer entry belongs to another account and is skipped.
  assert.equal(copilot.retrievedAt, "2026-11-05T17:12:53.031Z");
  assert.equal(copilot.monthly.remaining, 1718);
  assert.deepEqual([copilot.stale, copilot.routable], [true, false]);
  assert.equal(copilot.models, undefined);
  // Without models there is no probe run at all.
  assert.equal(readCalls(server.capturePath).some((call) => call.name === "copilot"), false);
});

test("ignores gh when it is signed in as a different account", async () => {
  const server = startServer({ GH_STUB_USER: JSON.stringify({ ...COPILOT_USER, login: "someone-else" }) });
  const { copilot } = (await callUsage(server, { provider: "copilot", includeModels: false })).providers;
  assert.equal(copilot.source, "copilot plan cache");
  assert.equal(copilot.account, "octo");
});

test("refuses to report Claude usage from a run that reached a model", async () => {
  const server = startServer({ CLAUDE_STUB_RAN_MODEL: "1" });
  const report = await callUsage(server, { provider: "claude" });
  assert.match(report.providers.claude.error, /answered \/usage with a model turn/);
});

test("one deadline covers a provider, and a slow one does not hold up the others", async () => {
  const server = startServer({ AGY_STUB_HANG: "1" });
  const started = Date.now();
  const report = await callUsage(server, { provider: "all", includeModels: false, timeout: 10_000 });
  assert.match(report.providers.agy.error, /timed out after 10s/);
  assert.ok(Date.now() - started < 20_000);
  assert.equal(report.providers.codex.limits[0].windows.length, 2);
});

test("refuses to report Copilot usage from a run that reached a model", async () => {
  const server = startServer({ COPILOT_STUB_RAN_MODEL: "1" });
  const report = await callUsage(server, { provider: "copilot" });
  assert.match(report.providers.copilot.error, /accepted the probe model id/);
});

test("a failing provider does not hide the others", async () => {
  const server = startServer({ CLAUDE_STUB_TEXT: "Usage is unavailable right now" });
  const report = await callUsage(server, { includeModels: false });
  assert.match(report.providers.claude.error, /no usage windows/);
  assert.equal(report.providers.codex.limits[0].windows.length, 2);
  assert.equal(report.providers.copilot.monthly.entitlement, 7000);
});

test("rejects malformed arguments before spawning anything", async () => {
  const server = startServer();
  for (const [args, message] of [
    [{ provider: "gemini" }, /'provider' must be one of/],
    [{ includeModels: "yes" }, /'includeModels' must be a boolean/],
    [{ timeout: 1.5 }, /'timeout' must be an integer/],
    [{ extra: true }, /unknown argument 'extra'/]
  ]) {
    const response = await server.request("tools/call", { name: "usage", arguments: args });
    assert.match(response.error.message, message);
  }
  const unknown = await server.request("tools/call", { name: "codex", arguments: {} });
  assert.match(unknown.error.message, /Unknown tool/);
  assert.deepEqual(readCalls(server.capturePath), []);
});

test("parses Claude usage lines and ignores everything else", () => {
  assert.deepEqual(usage.parseClaudeUsage(CLAUDE_USAGE_TEXT).windows, [
    { label: "Current session", kind: "session", usedPercent: 12, resets: "Nov 5, 9:10pm (UTC)" },
    { label: "Current week (all models)", kind: "weekly", usedPercent: 80, resets: "Nov 6, 7am (UTC)" }
  ]);
  assert.deepEqual(usage.parseClaudeUsage("Current week (Opus): 3% used").windows,
    [{ label: "Current week (Opus)", kind: "weekly", usedPercent: 3, resets: null }]);
  assert.deepEqual(usage.parseClaudeUsage("nothing to see").windows, []);
});

test("maps Copilot plans onto billing restrictions", () => {
  const [sol] = usage.summarizeCopilotModels(COPILOT_CATALOG, "pro");
  assert.equal(sol.availableOnPlan, false);
  assert.equal(usage.summarizeCopilotModels(COPILOT_CATALOG, undefined)[0].availableOnPlan, null);
  assert.equal(usage.summarizeCopilotQuota({}).monthly.used, null);
});

test("looks for the Copilot cache where each platform keeps it", () => {
  const home = path.join(path.sep, "home", "alice");
  assert.deepEqual(usage.copilotCacheCandidates({ environment: {}, home, platform: "linux" }),
    [path.join(home, ".cache", "copilot", "copilot-user-cache.json")]);
  assert.equal(usage.copilotCacheCandidates({ environment: {}, home, platform: "darwin" })[0],
    path.join(home, "Library", "Caches", "copilot", "copilot-user-cache.json"));
  assert.equal(usage.copilotCacheCandidates({ environment: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, home, platform: "win32" })[0],
    path.join("C:\\Users\\alice\\AppData\\Local", "copilot", "copilot-user-cache.json"));
  assert.equal(usage.latestCopilotUserEntry([path.join(home, "missing.json")]), null);
});

test("refuses to report Agy usage from a run that reached a model", async () => {
  const server = startServer({ AGY_STUB_RAN_MODEL: "1" });
  const report = await callUsage(server, { provider: "agy" });
  assert.match(report.providers.agy.error, /answered \/usage with a model turn/);
});

test("asks kimi for its providers and sends each key only to its Moonshot host", async () => {
  const config = { providers: {
    "moonshot-ai": { type: "kimi", baseUrl: "https://api.moonshot.ai/v1", apiKey: "sk-moonshot" },
    "from-env": { type: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyEnv: "MY_MOONSHOT_KEY" },
    lookalike: { type: "kimi", baseUrl: "https://api.moonshot.ai.example.com/v1", apiKey: "sk-lookalike" },
    plain: { type: "kimi", baseUrl: "http://api.moonshot.ai/v1", apiKey: "sk-plain" },
    "ollama-local": { type: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" }
  } };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options.headers.Authorization]);
    return { ok: true, status: 200, json: async () => ({ status: true, data: { available_balance: 7.5, cash_balance: 4.9, voucher_balance: 2.6 } }) };
  };
  const report = await usage.kimiUsage({ timeoutMs: 10_000, environment: { MY_MOONSHOT_KEY: "sk-env", KIMI_API_KEY: "sk-generic" }, fetchImpl, listProviders: async () => config });
  assert.deepEqual(requests, [
    ["https://api.moonshot.ai/v1/users/me/balance", "Bearer sk-moonshot"],
    ["https://api.moonshot.cn/v1/users/me/balance", "Bearer sk-env"]
  ]);
  assert.deepEqual(report.balances.map((balance) => [balance.provider, balance.currency, balance.available]),
    [["moonshot-ai", "USD", 7.5], ["from-env", "CNY", 7.5]]);

  // A named but unset key variable does not fall back to an unrelated key.
  assert.equal(usage.moonshotAccounts({ providers: { x: { type: "kimi", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "UNSET" } } },
    { KIMI_API_KEY: "sk-generic" })[0].key, null);

  const failing = async () => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }) });
  await assert.rejects(usage.kimiUsage({ timeoutMs: 10_000, environment: {}, fetchImpl: failing,
    listProviders: async () => ({ providers: { a: config.providers["moonshot-ai"] } }) }), /HTTP 401/);

  // A transport error that quotes the header must not carry the key into the report.
  const leaky = async (_url, options) => { throw new TypeError(`invalid header value ${options.headers.Authorization}`); };
  const error = await usage.kimiUsage({ timeoutMs: 10_000, environment: {}, fetchImpl: leaky,
    listProviders: async () => ({ providers: { a: config.providers["moonshot-ai"] } }) }).catch((rejection) => rejection);
  assert.match(error.message, /balance request failed \(TypeError\)/);
  assert.doesNotMatch(error.message, /sk-moonshot/);
  const unsafe = await usage.kimiUsage({ timeoutMs: 10_000, environment: {}, fetchImpl,
    listProviders: async () => ({ providers: { a: { ...config.providers["moonshot-ai"], apiKey: "sk-bad\nkey" } } }) }).catch((rejection) => rejection);
  assert.match(unsafe.message, /characters a header cannot carry/);
  assert.doesNotMatch(unsafe.message, /sk-bad/);
});

test("summarizes Grok billing and Cursor's JSON about output", () => {
  assert.deepEqual(usage.summarizeGrokBilling({}), {
    plan: null, period: null, usedPercent: null, monthlyLimit: null, onDemand: { cap: null, used: null }, prepaidBalance: null
  });
  assert.deepEqual(usage.summarizeGrokModels(undefined), []);
  assert.deepEqual(usage.parseCursorAbout(JSON.stringify({ subscriptionTier: "Pro", userEmail: "a@b.c" })),
    { plan: "Pro", model: null, cliVersion: null });
});
