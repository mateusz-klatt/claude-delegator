"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const EXPECTED_PACKAGE_FILES = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "claude-delegator.png",
  "commands/setup.md",
  "commands/uninstall.md",
  "config/codex-mcp.example.toml",
  "config/mcp-servers.example.json",
  "config/model-catalog.json",
  "config/providers.json",
  "package.json",
  "prompts/agent-mail-coordination.md",
  "prompts/architect.md",
  "prompts/code-reviewer.md",
  "prompts/plan-reviewer.md",
  "prompts/scope-analyst.md",
  "prompts/security-analyst.md",
  "rules/delegation-format.md",
  "rules/model-selection.md",
  "rules/orchestration.md",
  "rules/triggers.md",
  "server/agy/index.js",
  "server/claude/index.js",
  "server/codex/launcher.js",
  "server/copilot/index.js",
  "server/cursor/index.js",
  "server/grok/index.js",
  "server/kimi/index.js",
  "server/shared/bridge.js",
  "server/shared/coordination.js",
  "server/shared/environment.js",
  "server/shared/provider-runtime.js",
  "server/shared/result.js",
  "test/mcp-probe.mjs"
];

function dryRunPackageFiles() {
  const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmCli ? [npmCli, ...packArgs] : packArgs;
  const output = execFileSync(
    command,
    args,
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      shell: !npmCli && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const report = JSON.parse(output);
  assert.equal(report.length, 1, "npm pack must describe exactly one package");
  assert.equal(report[0].entryCount, report[0].files.length);
  return report[0].files.map(({ path: file }) => file).sort();
}

test("npm package contains exactly the consumer runtime and documentation contract", () => {
  const packed = dryRunPackageFiles();
  assert.deepEqual(packed, [...EXPECTED_PACKAGE_FILES].sort());

  // Every relative CommonJS edge from shipped runtime must stay inside the
  // tarball. This catches an allowlist that includes an entrypoint but forgets
  // one of its shared modules, JSON catalogs, or package metadata.
  const packedSet = new Set(packed);
  for (const file of packed.filter((candidate) => candidate.startsWith("server/") && candidate.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    for (const [, request] of source.matchAll(/require\(["'](\.{1,2}\/[^"']+)["']\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), request));
      const candidates = [target, `${target}.js`, `${target}.json`, `${target}/index.js`];
      assert.ok(
        candidates.some((candidate) => packedSet.has(candidate)),
        `${file} requires ${request}, but none of ${candidates.join(", ")} is packaged`
      );
    }
  }

  // Name the high-risk local and repository-only surfaces explicitly. The exact
  // comparison above is the hermetic boundary; these messages make a regression
  // actionable if someone later widens the allowlist.
  for (const forbidden of [
    ".agent-mail-project-id",
    ".c8rc.json",
    ".claude/settings.local.json",
    ".git/",
    ".github/",
    "coverage/",
    "docs/plans/",
    "node_modules/",
    "package-lock.json",
    "sonar-project.properties"
  ]) {
    assert.equal(
      packed.some((file) => forbidden.endsWith("/") ? file.startsWith(forbidden) : file === forbidden),
      false,
      `${forbidden} must never enter the package`
    );
  }
  assert.equal(packed.some((file) => file.endsWith(".test.js")), false);
  assert.deepEqual(
    packed.filter((file) => file.startsWith("test/")),
    ["test/mcp-probe.mjs"],
    "the documented manual probe is the only consumer utility shipped from test/"
  );
});
