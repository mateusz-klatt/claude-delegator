"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const catalog = require("../config/model-catalog.json");
const copilotBridge = require("../server/copilot");
const agyBridge = require("../server/agy");
const kimiBridge = require("../server/kimi");
const claudeBridge = require("../server/claude");
const grokBridge = require("../server/grok");
const cursorBridge = require("../server/cursor");

const customBridges = [
  [claudeBridge, "claude"],
  [agyBridge, "agy"],
  [kimiBridge, "kimi"],
  [grokBridge, "grok"],
  [cursorBridge, "cursor"],
  [copilotBridge, "copilot"]
];

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
  assert.equal(catalog.verifiedAt, "2026-08-17");
  assert.equal(catalog.cliVersionsCheckedAt, "2026-08-18");
  assert.equal(catalog.providers.claude.cliVersion, "2.1.234");
  assert.equal(catalog.providers.claude.models.length, 4);
  assert.equal(catalog.providers.claude.aliases.opus, "claude-opus-5");
  const rules = fs.readFileSync(path.resolve(__dirname, "../rules/model-selection.md"), "utf8");
  assert.ok(
    rules.includes(`Claude Code ${catalog.providers.claude.cliVersion}`),
    "Claude reference must name the catalogued CLI version"
  );

  assert.equal(catalog.providers.codex.cliVersion, "0.147.0");
  assert.equal(catalog.providers.codex.models.length, 7);
  assert.deepEqual(
    catalog.providers.codex.models.find((model) => model.id === "gpt-5.6-sol").efforts,
    ["low", "medium", "high", "xhigh", "max", "ultra"]
  );

  assert.equal(catalog.providers.gemini, undefined, "gemini was replaced by agy");
  assert.equal(catalog.providers.agy.cliVersion, "1.1.14");
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

  // Ollama has no bridge of its own: it is reached through the Kimi bridge as an
  // extra provider, so the catalog records it without an MCP server entry.
  assert.equal(catalog.providers.ollama.hasOwnMcpServer, false);
  const grokBridge = require("../server/grok");
  assert.equal(catalog.providers.grok.cliVersion, "1.0.4");
  assert.deepEqual(catalog.providers.grok.models, ["grok-4.6"]);
  assert.equal(catalog.providers.grok.freeFormModel, false);
  assert.equal(catalog.providers.grok.emitsEffortFlag, true);
  assert.deepEqual(
    grokBridge.toolDefinitions[0].inputSchema.properties.model.enum,
    catalog.providers.grok.models,
    "the grok schema enum must come from the catalog"
  );
  // Grok enforces read-only with its own deny rules (Copilot uses a separate
  // shell/write/edit deny mechanism), and the note must say what actually does
  // the enforcing. Naming --sandbox
  // there would repeat the agy mistake: a flag whose name outruns its behaviour.
  assert.match(catalog.providers.grok.permissionNote, /--deny/);
  assert.match(catalog.providers.grok.permissionNote, /--sandbox read-only is accepted and did not stop a write/);
  // Project instructions are inherited from cwd on every platform measured.
  assert.match(catalog.providers.grok.contextNote, /CLAUDE\.md/);
  assert.match(catalog.providers.grok.contextNote, /no known off switch/);

  assert.equal(catalog.providers.ollama.reachedThrough, "kimi bridge");
  assert.equal(catalog.providers.ollama.cloudSuffix, ":cloud");
  assert.ok(catalog.providers.ollama.localModels.includes("ornith:9b"));
  assert.ok(catalog.providers.ollama.cloudModelsFree.includes("gpt-oss:120b"));
  assert.ok(catalog.providers.ollama.cloudModelsPro.includes("deepseek-v4-pro"));
  // kimi-k3 is metered separately and must not be listed as plan-included.
  assert.deepEqual(catalog.providers.ollama.cloudModelsMetered, ["kimi-k3"]);
  assert.equal(catalog.providers.ollama.cloudModelsPro.includes("kimi-k3"), false);
  assert.equal(catalog.providers.ollama.cloudModelsFree.includes("kimi-k3"), false);

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
  for (const model of Object.keys(catalog.providers.copilot.minEffortByModel)) {
    assert.ok(catalog.providers.copilot.models.includes(model));
  }
});

test("Copilot tool schema is sourced from the catalog and applies effort bounds", () => {
  const start = copilotBridge.toolDefinitions.find((tool) => tool.name === "copilot");
  const reply = copilotBridge.toolDefinitions.find((tool) => tool.name === "copilot-reply");

  assert.deepEqual(start.inputSchema.properties.model.enum, catalog.providers.copilot.models);
  assert.deepEqual(start.inputSchema.properties.effort.enum, catalog.providers.copilot.efforts);
  assert.equal(start.inputSchema.properties.model.default, catalog.providers.copilot.defaultModel);
  assert.equal(start.inputSchema.properties.effort.default, catalog.providers.copilot.defaultEffort);
  assert.equal(reply.inputSchema.properties.effort.default, undefined);
  assert.equal(copilotBridge.resolveEffort("gpt-5.6-sol", "max"), "max");
  assert.equal(copilotBridge.resolveEffort("gpt-5.6-sol", "minimal"), "low");
  assert.equal(copilotBridge.resolveEffort("gpt-5.6-sol", "none"), "low");
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
  for (const [bridge] of customBridges) {
    for (const tool of bridge.toolDefinitions) {
      const coordination = tool.inputSchema.properties.coordination;
      assert.equal(coordination.additionalProperties, false);
      assert.deepEqual(
        coordination.required,
        ["projectKey", "callerAgentName"]
      );
    }
  }
});

test("tools/list handlers return the exported catalog-backed schemas", async () => {
  for (const [bridge] of customBridges) {
    const response = await captureJsonRpcResponse(
      () => bridge.handlers["tools/list"](17, {}, true)
    );
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 17);
    assert.deepEqual(response.result.tools, bridge.toolDefinitions);
  }
});

test("bridge validation rejects token-bearing coordination before invoking a CLI", async () => {
  for (const [bridge, toolName] of customBridges) {
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

test("the Cursor catalog entry records what the account can use, not what the CLI lists", () => {
  const catalog = require("../config/model-catalog.json");
  const cursorBridge = require("../server/cursor");
  const cursor = catalog.providers.cursor;

  assert.equal(cursor.defaultModel, "auto");
  // Free-form, like kimi: the CLI documents bracket-parameterised overrides that
  // no enum can express, so the bridge forwards the string.
  assert.equal(cursor.freeFormModel, true);
  assert.equal(cursorBridge.toolDefinitions[0].inputSchema.properties.model.enum, undefined);
  assert.equal(cursorBridge.toolDefinitions[0].inputSchema.properties.model.default, cursor.defaultModel);
  // The tier is baked into the model id, as on agy, so no effort flag exists.
  assert.equal(cursor.emitsEffortFlag, false);

  // `cursor-agent models` printed 204 ids while only these completed a live call;
  // the entry must record the second number, not the first.
  assert.ok(cursor.models.includes("auto"));
  assert.ok(cursor.models.length < 10, "models must list what ran, not what was listed");
  assert.match(cursor.discoverySource, /204/);
  assert.match(cursor.discoverySource, /Free plans can only use Auto/);

  // read-only deflects rather than denies; saying otherwise is how an advisory
  // delegation quietly rewrites the workspace.
  assert.match(cursor.permissionNote, /DEFLECTS/);
  assert.match(cursor.trustNote, /--trust is MANDATORY/);
  assert.match(cursor.outputNote, /exit code does NOT classify/i);
});
