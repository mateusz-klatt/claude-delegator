"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../config/model-catalog.json");
const copilotBridge = require("../server/copilot");
const agyBridge = require("../server/agy");
const kimiBridge = require("../server/kimi");

async function captureJsonRpcResponse(action) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk.toString();
    return true;
  };
  try {
    await action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output.trim());
}

test("model catalog records the empirically discovered CLI rosters", () => {
  assert.equal(catalog.verifiedAt, "2026-08-10");
  assert.equal(catalog.cliVersionsCheckedAt, "2026-08-17");
  assert.equal(catalog.providers.claude.cliVersion, "2.1.233");
  assert.equal(catalog.providers.claude.models.length, 4);
  assert.equal(catalog.providers.claude.aliases.opus, "claude-opus-5");

  assert.equal(catalog.providers.codex.cliVersion, "0.147.0");
  assert.equal(catalog.providers.codex.models.length, 7);
  assert.deepEqual(
    catalog.providers.codex.models.find((model) => model.id === "gpt-5.6-sol").efforts,
    ["low", "medium", "high", "xhigh", "max", "ultra"]
  );

  assert.equal(catalog.providers.gemini, undefined, "gemini was replaced by agy");
  assert.equal(catalog.providers.agy.cliVersion, "1.1.13");
  assert.equal(catalog.providers.agy.models.length, 14);
  // A hard allowlist, unlike the free-form roster gemini exposed: agy validates
  // --model itself and an unknown id fails pre-flight before any work happens.
  assert.equal(catalog.providers.agy.freeFormModel, false);
  // Most agy ids bake the reasoning tier into the name, so the bridge emits no --effort.
  assert.equal(catalog.providers.agy.emitsEffortFlag, false);

  assert.equal(catalog.providers.kimi.cliVersion, "0.36.1");
  assert.equal(catalog.providers.kimi.models.length, 4);
  // The roster is user-extensible via `kimi provider catalog`, so --model stays free-form.
  assert.equal(catalog.providers.kimi.freeFormModel, true);
  assert.equal(catalog.providers.kimi.emitsEffortFlag, false);

  assert.equal(catalog.providers.copilot.cliVersion, "1.0.80");
  assert.equal(catalog.providers.copilot.models.length, 27);
  assert.deepEqual(
    catalog.providers.copilot.efforts,
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  );
});

test("catalog defaults, aliases, and effort overrides reference unique advertised models", () => {
  const claude = catalog.providers.claude;
  assert.equal(new Set(claude.models).size, claude.models.length);
  assert.ok(claude.models.includes(claude.defaultModel));
  for (const resolved of Object.values(claude.aliases)) assert.ok(claude.models.includes(resolved));

  const codex = catalog.providers.codex;
  const codexIds = codex.models.map((model) => model.id);
  assert.equal(new Set(codexIds).size, codexIds.length);
  assert.ok(codexIds.includes(codex.defaultModel));
  for (const model of codex.models) assert.equal(new Set(model.efforts).size, model.efforts.length);

  for (const providerName of ["agy", "kimi", "copilot"]) {
    const provider = catalog.providers[providerName];
    assert.equal(new Set(provider.models).size, provider.models.length);
    assert.ok(provider.models.includes(provider.defaultModel));
  }
  for (const model of Object.keys(catalog.providers.copilot.maxEffortByModel)) {
    assert.ok(catalog.providers.copilot.models.includes(model));
  }
});

test("Copilot tool schema is sourced from the catalog and applies effort ceilings", () => {
  const start = copilotBridge.toolDefinitions.find((tool) => tool.name === "copilot");
  const reply = copilotBridge.toolDefinitions.find((tool) => tool.name === "copilot-reply");

  assert.deepEqual(start.inputSchema.properties.model.enum, catalog.providers.copilot.models);
  assert.deepEqual(start.inputSchema.properties.effort.enum, catalog.providers.copilot.efforts);
  assert.equal(start.inputSchema.properties.model.default, catalog.providers.copilot.defaultModel);
  assert.equal(start.inputSchema.properties.effort.default, catalog.providers.copilot.defaultEffort);
  assert.equal(reply.inputSchema.properties.effort.default, undefined);
  assert.equal(copilotBridge.resolveEffort("gpt-5.6-sol", "max"), "max");
  assert.equal(copilotBridge.resolveEffort("claude-opus-5", "max"), "xhigh");
  assert.equal(copilotBridge.resolveEffort("gpt-5.6-terra", undefined), "xhigh");
  assert.equal(copilotBridge.resolveEffort("gpt-5.6-terra", "minimal"), "minimal");
  assert.equal(copilotBridge.resolveEffort("gpt-5-mini", "minimal"), "low");
  assert.equal(copilotBridge.resolveEffort("gpt-5-mini", "none"), "low");
});

test("Agy tool schema is sourced from the catalog and exposes no effort knob", () => {
  const start = agyBridge.toolDefinitions.find((tool) => tool.name === "agy");
  const reply = agyBridge.toolDefinitions.find((tool) => tool.name === "agy-reply");

  assert.deepEqual(start.inputSchema.properties.model.enum, catalog.providers.agy.models);
  assert.equal(start.inputSchema.properties.model.default, catalog.providers.agy.defaultModel);
  assert.equal(start.inputSchema.properties.effort, undefined);
  assert.equal(reply.inputSchema.properties.effort, undefined);

  // Deviation from every sibling bridge: a resumed agy conversation inherits neither
  // its model nor its workspace, so reply requires the model instead of defaulting it.
  assert.deepEqual(reply.inputSchema.required, ["threadId", "prompt", "model"]);
  assert.equal(reply.inputSchema.properties.model.default, undefined);
});

test("all bridge tools expose the strict optional coordination object", () => {
  for (const tool of [...copilotBridge.toolDefinitions, ...agyBridge.toolDefinitions, ...kimiBridge.toolDefinitions]) {
    const coordination = tool.inputSchema.properties.coordination;
    assert.equal(coordination.additionalProperties, false);
    assert.deepEqual(
      coordination.required,
      ["projectKey", "callerAgentName"]
    );
  }
});

test("tools/list handlers return the exported catalog-backed schemas", async () => {
  for (const bridge of [copilotBridge, agyBridge, kimiBridge]) {
    const response = await captureJsonRpcResponse(
      () => bridge.handlers["tools/list"](17, {}, true)
    );
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 17);
    assert.deepEqual(response.result.tools, bridge.toolDefinitions);
  }
});

test("bridge validation rejects token-bearing coordination before invoking a CLI", async () => {
  for (const [bridge, toolName] of [
    [copilotBridge, "copilot"],
    [agyBridge, "agy"],
    [kimiBridge, "kimi"]
  ]) {
    const response = await captureJsonRpcResponse(
      () => bridge.handlers["tools/call"](23, {
        name: toolName,
        arguments: {
          prompt: "Do not execute",
          coordination: {
            projectKey: "project-a",
            callerAgentName: "codex-wsl-home-1",
            mailTopic: "delegation-1",
            callerToken: "must-not-cross-the-boundary"
          }
        }
      }, true)
    );
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /unknown coordination field.*callerToken/);
  }
});
