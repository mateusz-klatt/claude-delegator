#!/usr/bin/env node

/**
 * Claude Delegator - Usage MCP Server
 *
 * Reports the short-window, weekly and monthly usage of every delegated CLI's
 * subscription, plus what each CLI says about per-model cost, without running a
 * model on any of them. Speaks JSON-RPC 2.0 over stdio.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const core = require("../shared/bridge");
const { version: PACKAGE_VERSION } = require("../../package.json");
const { buildCalleeEnv } = require("../shared/environment.js");
const codexBridge = require("../codex/index.js");
const claudeBridge = require("../claude/index.js");
const copilotBridge = require("../copilot/index.js");
const agyBridge = require("../agy/index.js");
const cursorBridge = require("../cursor/index.js");
const kimiBridge = require("../kimi/index.js");
const grokBridge = require("../grok/index.js");

const {
  IS_WINDOWS, clampTimeout, homedir, isObject, killProcessTree, resolveCli,
  runStdioLoop, sendError, sendResponse, spawnTarget, superviseChild
} = core;

const PROVIDERS = ["codex", "claude", "copilot", "agy", "kimi", "grok", "cursor"];
const DEFAULT_USAGE_TIMEOUT_MS = 60_000;
const activeRequests = new Map();
const activeChildren = new Set();

// An id no catalog will ever carry. Copilot refreshes its plan cache and logs
// its model catalog during startup, then rejects the model before any model
// call, so the probe costs no AI credits.
const COPILOT_PROBE_MODEL = "claude-delegator-usage-probe-not-a-model";

// billing.restricted_to names plans; copilot_plan names the same plans differently.
const COPILOT_PLAN_KEYS = {
  free: "free",
  individual: "pro",
  individual_pro: "pro_plus",
  individual_max: "max",
  individual_trial: "individual_trial",
  individual_edu: "edu",
  business: "business",
  enterprise: "enterprise",
  edu: "edu"
};

const USAGE_TOOLS = [
  {
    name: "usage",
    description: "Report subscription usage (short window, weekly, monthly, balance) and per-model cost information for Codex, Claude, Copilot, Agy, Kimi, Grok and Cursor. Runs no model and spends no tokens or credits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: [...PROVIDERS, "all"], default: "all", description: "Which CLI to report on" },
        includeModels: { type: "boolean", default: true, description: "Include per-model cost and mode information" },
        timeout: {
          type: "integer",
          minimum: core.MIN_TIMEOUT_MS,
          maximum: core.MAX_TIMEOUT_MS,
          default: DEFAULT_USAGE_TIMEOUT_MS,
          description: "Per-provider deadline in milliseconds"
        }
      }
    }
  }
];

function isoFromEpochSeconds(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function windowLabel(minutes) {
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// --- Codex: account/rateLimits/read and model/list over `codex app-server` ---

function codexWindow(window) {
  if (!isObject(window)) return null;
  return {
    label: windowLabel(window.windowDurationMins),
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins,
    resetsAt: isoFromEpochSeconds(window.resetsAt)
  };
}

function summarizeCodexLimits(result) {
  const limits = result.rateLimitsByLimitId || { [result.rateLimits?.limitId || "codex"]: result.rateLimits };
  return {
    planType: result.rateLimits?.planType ?? null,
    limits: Object.entries(limits).filter(([, limit]) => isObject(limit)).map(([limitId, limit]) => ({
      limitId,
      windows: [codexWindow(limit.primary), codexWindow(limit.secondary)].filter(Boolean),
      credits: limit.credits ?? null,
      rateLimitReachedType: limit.rateLimitReachedType ?? null
    }))
  };
}

function summarizeCodexModels(result) {
  return (result.data || []).filter((model) => !model.hidden).map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault === true,
    efforts: (model.supportedReasoningEfforts || []).map((entry) => entry.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort ?? null,
    serviceTiers: (model.serviceTiers || []).map((tier) => ({ id: tier.id, name: tier.name, description: tier.description }))
  }));
}

// `codex app-server` and `grok agent stdio` speak JSON-RPC over stdin, which
// superviseChild deliberately closes, so these children are driven directly.
// `run(request, notify)` performs the conversation and returns its result.
function jsonRpcSession({ binary, args, label, run, timeoutMs, abortSignal, jsonrpc = false }) {
  const target = spawnTarget(binary, args);
  return new Promise((resolve, reject) => {
    const child = spawn(target.command, target.args, {
      detached: !IS_WINDOWS,
      env: buildCalleeEnv(process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    activeChildren.add(child);
    const pending = new Map();
    let buffer = "";
    let stderr = "";
    let settled = false;
    let exited = false;

    // The child stays in activeChildren until it actually exits, so a server
    // shutdown can still reach one that ignored SIGTERM.
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!exited) {
        killProcessTree(child, "SIGTERM");
        setTimeout(() => { if (!exited) killProcessTree(child, "SIGKILL"); }, 3_000).unref();
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Request cancelled"));
    const timer = setTimeout(() => finish(new Error(`${label} did not answer within ${timeoutMs} ms`)), timeoutMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => { exited = true; activeChildren.delete(child); finish(error); });
    child.on("close", (code) => {
      exited = true;
      activeChildren.delete(child);
      finish(new Error(`${label} exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const resolveRequest = pending.get(message.id);
        if (resolveRequest) {
          pending.delete(message.id);
          resolveRequest(message);
        }
      }
    });

    const envelope = (message) => JSON.stringify(jsonrpc ? { jsonrpc: "2.0", ...message } : message) + "\n";
    let nextId = 0;
    const request = (method, params) => new Promise((resolveRequest, rejectRequest) => {
      nextId += 1;
      pending.set(nextId, (response) => {
        if (response.error) rejectRequest(new Error(`${method} failed: ${response.error.message}`));
        else resolveRequest(response.result);
      });
      child.stdin.write(envelope({ id: nextId, method, params }));
    });
    const notify = (method, params) => child.stdin.write(envelope({ method, params }));

    run(request, notify).then((value) => finish(null, value), (error) => finish(error));
  });
}

async function codexUsage({ includeModels, timeoutMs, abortSignal }) {
  const requests = [["limits", "account/rateLimits/read", null]];
  if (includeModels) requests.push(["models", "model/list", {}]);
  const results = await jsonRpcSession({
    binary: codexBridge.resolveCodexBinary(), args: ["app-server"], label: "codex app-server", timeoutMs, abortSignal,
    run: async (request, notify) => {
      await request("initialize", { clientInfo: { name: "claude-delegator-usage", version: PACKAGE_VERSION } });
      notify("initialized");
      const results = {};
      for (const [key, method, params] of requests) results[key] = await request(method, params);
      return results;
    }
  });
  const usage = { source: "codex app-server: account/rateLimits/read", ...summarizeCodexLimits(results.limits) };
  if (includeModels) {
    usage.models = summarizeCodexModels(results.models);
    usage.costNote = "Codex reports no per-model price. Usage is drawn from the plan's windows above; the priority (Fast) service tier is described by Codex as increased usage.";
  }
  return usage;
}

// --- Claude: `claude -p /usage`, which renders the subscription windows locally ---

function parseClaudeUsage(text) {
  const windows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s+used(?:\s*·\s*resets\s+(.+))?$/i);
    if (!match) continue;
    const label = match[1].trim();
    windows.push({
      label,
      kind: /session/i.test(label) ? "session" : (/week/i.test(label) ? "weekly" : "other"),
      usedPercent: Number(match[2]),
      resets: match[3]?.trim() ?? null
    });
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || "";
  return { billing: firstLine.trim(), windows };
}

async function claudeUsage({ timeoutMs, abortSignal }) {
  const binary = resolveCli("claude", { aliases: ["@anthropic-ai"], fallbacks: claudeBridge.cliFallbacks() });
  // No user settings means no hooks and no plugins, and no MCP servers; OAuth
  // still applies, which --bare would drop. /usage is answered locally with
  // zero turns and zero cost.
  const args = ["-p", "/usage", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"];
  const env = { ...buildCalleeEnv(process.env), TZ: "UTC" };
  const output = await superviseChild({
    abortSignal, activeChildren, args, binary, cwd: os.tmpdir(), env, label: "Claude",
    notFoundHint: "Install Claude Code and run `claude` once to sign in.",
    timeoutMs,
    onClose: ({ code, stdout, stderr }) => {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {
        throw new Error(`claude /usage returned no JSON (exit ${code})${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`);
      }
      if (parsed.is_error) throw new Error(`claude /usage failed: ${parsed.result || "unknown error"}`);
      // /usage is answered locally; any turn, cost or token means a model ran.
      const usage = parsed.usage || {};
      if (parsed.num_turns !== 0 || parsed.total_cost_usd !== 0 || usage.input_tokens || usage.output_tokens) {
        throw new Error("claude answered /usage with a model turn; refusing to report from a billed run");
      }
      return parsed;
    }
  });
  const usage = parseClaudeUsage(output.result || "");
  if (usage.windows.length === 0) {
    throw new Error(`claude /usage reported no usage windows: ${String(output.result || "").slice(0, 300)}`);
  }
  return {
    source: "claude -p /usage",
    ...usage,
    timezone: "UTC",
    costNote: "A Claude subscription reports no per-model price; usage counts against the windows above."
  };
}

// --- Copilot: one model-less probe run, then the CLI's own plan cache and catalog ---

function copilotCacheCandidates({ environment = process.env, home = homedir(), platform = process.platform } = {}) {
  const candidates = [];
  if (environment.XDG_CACHE_HOME) candidates.push(path.join(environment.XDG_CACHE_HOME, "copilot"));
  if (platform === "darwin") candidates.push(path.join(home, "Library", "Caches", "copilot"));
  if (platform === "win32" && environment.LOCALAPPDATA) candidates.push(path.join(environment.LOCALAPPDATA, "copilot"));
  candidates.push(path.join(home, ".cache", "copilot"));
  return candidates.map((directory) => path.join(directory, "copilot-user-cache.json"));
}

function readJsonWithComments(file) {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("//")).join("\n"));
}

function latestCopilotUserEntry(candidates, login = null) {
  let latest = null;
  for (const file of candidates) {
    let cache;
    try { cache = readJsonWithComments(file); } catch { continue; }
    for (const entry of Object.values(cache.copilotUserCache || {})) {
      if (!isObject(entry?.response)) continue;
      // The cache keeps one entry per token, so another account's entry can be newer.
      if (login && entry.response.login !== login) continue;
      if (!latest || String(entry.retrievedAt) > String(latest.retrievedAt)) latest = entry;
    }
  }
  return latest;
}

function copilotHome({ environment = process.env, home = homedir() } = {}) {
  return environment.COPILOT_HOME || path.join(home, ".copilot");
}

// The account the CLI is signed in as; both quota sources are checked against it.
function activeCopilotLogin(configHome = copilotHome()) {
  try {
    const login = readJsonWithComments(path.join(configHome, "config.json")).lastLoggedInUser?.login;
    return typeof login === "string" && login ? login : null;
  } catch {
    return null;
  }
}

// A probe run records a session under COPILOT_HOME even though it fails on the
// model; remove exactly the sessions whose recorded cwd is this probe's directory.
function removeProbeSessions(configHome, workDirectory, startedAt) {
  const stateRoot = path.join(configHome, "session-state");
  let entries;
  try { entries = fs.readdirSync(stateRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const sessionDirectory = path.join(stateRoot, entry.name);
    try {
      if (fs.statSync(sessionDirectory).mtimeMs < startedAt - 1_000) continue;
      const workspace = fs.readFileSync(path.join(sessionDirectory, "workspace.yaml"), "utf8");
      if (!workspace.split(/\r?\n/).some((line) => line.trim() === `cwd: ${workDirectory}`)) continue;
      fs.rmSync(sessionDirectory, { force: true, recursive: true });
      fs.rmSync(path.join(stateRoot, ".session-operation-locks", `${entry.name}.lock`), { force: true });
    } catch {
      // Cleanup is best-effort; a session we cannot attribute is left alone.
    }
  }
}

function catalogFromLogs(logDirectory) {
  for (const name of fs.readdirSync(logDirectory)) {
    const text = fs.readFileSync(path.join(logDirectory, name), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const marker = line.indexOf("fetched model catalog from CAPI");
      if (marker === -1) continue;
      const payload = JSON.parse(line.slice(line.indexOf("{", marker)));
      return JSON.parse(payload.models);
    }
  }
  return null;
}

function summarizeCopilotQuota(response) {
  const snapshot = response.quota_snapshots?.premium_interactions || {};
  const entitlement = snapshot.entitlement ?? null;
  const remaining = snapshot.remaining ?? null;
  return {
    plan: response.copilot_plan ?? null,
    sku: response.access_type_sku ?? null,
    monthly: {
      unit: snapshot.token_based_billing === false ? "premium requests" : "AI credits",
      entitlement,
      remaining,
      used: entitlement !== null && remaining !== null ? Math.round((entitlement - remaining) * 10) / 10 : null,
      usedPercent: Number.isFinite(snapshot.percent_remaining) ? Math.round((100 - snapshot.percent_remaining) * 10) / 10 : null,
      unlimited: snapshot.unlimited === true,
      overagePermitted: snapshot.overage_permitted === true,
      overageEntitlement: snapshot.overage_entitlement ?? null,
      overageUsed: snapshot.overage_count ?? null,
      resetsOn: response.quota_reset_date ?? null
    }
  };
}

function summarizeCopilotModels(catalog, planKey) {
  return catalog.filter((model) => model.model_picker_enabled).map((model) => {
    const billing = model.billing || {};
    const restrictedTo = billing.restricted_to || null;
    const prices = billing.token_prices || {};
    const tier = (entry) => entry && {
      input: entry.input_price ?? null,
      cachedInput: entry.cache_read_price ?? null,
      cacheWrite: entry.cache_write_price ?? null,
      output: entry.output_price ?? null,
      maxPromptTokens: entry.max_prompt_tokens ?? null
    };
    return {
      id: model.id,
      name: model.name,
      availableOnPlan: planKey ? (!restrictedTo || restrictedTo.includes(planKey)) : null,
      efforts: model.capabilities?.supports?.reasoning_effort || [],
      pricePerMillionTokens: tier(prices.default),
      longContextPricePerMillionTokens: tier(prices.long_context) || null,
      autoDiscount: billing.auto_discount ?? null
    };
  });
}

async function freshCopilotUser({ timeoutMs, abortSignal, login }) {
  let binary;
  try {
    binary = resolveCli("gh");
  } catch {
    return null;
  }
  try {
    const response = await superviseChild({
      abortSignal, activeChildren, args: ["api", "/copilot_internal/user"], binary, cwd: os.tmpdir(),
      env: buildCalleeEnv(process.env), label: "gh", notFoundHint: "", timeoutMs,
      onClose: ({ code, stdout }) => (code === 0 ? JSON.parse(stdout) : null)
    });
    if (!isObject(response?.quota_snapshots)) return null;
    // gh may be signed in as a different account than the Copilot CLI.
    if (login && response.login !== login) return null;
    return { response, retrievedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

async function copilotModelCatalog({ timeoutMs, abortSignal, configHome }) {
  const binary = resolveCli("copilot", { fallbacks: copilotBridge.cliFallbacks() });
  const workDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-delegator-usage-")));
  const logDirectory = path.join(workDirectory, "logs");
  const startedAt = Date.now();
  try {
    const args = ["--model", COPILOT_PROBE_MODEL, "--log-level", "all", "--log-dir", logDirectory,
      "--deny-tool=shell", "--deny-tool=write", "--deny-tool=edit", "-p", "usage probe"];
    await superviseChild({
      abortSignal, activeChildren, args, binary, cwd: workDirectory, env: buildCalleeEnv(process.env),
      label: "Copilot", notFoundHint: "Install the Copilot CLI and run `copilot` once to sign in.", timeoutMs,
      onClose: ({ code, stdout, stderr }) => {
        // The probe must fail on the model id; an exit 0 would mean a model ran.
        if (code === 0) throw new Error("Copilot accepted the probe model id and ran it; refusing to report usage from a billed run");
        if (!/not available/i.test(`${stdout}\n${stderr}`)) {
          throw new Error(`Copilot probe failed before reaching the model catalog (exit ${code}): ${`${stderr}${stdout}`.trim().slice(-500)}`);
        }
        return null;
      }
    });
    return catalogFromLogs(logDirectory);
  } finally {
    removeProbeSessions(configHome, workDirectory, startedAt);
    fs.rmSync(workDirectory, { force: true, recursive: true });
  }
}

async function copilotUsage({ includeModels, timeoutMs, abortSignal }) {
  const configHome = copilotHome();
  const login = activeCopilotLogin(configHome);
  // The CLI refreshes its plan cache on its own schedule (measured 16 credits
  // behind after eight minutes), so a signed-in gh is asked first for the same
  // endpoint the CLI uses. The cache is only a fallback and is marked stale.
  let entry = await freshCopilotUser({ timeoutMs, abortSignal, login });
  let source = "gh api /copilot_internal/user";
  if (!entry) {
    entry = latestCopilotUserEntry(copilotCacheCandidates(), login);
    source = "copilot plan cache";
  }
  if (!entry) throw new Error("Copilot quota unavailable: gh could not answer for the signed-in account and no plan cache was found");
  const quota = summarizeCopilotQuota(entry.response);
  const usage = { source, account: entry.response.login ?? null, identityVerified: Boolean(login), retrievedAt: entry.retrievedAt, ...quota };
  if (source === "copilot plan cache") {
    const ageSeconds = Math.round((Date.now() - Date.parse(entry.retrievedAt)) / 1000);
    usage.stale = true;
    usage.routable = false;
    usage.staleNote = `The CLI's plan cache is ${Number.isFinite(ageSeconds) ? `${ageSeconds}s` : "of unknown age"} old and lags the live balance; do not route on it.`;
  }
  usage.windows = "Copilot has no 5-hour or weekly window; usage is a monthly allowance.";
  if (includeModels) {
    const catalog = await copilotModelCatalog({ timeoutMs, abortSignal, configHome });
    usage.priceUnit = "AI credits per 1M tokens";
    usage.models = catalog ? summarizeCopilotModels(catalog, COPILOT_PLAN_KEYS[quota.plan]) : null;
    if (!catalog) usage.modelsNote = "Copilot did not log its model catalog on this run";
  }
  return usage;
}

// --- Agy: `agy -p /usage`, answered by the CLI itself with zero turns ---

async function agyUsage({ timeoutMs, abortSignal }) {
  const binary = resolveCli("agy", { fallbacks: agyBridge.cliFallbacks() });
  const output = await superviseChild({
    abortSignal, activeChildren, args: ["-p", "/usage", "--output-format", "json"], binary, cwd: os.tmpdir(),
    env: buildCalleeEnv(process.env), label: "Agy", notFoundHint: "Install the Antigravity CLI and run `agy` once to sign in.",
    timeoutMs,
    onClose: ({ code, stdout, stderr }) => {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch {
        throw new Error(`agy /usage returned no JSON (exit ${code})${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`);
      }
      // A slash command that reached the model would report turns or tokens.
      if (parsed.num_turns !== 0 || parsed.usage?.total_tokens) throw new Error("agy answered /usage with a model turn; refusing to report from a billed run");
      if (!isObject(parsed.command?.data)) throw new Error(`agy /usage returned no usage data: ${String(parsed.response || "").slice(0, 300)}`);
      return parsed.command.data;
    }
  });
  return {
    source: "agy -p /usage",
    groups: (output.groups || []).map((group) => ({
      name: group.name,
      models: group.description ?? null,
      windows: (group.buckets || []).map((bucket) => ({
        label: bucket.window || bucket.name,
        usedPercent: Number.isFinite(bucket.remaining_fraction) ? Math.round((1 - bucket.remaining_fraction) * 1000) / 10 : null,
        resetsAt: bucket.reset_time ?? null
      }))
    })),
    costNote: output.description ?? null
  };
}

// --- Kimi: the Moonshot account balance, for providers kimi itself would call ---

const MOONSHOT_HOSTS = new Set(["api.moonshot.ai", "api.moonshot.cn"]);
// A header value must be printable ASCII; anything else would make fetch throw
// an error message that quotes the key.
const SAFE_CREDENTIAL = /^[\x21-\x7e]{1,4096}$/;

// kimi resolves its own home (KIMI_CODE_HOME), parses its own TOML and reports
// the effective providers, so the server never reads config.toml itself.
function runKimiProviderList({ timeoutMs, abortSignal }) {
  const binary = resolveCli("kimi", { fallbacks: kimiBridge.cliFallbacks() });
  return superviseChild({
    abortSignal, activeChildren, args: ["provider", "list", "--json"], binary, cwd: os.tmpdir(),
    env: buildCalleeEnv(process.env), label: "Kimi", notFoundHint: "Install Kimi Code and configure a Moonshot provider.",
    timeoutMs,
    // stdout carries API keys: it is parsed here and never quoted in an error.
    onClose: ({ code, stdout }) => {
      if (code !== 0) throw new Error(`kimi provider list failed (exit ${code})`);
      try { return JSON.parse(stdout); } catch { throw new Error("kimi provider list returned no JSON"); }
    }
  });
}

function moonshotAccounts(config, environment) {
  const accounts = [];
  for (const [id, provider] of Object.entries(config?.providers || {})) {
    if (!isObject(provider) || provider.type !== "kimi") continue;
    let url;
    try { url = new URL(provider.baseUrl ?? provider.base_url); } catch { continue; }
    // The key goes only to the Moonshot host kimi would send it to anyway.
    if (url.protocol !== "https:" || !MOONSHOT_HOSTS.has(url.hostname)) continue;
    const keyEnv = provider.apiKeyEnv ?? provider.api_key_env;
    let key = provider.apiKey ?? provider.api_key;
    if (!key && keyEnv) key = environment[keyEnv];
    if (!key && !keyEnv) key = environment.KIMI_API_KEY || environment.MOONSHOT_API_KEY;
    accounts.push({ id, origin: url.origin, key: typeof key === "string" ? key : null });
  }
  return accounts;
}

async function moonshotBalance(account, { signal, fetchImpl }) {
  if (!account.key) return { provider: account.id, error: "no API key resolved for this provider" };
  if (!SAFE_CREDENTIAL.test(account.key)) return { provider: account.id, error: "API key contains characters a header cannot carry" };
  let response;
  try {
    response = await fetchImpl(`${account.origin}/v1/users/me/balance`, { headers: { Authorization: `Bearer ${account.key}` }, signal });
  } catch (error) {
    // Transport errors can quote request headers; report only the error class.
    return { provider: account.id, error: `balance request failed (${error?.name || "Error"})` };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.status) return { provider: account.id, error: `balance request failed with HTTP ${response.status}` };
  return {
    provider: account.id,
    currency: account.origin.endsWith(".cn") ? "CNY" : "USD",
    available: body.data?.available_balance ?? null,
    cash: body.data?.cash_balance ?? null,
    voucher: body.data?.voucher_balance ?? null
  };
}

async function kimiUsage({ timeoutMs, abortSignal, environment = process.env, fetchImpl = fetch, listProviders = runKimiProviderList }) {
  const accounts = moonshotAccounts(await listProviders({ timeoutMs, abortSignal }), environment);
  if (accounts.length === 0) throw new Error("kimi has no provider of type kimi on a Moonshot host");
  const balances = [];
  for (const account of accounts) balances.push(await moonshotBalance(account, { signal: abortSignal, fetchImpl }));
  if (balances.every((balance) => balance.error)) throw new Error(balances.map((balance) => `${balance.provider}: ${balance.error}`).join("; "));
  return {
    source: "kimi provider list --json + Moonshot /v1/users/me/balance",
    windows: "Kimi is pay-as-you-go on an API key; there is no short or weekly window, only a balance.",
    balances,
    costNote: "Moonshot's API reports no per-model price; providers behind other hosts (Ollama, Anthropic) are not queried."
  };
}

// --- Grok: the ACP agent's `_x.ai/billing` extension, asked before any session exists ---

function summarizeGrokBilling(billing) {
  const config = billing?.config || {};
  const amount = (field) => (isObject(field) && Number.isFinite(field.val) ? field.val : null);
  return {
    plan: billing?.subscription_tier ?? null,
    period: config.currentPeriod ? {
      type: String(config.currentPeriod.type || "").replace(/^USAGE_PERIOD_TYPE_/, "").toLowerCase() || null,
      start: config.currentPeriod.start ?? null,
      end: config.currentPeriod.end ?? null
    } : null,
    // Present only once credits are drawn; absent means the server reported none.
    usedPercent: Number.isFinite(config.creditUsagePercent) ? config.creditUsagePercent : null,
    monthlyLimit: amount(config.monthlyLimit),
    onDemand: { cap: amount(config.onDemandCap), used: amount(config.onDemandUsed) },
    prepaidBalance: amount(config.prepaidBalance)
  };
}

function summarizeGrokModels(initialize) {
  return (initialize?._meta?.modelState?.availableModels || []).map((model) => ({
    id: model.modelId,
    name: model.name ?? null,
    description: model.description ?? null,
    efforts: (model._meta?.reasoningEfforts || []).map((effort) => effort.value ?? effort.id),
    contextTokens: model._meta?.totalContextTokens ?? null
  }));
}

async function grokUsage({ includeModels, timeoutMs, abortSignal }) {
  const binary = resolveCli("grok", { fallbacks: grokBridge.cliFallbacks() });
  // initialize and the billing extension only; no session is created, so no prompt can run.
  const { initialize, billing } = await jsonRpcSession({
    binary, args: ["agent", "stdio"], label: "grok agent stdio", timeoutMs, abortSignal, jsonrpc: true,
    run: async (request) => {
      const initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      return { initialize, billing: await request("_x.ai/billing", {}) };
    }
  });
  const usage = { source: "grok agent stdio: _x.ai/billing", ...summarizeGrokBilling(billing) };
  if (includeModels) {
    usage.models = summarizeGrokModels(initialize);
    usage.costNote = "Grok reports relative price only in model descriptions (for example \"2x the price\").";
  }
  return usage;
}

// --- Cursor: `cursor-agent about` names the plan; usage meters are interactive-only ---

// `about --format json` carries the e-mail address too; only these three fields leave.
function parseCursorAbout(stdout) {
  const about = JSON.parse(stdout);
  return { plan: about.subscriptionTier ?? null, model: about.model ?? null, cliVersion: about.cliVersion ?? null };
}

async function cursorUsage({ timeoutMs, abortSignal }) {
  const binary = resolveCli("cursor-agent", { aliases: ["agent"], fallbacks: cursorBridge.cliFallbacks() });
  const about = await superviseChild({
    abortSignal, activeChildren, args: ["about", "--format", "json"], binary, cwd: os.tmpdir(), env: buildCalleeEnv(process.env),
    label: "Cursor", notFoundHint: "Install the Cursor Agent CLI and run `cursor-agent login`; on macOS also unlock the login keychain.",
    timeoutMs,
    onClose: ({ code, stdout, stderr }) => {
      if (code !== 0) throw new Error(`cursor-agent about failed (exit ${code}): ${stderr.trim().slice(-500)}`);
      try { return parseCursorAbout(stdout); } catch { throw new Error("cursor-agent about returned no JSON"); }
    }
  });
  return {
    source: "cursor-agent about",
    ...about,
    windows: "cursor-agent shows usage meters only interactively; `/usage` in print mode is sent to the model instead."
  };
}

const COLLECTORS = {
  codex: codexUsage, claude: claudeUsage, copilot: copilotUsage,
  agy: agyUsage, kimi: kimiUsage, grok: grokUsage, cursor: cursorUsage
};

function validateUsageArgs(args) {
  if (!isObject(args)) return "Invalid params: 'arguments' must be an object";
  for (const key of Object.keys(args)) {
    if (!["provider", "includeModels", "timeout"].includes(key)) return `Invalid params: unknown argument '${key}'`;
  }
  if (args.provider !== undefined && ![...PROVIDERS, "all"].includes(args.provider)) {
    return `Invalid params: 'provider' must be one of: ${[...PROVIDERS, "all"].join(", ")}`;
  }
  if (args.includeModels !== undefined && typeof args.includeModels !== "boolean") {
    return "Invalid params: 'includeModels' must be a boolean";
  }
  if (args.timeout !== undefined && !Number.isInteger(args.timeout)) return "Invalid params: 'timeout' must be an integer";
  return null;
}

// Each provider gets one deadline for all of its steps; the request's own
// cancellation reaches every provider through the same signal.
async function runCollector(provider, options, requestSignal) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
  const abortSignal = AbortSignal.any([deadline.signal, requestSignal]);
  try {
    return await COLLECTORS[provider]({ ...options, abortSignal });
  } catch (error) {
    if (deadline.signal.aborted) return { error: `timed out after ${options.timeoutMs / 1000}s` };
    return { error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function collectUsage(args, abortSignal) {
  const selected = !args.provider || args.provider === "all" ? PROVIDERS : [args.provider];
  const options = {
    includeModels: args.includeModels !== false,
    timeoutMs: clampTimeout(args.timeout ?? DEFAULT_USAGE_TIMEOUT_MS)
  };
  const entries = await Promise.all(selected.map(async (provider) => [provider, await runCollector(provider, options, abortSignal)]));
  return { checkedAt: new Date().toISOString(), providers: Object.fromEntries(entries) };
}

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-usage", version: PACKAGE_VERSION }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, { tools: USAGE_TOOLS });
  },

  "tools/call": async (id, params, shouldRespond) => {
    if (!isObject(params) || params.name !== "usage") {
      if (shouldRespond) sendError(id, -32602, `Unknown tool: ${params?.name}`);
      return;
    }
    const args = params.arguments ?? {};
    const problem = validateUsageArgs(args);
    if (problem) {
      if (shouldRespond) sendError(id, -32602, problem);
      return;
    }
    const controller = new AbortController();
    if (shouldRespond) activeRequests.set(id, controller);
    try {
      const report = await collectUsage(args, controller.signal);
      if (shouldRespond) sendResponse(id, { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] });
    } finally {
      activeRequests.delete(id);
    }
  },

  "notifications/cancelled": (_id, params) => {
    activeRequests.get(params?.requestId)?.abort();
  },

  "notifications/initialized": () => {}
};

if (require.main === module) {
  runStdioLoop({ handlers, activeRequests, activeChildren });
}

module.exports = {
  copilotCacheCandidates,
  grokUsage,
  summarizeGrokBilling,
  summarizeGrokModels,
  moonshotAccounts,
  kimiUsage,
  parseCursorAbout,
  handlers,
  latestCopilotUserEntry,
  parseClaudeUsage,
  summarizeCodexLimits,
  summarizeCodexModels,
  summarizeCopilotModels,
  summarizeCopilotQuota,
  toolDefinitions: USAGE_TOOLS
};
