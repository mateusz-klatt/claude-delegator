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

test("resolves a real npm shim captured from a Windows host", () => {
  // Not a shim shape this suite invented. test/fixtures/copilot.cmd is the
  // verbatim C:\Users\...\AppData\Roaming\npm\copilot.cmd from claude-win-home-1,
  // and every hand-written case above turned out to guess a different variant:
  // npm emits `CALL :find_dp0` with an unquoted `SET dp0=%~dp0`, not the
  // `@SET "dp0=%~dp0"` this suite assumed. The loader is also named
  // npm-loader.js rather than copilot.js, so a matcher that looks for the command
  // name in the *filename* instead of anywhere in the path fails here.
  const shim = require("node:fs").readFileSync(
    path.join(__dirname, "..", "..", "test", "fixtures", "copilot.cmd"),
    "utf8"
  );
  const resolved = core.resolveWindowsShim(
    "C:\\Users\\mateu\\AppData\\Roaming\\npm\\copilot.cmd",
    "copilot",
    () => shim
  );

  // Confirmed present on that host.
  assert.equal(resolved, "C:\\Users\\mateu\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\npm-loader.js");
  // %~dp0 already ends in a separator and the shim concatenates another, so the
  // naive expansion yields npm\\node_modules. Windows tolerates it; string
  // comparison does not.
  assert.equal(resolved.includes("\\\\"), false);
  assert.equal(/%~?dp0%?/.test(resolved), false);

  // And it is spawned under node rather than executed directly.
  assert.equal(core.spawnTarget(resolved, ["--version"]).command, process.execPath);
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

test("runs a .ps1 through the vendor's own PowerShell invocation, never a shell", () => {
  const script = "C:\\Users\\dev\\.local\\bin\\cursor-agent.ps1";
  const previous = process.env.SystemRoot;
  process.env.SystemRoot = "D:\\Windows";
  try {
    const invocation = core.spawnTarget(script, ["--version"]);

    // Absolute, from %SystemRoot%, exactly as cursor-agent's .cmd does it — not
    // "powershell" off a PATH an MCP server may not have.
    assert.equal(
      invocation.command,
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    // The four flags are quoted from the vendor shim. -File must come last of
    // the four, immediately before the script, or PowerShell reads the script
    // path as an argument to the preceding switch.
    assert.deepEqual(
      invocation.args,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--version"]
    );
  } finally {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  }

  // No SystemRoot at all (a POSIX test host, or a stripped environment) must
  // still produce a usable absolute path rather than an empty leading segment.
  const saved = { root: process.env.SystemRoot, upper: process.env.SYSTEMROOT };
  delete process.env.SystemRoot;
  delete process.env.SYSTEMROOT;
  try {
    assert.equal(
      core.spawnTarget(script, []).command,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
  } finally {
    if (saved.root !== undefined) process.env.SystemRoot = saved.root;
    if (saved.upper !== undefined) process.env.SYSTEMROOT = saved.upper;
  }
});

test("expands whichever variable a shim assigns from %~dp0, not a fixed list", () => {
  // cursor-agent's .cmd names its directory SCRIPT_DIR, not dp0. Hard-coding the
  // popular spellings would have meant a new name every time a vendor picks one;
  // dp0 was never special, it was only the first one we happened to meet.
  const shim = [
    "@echo off",
    "SETLOCAL",
    "SET SCRIPT_DIR=%~dp0",
    "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe " +
      '-NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*'
  ].join("\r\n");

  assert.equal(
    core.resolveWindowsShim(`${DIR}\\cursor-agent.cmd`, "cursor-agent", () => shim),
    `${DIR}\\cursor-agent.ps1`
  );

  // The quoted form npm uses for the same idea, under a different name again.
  const quoted = [
    "@echo off",
    '@SET "basedir=%~dp0"',
    '"%basedir%\\node.exe" "%basedir%\\cursor-agent.js" %*'
  ].join("\r\n");
  assert.equal(
    core.resolveWindowsShim(`${DIR}\\cursor-agent.cmd`, "cursor-agent", () => quoted),
    `${DIR}\\cursor-agent.js`
  );

  // An unassigned variable is left alone rather than silently dropped: the
  // result must not look like a valid relative path, because a wrong path that
  // parses is the failure mode this whole resolver exists to avoid.
  const unknown = `@echo off\r\n"%MYSTERY_DIR%\\cursor-agent.ps1" %*`;
  const resolved = core.resolveWindowsShim(`${DIR}\\cursor-agent.cmd`, "cursor-agent", () => unknown);
  assert.ok(resolved.includes("%MYSTERY_DIR%"), `${resolved} should still carry the variable`);
});

test("a hard-coded fallback never outranks a real PATH hit", () => {
  // claude-win-home-1's scenario, reproduced exactly and confirmed there by a
  // positive control: kimi.cmd is first on PATH, and the fallback guess
  // %USERPROFILE%\.kimi-code\bin\kimi.exe also exists on that machine. Preferring
  // .exe across the flattened candidate list ran the user's real CLI instead of
  // the stub, which then waited forever — 30s of silence, no child process, no
  // stderr, no exit. Emptying only USERPROFILE flipped it to a 0.2s success.
  const stubDirectory = ["C:\\stub\\kimi.exe", "C:\\stub\\kimi.cmd", "C:\\stub\\kimi"];
  const fallback = ["C:\\Users\\dev\\.kimi-code\\bin\\kimi.exe"];
  const onDisk = new Set(["C:\\stub\\kimi.cmd", ...fallback]);
  const exists = (candidate) => onDisk.has(candidate);

  assert.equal(
    core.selectCandidate([stubDirectory, fallback], exists, true),
    "C:\\stub\\kimi.cmd",
    "PATH must win over a fallback that merely has a better extension"
  );

  // The fallback is still what it is for: PATH turning up nothing at all.
  assert.equal(core.selectCandidate([[], fallback], exists, true), fallback[0]);
  assert.equal(core.selectCandidate([["C:\\stub\\absent.exe"], fallback], exists, true), fallback[0]);
});

test("PATH order decides before extension preference, directory by directory", () => {
  // A user who deliberately puts a wrapper earlier on PATH must get the wrapper.
  // Flattening every directory into one list made .exe win from anywhere,
  // silently ignoring the ordering the user chose.
  const first = ["C:\\wrapper\\cli.exe", "C:\\wrapper\\cli.cmd"];
  const second = ["C:\\vendor\\cli.exe", "C:\\vendor\\cli.cmd"];
  const onDisk = new Set(["C:\\wrapper\\cli.cmd", "C:\\vendor\\cli.exe"]);
  const exists = (candidate) => onDisk.has(candidate);

  assert.equal(core.selectCandidate([first, second], exists, true), "C:\\wrapper\\cli.cmd");
  // Within one directory, the extension preference still applies.
  const both = new Set(["C:\\wrapper\\cli.exe", "C:\\wrapper\\cli.cmd"]);
  assert.equal(core.selectCandidate([first], (c) => both.has(c), true), "C:\\wrapper\\cli.exe");
});

test("an extensionless npm launcher is never selectable on Windows", () => {
  // Measured on a real Windows host, not imagined: npm installs a POSIX `sh`
  // launcher beside its .cmd in the same directory, and `where copilot` lists
  // the extensionless one FIRST. It is 427 bytes of `#!/bin/sh`, so
  // resolveWindowsShim passes it through untouched (it only expands .cmd/.bat)
  // and spawn(shell: false) cannot run it. Ordering alone would pick it — the
  // hard rejection is what stops it, and it is the Windows counterpart of the
  // POSIX X_OK filter the platform branch never had.
  assert.equal(core.WINDOWS_RUNNABLE.test("C:\\Users\\dev\\AppData\\Roaming\\npm\\copilot"), false);
  assert.equal(core.WINDOWS_RUNNABLE.test("C:\\Users\\dev\\AppData\\Roaming\\npm\\copilot.cmd"), true);
  // .ps1 is a third launcher npm drops in the same place and no bridge handles.
  assert.equal(core.WINDOWS_RUNNABLE.test("C:\\Users\\dev\\AppData\\Roaming\\npm\\copilot.ps1"), false);

  // claude-mac-laptop-1 narrowed the exposure by replaying all three layouts
  // through this selector from macOS — possible only because it is exported.
  // Both launchers in ONE directory is safe either way, because the extension
  // preference settles it before order does. The genuine gap is the launcher
  // sitting ALONE in a directory earlier on PATH: nothing to prefer over it, so
  // only the hard rejection keeps it from winning against a real .exe further on.
  const shOnly = ["C:\\npm\\cli.exe", "C:\\npm\\cli.cmd", "C:\\npm\\cli"];
  const vendor = ["C:\\vendor\\cli.exe"];
  const present = new Set(["C:\\npm\\cli", "C:\\vendor\\cli.exe"]);
  assert.equal(
    core.selectCandidate([shOnly, vendor], (c) => present.has(c) && core.WINDOWS_RUNNABLE.test(c), true),
    "C:\\vendor\\cli.exe",
    "an unrunnable launcher must not win on position alone"
  );

  // End to end through the selector, with both launchers present in one
  // directory exactly as they are installed.
  const npmDirectory = ["C:\\npm\\copilot.exe", "C:\\npm\\copilot.cmd", "C:\\npm\\copilot"];
  const onDisk = new Set(["C:\\npm\\copilot.cmd", "C:\\npm\\copilot"]);
  assert.equal(
    core.selectCandidate([npmDirectory], (c) => onDisk.has(c) && core.WINDOWS_RUNNABLE.test(c), true),
    "C:\\npm\\copilot.cmd"
  );
});

test("a lone .cmd earlier on PATH beats a .exe later, and fails loudly if unparseable", () => {
  // The deliberate consequence of ranking provenance above extension: a shim
  // alone in an earlier directory is now looked at instead of being skipped for
  // an .exe elsewhere. If that shim is unparseable the resolver throws by name
  // rather than silently substituting a different binary — the same choice made
  // for the Copilot error path, where a silent failure was worse than a message.
  const earlier = ["C:\\shim\\cli.exe", "C:\\shim\\cli.cmd"];
  const later = ["C:\\vendor\\cli.exe"];
  const onDisk = new Set(["C:\\shim\\cli.cmd", "C:\\vendor\\cli.exe"]);
  assert.equal(core.selectCandidate([earlier, later], (c) => onDisk.has(c), true), "C:\\shim\\cli.cmd");

  assert.throws(
    () => core.resolveWindowsShim("C:\\shim\\cli.cmd", "cli", () => "@echo off\r\nrem opaque\r\n"),
    /could not resolve cli/
  );
});

test("POSIX selection keeps which-order and never applies extension preference", () => {
  const exists = (candidate) => candidate !== "/usr/bin/cli";
  assert.equal(
    core.selectCandidate([["/usr/bin/cli"], ["/usr/local/bin/cli"], ["/opt/cli"]], exists, false),
    "/usr/local/bin/cli"
  );
  assert.equal(core.selectCandidate([[], []], exists, false), undefined);
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

test("names the link target when the resolved CLI is a version symlink", { skip: process.platform === "win32" }, () => {
  // Version-managed CLIs point one stable name at the current version:
  // ~/.local/bin/cursor-agent -> .../versions/<v>/cursor-agent, and grok's own
  // ~/.local/bin/grok -> ~/.grok/bin/grok. Logging only the stable name makes
  // two different versions read identically, which is the "a stale install beats
  // a current one" failure this resolver was reworked to prevent — invisible in
  // the one place someone would look for it.
  const fs = require("node:fs");
  const os = require("node:os");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-realpath-"));
  const versioned = path.join(base, "versions-2026.08.11");
  fs.mkdirSync(versioned);
  const real = path.join(versioned, "demo-cli");
  fs.writeFileSync(real, "#!/bin/sh\necho 1.0.0\n");
  fs.chmodSync(real, 0o755);
  const link = path.join(base, "demo-cli");
  fs.symlinkSync(real, link);

  const lines = [];
  const previous = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    assert.equal(core.resolveCli("demo-cli", { fallbacks: [link] }), link);
  } finally {
    console.error = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }

  const reported = lines.find((line) => line.includes("demo-cli resolved to"));
  assert.ok(reported, `expected a resolution line, got ${JSON.stringify(lines)}`);
  assert.ok(reported.includes(link), "the name that was resolved must still be named");
  assert.ok(reported.includes(real), "the version the link points at must be named too");
});
