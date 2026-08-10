"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../config/model-catalog.json");
const copilotBridge = require("../server/copilot");
const geminiBridge = require("../server/gemini");

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
  assert.equal(catalog.providers.claude.cliVersion, "2.1.226");
  assert.equal(catalog.providers.claude.models.length, 4);
  assert.equal(catalog.providers.claude.aliases.opus, "claude-opus-5");

  assert.equal(catalog.providers.codex.cliVersion, "0.147.0-alpha.6.5");
  assert.equal(catalog.providers.codex.models.length, 7);
  assert.deepEqual(
    catalog.providers.codex.models.find((model) => model.id === "gpt-5.6-sol").efforts,
    ["low", "medium", "high", "xhigh", "max", "ultra"]
  );

  assert.equal(catalog.providers.gemini.cliVersion, "0.54.4");
  assert.equal(catalog.providers.gemini.models.length, 11);
  assert.equal(catalog.providers.gemini.freeFormModel, true);

  assert.equal(catalog.providers.copilot.cliVersion, "1.0.78");
  assert.equal(catalog.providers.copilot.models.length, 25);
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

  for (const providerName of ["gemini", "copilot"]) {
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

test("Gemini tool schema advertises registry examples without restricting free-form models", () => {
  const start = geminiBridge.toolDefinitions.find((tool) => tool.name === "gemini");
  const model = start.inputSchema.properties.model;

  assert.equal(model.default, catalog.providers.gemini.defaultModel);
  assert.equal(model.enum, undefined);
  assert.ok(model.examples.includes("gemma-4-31b-it"));
  assert.ok(model.examples.includes("pro"));
  assert.ok(model.examples.includes("auto-gemini-3"));
  assert.deepEqual(geminiBridge.sandboxArguments(), ["--approval-mode", "yolo"]);
  assert.deepEqual(geminiBridge.sandboxArguments("read-only"), ["--approval-mode", "plan"]);
  assert.deepEqual(geminiBridge.sandboxArguments("workspace-write"), ["--approval-mode", "yolo"]);
});

test("all bridge tools expose the strict optional coordination object", () => {
  for (const tool of [...copilotBridge.toolDefinitions, ...geminiBridge.toolDefinitions]) {
    const coordination = tool.inputSchema.properties.coordination;
    assert.equal(coordination.additionalProperties, false);
    assert.deepEqual(
      coordination.required,
      ["projectKey", "callerAgentName"]
    );
  }
});

test("tools/list handlers return the exported catalog-backed schemas", async () => {
  for (const bridge of [copilotBridge, geminiBridge]) {
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
    [geminiBridge, "gemini"]
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
