"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const core = require("./bridge");

const DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const SHIM = `${DIR}\\claude.cmd`;
const refuse = () => { throw new Error("must not read the shim"); };

test("follows every .cmd shim shape npm and the vendors actually emit", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const target = `${DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

  // Older shims interpolate %~dp0 directly; modern npm assigns it to dp0 first
  // and then expands %dp0%. Both are in the wild, and a bridge that handles only
  // one resolves the other to a path that does not exist.
  for (const reference of ["%~dp0", "%dp0%"]) {
    const shim = `@echo off\r\n"${node}" "${reference}\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
    const resolved = core.resolveWindowsShim(SHIM, "claude", () => shim, ["@anthropic-ai"]);
    assert.equal(resolved, target, `${reference} shim`);
    assert.equal(/%~?dp0%?/.test(resolved), false, `${reference} left unexpanded`);
  }

  // Single quotes and the .cjs/.mjs loaders occur too.
  const singleQuoted = `@echo off\r\n'${node}' '%dp0%\\claude-runner.mjs' %*\r\n`;
  assert.equal(
    core.resolveWindowsShim(SHIM, "claude", () => singleQuoted),
    `${DIR}\\claude-runner.mjs`
  );
  const cjs = `@echo off\r\n"${node}" "%dp0%\\claude-runner.cjs" %*\r\n`;
  assert.equal(core.resolveWindowsShim(SHIM, "claude", () => cjs), `${DIR}\\claude-runner.cjs`);
});

test("resolves a shim's own directory with the win32 parser, not the host's", () => {
  // path.dirname on POSIX returns "." for a backslash path, so a relative
  // reference silently resolved against the process cwd instead of the shim's
  // directory. Only a test running on Linux catches this, which is exactly why
  // the defect survived: on Windows both parsers agree.
  const shim = `@echo off\r\n"node" "%dp0%\\..\\lib\\claude.js" %*\r\n`;
  const resolved = core.resolveWindowsShim(SHIM, "claude", () => shim);
  assert.equal(resolved, "C:\\Users\\dev\\AppData\\Roaming\\lib\\claude.js");
  assert.equal(path.win32.isAbsolute(resolved), true);
  assert.equal(resolved.startsWith(process.cwd()), false);
});

test("returns a real executable untouched without reading it", () => {
  assert.equal(core.resolveWindowsShim(`${DIR}\\claude.exe`, "claude", refuse), `${DIR}\\claude.exe`);
  assert.equal(core.resolveWindowsShim("/home/dev/.local/bin/agy", "agy", refuse), "/home/dev/.local/bin/agy");
});

test("fails loudly on a shim it cannot parse rather than guessing", () => {
  // Silence here would produce a spawn of something that is not the CLI, and the
  // resulting error names the wrong cause. Two separate Windows faults shipped
  // behind exactly that kind of swallowed detail.
  assert.throws(
    () => core.resolveWindowsShim(SHIM, "claude", () => "@echo off\r\nrem nothing here\r\n"),
    /could not resolve claude/
  );
  // A shim that names a different package must not match on the alias alone.
  assert.throws(
    () => core.resolveWindowsShim(SHIM, "claude", () => `@echo off\r\n"node" "%dp0%\\other.js" %*\r\n`),
    /could not resolve claude/
  );
});

test("runs .js loaders under node and executables directly", () => {
  for (const extension of ["js", "cjs", "mjs"]) {
    const invocation = core.spawnTarget(`/opt/cli/main.${extension}`, ["--version"]);
    assert.equal(invocation.command, process.execPath, extension);
    assert.deepEqual(invocation.args, [`/opt/cli/main.${extension}`, "--version"], extension);
  }
  const direct = core.spawnTarget("/usr/local/bin/agy", ["--print"]);
  assert.equal(direct.command, "/usr/local/bin/agy");
  assert.deepEqual(direct.args, ["--print"]);
});

test("clamps a timeout into the house bounds and defaults anything unusable", () => {
  assert.equal(core.clampTimeout(60_000), 60_000);
  assert.equal(core.clampTimeout(1), core.MIN_TIMEOUT_MS);
  assert.equal(core.clampTimeout(99_999_999), core.MAX_TIMEOUT_MS);
  for (const unusable of [undefined, null, "600000", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(core.clampTimeout(unusable), core.DEFAULT_TIMEOUT_MS, String(unusable));
  }
});

test("common validation names the offending parameter and accepts a valid call", () => {
  assert.equal(core.validateCommonArgs({ prompt: "hi" }), null);
  assert.equal(core.validateCommonArgs({ sandbox: "workspace-write", cwd: "/tmp", timeout: 10_000 }), null);

  assert.match(core.validateCommonArgs({ sandbox: "danger-full-access" }), /'sandbox'/);
  assert.match(core.validateCommonArgs({ cwd: "   " }), /'cwd'/);
  assert.match(core.validateCommonArgs({ timeout: 9_999 }), /'timeout'/);
  assert.match(core.validateCommonArgs({ timeout: 3_600_001 }), /'timeout'/);
  assert.match(core.validateCommonArgs({ timeout: "900000" }), /'timeout'/);

  // A bridge may narrow the tier set — Kimi refuses read-only outright — and the
  // message must then advertise what that bridge really accepts.
  const narrowed = core.validateCommonArgs({ sandbox: "read-only" }, { sandboxValues: new Set(["workspace-write"]) });
  assert.match(narrowed, /'workspace-write'/);
  assert.equal(/'read-only'/.test(narrowed), false);
});

test("the advertised timeout schema carries the bounds the bridges enforce", () => {
  const schema = core.timeoutSchema();
  assert.equal(schema.default, core.DEFAULT_TIMEOUT_MS);
  assert.equal(schema.minimum, core.MIN_TIMEOUT_MS);
  assert.equal(schema.maximum, core.MAX_TIMEOUT_MS);
  // A fresh object each call: a schema shared between two tool definitions could
  // be mutated through one of them.
  assert.notEqual(core.timeoutSchema(), schema);
});

test("the depth guard survives a hop through an unrelated provider", () => {
  const guard = core.createDepthGuard("CLAUDE_DELEGATOR_TEST_DEPTH");

  assert.equal(guard.current({}), 0);
  assert.equal(guard.exceeded({}), false);

  // Stamping is what closes the indirect loop: Claude → Codex → Claude carries
  // the variable forward, so the second Claude refuses even though the hop in
  // between knows nothing about the guard.
  const child = guard.stamp({}, {});
  assert.equal(child.CLAUDE_DELEGATOR_TEST_DEPTH, "1");
  assert.equal(guard.exceeded(child), true);
  assert.equal(guard.stamp({}, child).CLAUDE_DELEGATOR_TEST_DEPTH, "2");

  // Junk must read as "not delegated" rather than crashing the bridge.
  for (const junk of ["", "   ", "abc", "-3", "0"]) {
    assert.equal(guard.current({ CLAUDE_DELEGATOR_TEST_DEPTH: junk }), 0, JSON.stringify(junk));
  }
});
