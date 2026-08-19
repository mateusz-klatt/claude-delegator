---
name: setup
description: Verify the Codex, Agy, Kimi, Copilot, Grok, and Cursor MCP servers and install orchestration rules
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 60000
---

# Setup

Verify Codex, Agy, Kimi, Copilot, Grok, and Cursor as specialized expert subagents via native MCP, then install their orchestration rules. Five domain experts can advise OR implement.

## Step 1: Check CLI Dependencies

### Node.js runtime
```bash
check_node_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    echo "NODE_MISSING: install Node.js 22.12.0 or newer"
    return 1
  fi

  node_version=$(node -p 'process.versions.node')
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
    echo "NODE_TOO_OLD: found $node_version; require 22.12.0 or newer"
    return 1
  fi
  echo "Node.js $node_version: OK"
}
check_node_runtime
```

**STOP setup if Node.js is missing or older than 22.12.0.** Every bridge is a
Node process, so provider CLI checks cannot compensate for an unsupported runtime.

### Codex (GPT)
```bash
if command -v codex >/dev/null 2>&1; then
  codex --version 2>&1 | head -1
elif [ "${OS:-}" = "Windows_NT" ]; then
  is_windows_fully_qualified_root() {
    node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
      "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
  }
  is_runnable_cli_candidate() {
    case "${OS:-}:$1" in
      Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
      *) [ -x "$1" ] ;;
    esac
  }
  local_appdata="${LOCALAPPDATA:-}"
  local_appdata="${local_appdata//\\//}"
  appdata="${APPDATA:-}"
  appdata="${appdata//\\//}"
  if ! is_windows_fully_qualified_root "$local_appdata"; then local_appdata=""; fi
  if ! is_windows_fully_qualified_root "$appdata"; then appdata=""; fi
  codex_fallback=""
  for candidate in "${local_appdata:+$local_appdata/Programs/OpenAI/Codex/bin/codex.exe}" "${appdata:+$appdata/npm/codex.cmd}"; do
    if [ -n "$candidate" ] && is_runnable_cli_candidate "$candidate"; then
      codex_fallback="$candidate"
      break
    fi
  done
  if [ -n "$codex_fallback" ]; then
    "$codex_fallback" --version 2>&1 | head -1
  else
    echo "CODEX_MISSING"
  fi
else
  echo "CODEX_MISSING"
fi
```

### Agy (Antigravity)
```bash
if command -v agy >/dev/null 2>&1; then
  agy --version 2>&1 | head -1
elif [ "${OS:-}" = "Windows_NT" ]; then
  is_windows_fully_qualified_root() {
    node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
      "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
  }
  is_runnable_cli_candidate() {
    case "${OS:-}:$1" in
      Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
      *) [ -x "$1" ] ;;
    esac
  }
  agy_root="${LOCALAPPDATA:-}"
  agy_root="${agy_root//\\//}"
  if is_windows_fully_qualified_root "$agy_root"; then
    agy_fallback="$agy_root/agy/bin/agy.exe"
  else
    agy_fallback=""
  fi
  if [ -n "$agy_fallback" ] && is_runnable_cli_candidate "$agy_fallback"; then
    "$agy_fallback" --version 2>&1 | head -1
  else
    echo "AGY_MISSING"
  fi
elif [ -x "$HOME/.local/bin/agy" ]; then
  "$HOME/.local/bin/agy" --version 2>&1 | head -1
else
  echo "AGY_MISSING"
fi
```

### Kimi
```bash
if command -v kimi >/dev/null 2>&1; then
  kimi --version 2>&1 | head -1
elif [ "${OS:-}" = "Windows_NT" ]; then
  is_windows_fully_qualified_root() {
    node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
      "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
  }
  is_runnable_cli_candidate() {
    case "${OS:-}:$1" in
      Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
      *) [ -x "$1" ] ;;
    esac
  }
  windows_home="${USERPROFILE:-$HOME}"
  windows_home="${windows_home//\\//}"
  kimi_fallback=""
  if ! is_windows_fully_qualified_root "$windows_home"; then
    windows_home=""
  fi
  for candidate in "${windows_home:+$windows_home/.kimi-code/bin/kimi.exe}" "${windows_home:+$windows_home/.kimi-code/bin/kimi.cmd}"; do
    [ -n "$candidate" ] || continue
    if is_runnable_cli_candidate "$candidate"; then
      kimi_fallback="$candidate"
      break
    fi
  done
  if [ -n "$kimi_fallback" ]; then
    "$kimi_fallback" --version 2>&1 | head -1
  else
    echo "KIMI_MISSING"
  fi
elif [ -x "$HOME/.kimi-code/bin/kimi" ]; then
  "$HOME/.kimi-code/bin/kimi" --version 2>&1 | head -1
else
  echo "KIMI_MISSING"
fi
```

### Grok
```bash
if command -v grok >/dev/null 2>&1; then
  grok --version 2>&1 | head -1
elif [ "${OS:-}" = "Windows_NT" ]; then
  is_windows_fully_qualified_root() {
    node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
      "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
  }
  is_runnable_cli_candidate() {
    case "${OS:-}:$1" in
      Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
      *) [ -x "$1" ] ;;
    esac
  }
  windows_home="${USERPROFILE:-$HOME}"
  windows_home="${windows_home//\\//}"
  if ! is_windows_fully_qualified_root "$windows_home"; then
    windows_home=""
  fi
  if [ -n "$windows_home" ] && is_runnable_cli_candidate "$windows_home/.grok/bin/grok.exe"; then
    "$windows_home/.grok/bin/grok.exe" --version 2>&1 | head -1
  else
    echo "GROK_MISSING"
  fi
elif [ -x "$HOME/.grok/bin/grok" ]; then
  "$HOME/.grok/bin/grok" --version 2>&1 | head -1
elif [ -x "$HOME/.local/bin/grok" ]; then
  "$HOME/.local/bin/grok" --version 2>&1 | head -1
else
  echo "GROK_MISSING"
fi
```

### Cursor
```bash
# On macOS this version check also touches the login keychain. A locked keychain
# means the CLI is present but cannot start until the keychain is unlocked.
if command -v cursor-agent >/dev/null 2>&1; then
  cursor-agent --version 2>&1 | head -1
elif [ "${OS:-}" = "Windows_NT" ]; then
  is_windows_fully_qualified_root() {
    node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
      "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
  }
  is_runnable_cli_candidate() {
    case "${OS:-}:$1" in
      Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
      *) [ -x "$1" ] ;;
    esac
  }
  cursor_root="${LOCALAPPDATA:-}"
  cursor_root="${cursor_root//\\//}"
  if is_windows_fully_qualified_root "$cursor_root"; then
    cursor_fallback="$cursor_root/cursor-agent/cursor-agent.cmd"
  else
    cursor_fallback=""
  fi
  if [ -n "$cursor_fallback" ] && is_runnable_cli_candidate "$cursor_fallback"; then
    "$cursor_fallback" --version 2>&1 | head -1
  else
    echo "CURSOR_MISSING"
  fi
elif [ "${OS:-}" != "Windows_NT" ] && [ -x "$HOME/.local/bin/cursor-agent" ]; then
  "$HOME/.local/bin/cursor-agent" --version 2>&1 | head -1
else
  echo "CURSOR_MISSING"
fi
```

### Copilot (GPT)
```bash
if command -v copilot >/dev/null 2>&1; then
  copilot --version 2>&1 | head -1
elif [ "${OS:-}" = "Windows_NT" ]; then
  is_windows_fully_qualified_root() {
    node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
      "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
  }
  is_runnable_cli_candidate() {
    case "${OS:-}:$1" in
      Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
      *) [ -x "$1" ] ;;
    esac
  }
  copilot_root="${APPDATA:-}"
  copilot_root="${copilot_root//\\//}"
  if is_windows_fully_qualified_root "$copilot_root"; then
    copilot_fallback="$copilot_root/npm/copilot.cmd"
  else
    copilot_fallback=""
  fi
  if [ -n "$copilot_fallback" ] && is_runnable_cli_candidate "$copilot_fallback"; then
    "$copilot_fallback" --version 2>&1 | head -1
  else
    echo "COPILOT_MISSING"
  fi
elif [ -x "$HOME/.local/bin/copilot" ]; then
  "$HOME/.local/bin/copilot" --version 2>&1 | head -1
else
  echo "COPILOT_MISSING"
fi
```

### If Missing

**Codex Missing:**
```
Codex CLI not found.
Install (macOS/Linux): curl -fsSL https://chatgpt.com/codex/install.sh | sh
Install (Windows): powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
Fallback (all platforms): npm install -g @openai/codex
Then authenticate: codex login
On Windows, measured fallbacks are %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe and %APPDATA%\npm\codex.cmd.
Those environment roots must be fully-qualified drive (`C:\...`) or UNC
(`\\server\share\...`) paths; root-relative and drive-relative values are ignored.
```

**Agy Missing:**
```
Agy (Google Antigravity) CLI not found.
Install (macOS/Linux): curl -fsSL https://antigravity.google/cli/install.sh | bash
Install (Windows): irm https://antigravity.google/cli/install.ps1 | iex
It lands as a native binary, typically ~/.local/bin/agy on POSIX or
%LOCALAPPDATA%\agy\bin\agy.exe on Windows.
Then authenticate: launch `agy` once and complete the Antigravity OAuth flow.
Note: ~/.local/bin is often absent from the minimal PATH an MCP server inherits.
```

**Kimi Missing:**
```
Kimi Code CLI not found.
Install (macOS/Linux): curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
Install (Windows): irm https://code.kimi.com/kimi-code/install.ps1 | iex
It lands in ~/.kimi-code/bin/kimi on POSIX and ~/.kimi-code/bin/kimi.exe or
kimi.cmd on Windows. Windows also requires Git for Windows.
Then authenticate: set an api_key in ~/.kimi-code/config.toml or export KIMI_API_KEY.
(`kimi login` covers the subscription device-code flow, but subscription signup
was not open for registration as of 2026-08-17.)
Note: ~/.kimi-code/bin is often absent from the minimal PATH an MCP server inherits.
```

**Grok Missing:**
```
Grok CLI not found.
Install (macOS/Linux): curl -fsSL https://x.ai/cli/install.sh | bash
Install (Windows): irm https://x.ai/cli/install.ps1 | iex
It typically lands in ~/.grok/bin/grok or ~/.local/bin/grok on POSIX and
~/.grok/bin/grok.exe on Windows.
Then authenticate: grok login
```

**Cursor Missing:**
```
Cursor Agent CLI not found.
Install (macOS/Linux): curl https://cursor.com/install -fsS | bash
Install (Windows): irm 'https://cursor.com/install?win32=true' | iex
On POSIX it typically lands in ~/.local/bin/cursor-agent (aliased to ~/.local/bin/agent).
Then authenticate: cursor-agent login
On macOS, unlock the login keychain if even `cursor-agent --version` fails.
On Windows, the measured fallback is %LOCALAPPDATA%\cursor-agent\cursor-agent.cmd.
```

**Copilot Missing:**
```
Copilot CLI not found.
Install (macOS/Linux): curl -fsSL https://gh.io/copilot-install | bash
Install (Windows): winget install GitHub.Copilot
Fallback (all platforms): npm install -g @github/copilot (the Windows npm fallback is
%APPDATA%\npm\copilot.cmd)
Then authenticate: copilot login
```

**STOP here if no providers are installed.**

## Step 2: Verify Plugin-Owned MCP Servers

The MCP servers are **declared by the plugin**, in `.claude-plugin/plugin.json`. You
do not register them by hand and there is nothing to run here — installing or
updating the plugin is enough, and they appear as `plugin:claude-delegator:<name>`.

That is deliberate, and it replaces a `claude mcp add` block that used to live in
this file. Those commands passed `${CLAUDE_PLUGIN_ROOT}` to a **shell**, which
expanded it at setup time and wrote a version-stamped cache path into
`~/.claude.json` — for example
`…/plugins/cache/…/claude-delegator/1.6.5/server/agy/index.js`. The registration
then survived exactly until that version directory went away, at which point the
bridges failed with `CONNECTION_CLOSED` and nothing said why. Measured: it took
out agy, kimi and copilot on one machine after a routine cache cleanup. Declared
in the manifest instead, `${CLAUDE_PLUGIN_ROOT}` is resolved by Claude Code on
every launch, so the path cannot go stale.

The declaration also drops the `--env=PATH` pinning the old commands carried.
That was there because an MCP server inherits a minimal PATH, and it is no longer
load-bearing on measured install locations: bridges use absolute
install-location fallbacks (`cliFallbacks()`), covering `~/.local/bin`, Grok's
`~/.grok/bin`, and Kimi's `~/.kimi-code/bin`. On Windows that includes Agy under
`%LOCALAPPDATA%`, Kimi and Grok under the user's home, the packaged Codex and
Cursor launchers under `%LOCALAPPDATA%`, and npm Codex/Copilot shims under
`%APPDATA%`. These are measured stable locations, not guessed package versions.
`test/provider-config.test.js` holds that guarantee.

### Clearing registrations from an older install

If you ran a previous setup, you still have hand-added entries that will now
duplicate the plugin-provided ones. **Update first, remove second** — the order
matters and the other way round is destructive:

```bash
# Keep the fail-closed migration isolated: `exit` below stops this subshell,
# not an interactive parent shell into which the block may be pasted.
(
set -e

# 1. Get a plugin copy that actually declares the servers.
claude plugin marketplace update jarrodwatts-claude-delegator
claude plugin update --scope user claude-delegator@jarrodwatts-claude-delegator

# 1b. Confirm the update actually delivered what step 2 depends on. Ask Claude
#     Code which install is active instead of assuming its default state or cache
#     directories; both can be overridden. Fail closed on ambiguity.
claude_plugin_list=$(claude plugin list --json)
CLAUDE_PLUGIN_LIST_JSON="$claude_plugin_list" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const expected = ["agy", "codex", "copilot", "cursor", "grok", "kimi"];
const records = JSON.parse(process.env.CLAUDE_PLUGIN_LIST_JSON).filter((record) =>
  record.id === "claude-delegator@jarrodwatts-claude-delegator" && record.scope === "user");
if (records.length !== 1 || !records[0]["installPath"]) {
  throw new Error("expected exactly one active user-scope claude-delegator install");
}
const manifest = path.join(records[0]["installPath"], ".claude-plugin", "plugin.json");
const actual = Object.keys(JSON.parse(fs.readFileSync(manifest, "utf8")).mcpServers || {}).sort();
console.log(manifest);
console.log(actual);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`manifest mismatch: expected ${expected}, got ${actual}`);
}
NODE

# 1c. Discover only user-scoped bare registrations created by the pre-1.9 setup:
#     their entrypoint must have the exact historical marketplace-cache lineage.
#     Same-named servers in independent clones are deliberately ignored.
legacy_servers="$(
  CLAUDE_PLUGIN_LIST_JSON="$claude_plugin_list" node - <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const state = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
  : path.join(os.homedir(), ".claude.json");
const legacy = ["codex", "agy", "kimi", "copilot", "grok", "cursor", "gemini"];
const cacheVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const pluginList = JSON.parse(process.env.CLAUDE_PLUGIN_LIST_JSON || "null");
if (!Array.isArray(pluginList)) throw new Error("could not verify the active plugin list");
const records = pluginList.filter((record) =>
  record.id === "claude-delegator@jarrodwatts-claude-delegator" && record.scope === "user");
if (records.length !== 1 || typeof records[0].installPath !== "string") {
  throw new Error("expected exactly one active user-scope claude-delegator install");
}
const invalidUncComponent = /[\u0000-\u001F<>:"|?*]/;
function canonicalAbsolutePath(value, forceWindows = process.platform === "win32") {
  if (typeof value !== "string") return null;
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const windowsDevice = /^[\\/]{2}[?.][\\/]/.test(value);
  const windowsUnc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(value);
  const validUnc = windowsUnc && windowsUnc.slice(1).every((component) =>
    component !== "." && component !== ".." && !component.endsWith(".") &&
    !component.endsWith(" ") && !invalidUncComponent.test(component));
  const windowsShaped = forceWindows || /^[A-Za-z]:/.test(value) ||
    /^[\\]/.test(value) || /^\/\//.test(value);
  const rawParts = value.replaceAll("\\", "/").split("/");
  if (windowsDevice || (windowsShaped && !windowsDrive && !validUnc) ||
      value.trim() !== value || rawParts.some((part) => part === "." || part === "..")) return null;
  const valuePathApi = windowsShaped ? path.win32 : path.posix;
  if (!valuePathApi.isAbsolute(value)) return null;
  return { pathApi: valuePathApi, normalized: valuePathApi.normalize(value) };
}
const canonicalInstall = canonicalAbsolutePath(records[0].installPath);
if (!canonicalInstall) {
  throw new Error("active plugin installPath is not canonical and fully qualified");
}
const { pathApi, normalized: normalizedInstall } = canonicalInstall;
const activeVersion = pathApi.basename(normalizedInstall);
const versionsRoot = pathApi.dirname(normalizedInstall);
const marketplaceRoot = pathApi.dirname(versionsRoot);
if (!cacheVersion.test(activeVersion) || records[0].version !== activeVersion ||
    pathApi.basename(versionsRoot) !== "claude-delegator" ||
    pathApi.basename(marketplaceRoot) !== "jarrodwatts-claude-delegator") {
  throw new Error("active plugin installPath is not a verified marketplace-cache root");
}
const expectedServers = ["agy", "codex", "copilot", "cursor", "grok", "kimi"];
const activeManifest = JSON.parse(fs.readFileSync(
  pathApi.join(normalizedInstall, ".claude-plugin", "plugin.json"), "utf8"
));
const activeServers = Object.keys(activeManifest.mcpServers || {}).sort();
if (activeManifest.name !== "claude-delegator" || activeManifest.version !== activeVersion ||
    JSON.stringify(activeServers) !== JSON.stringify(expectedServers)) {
  throw new Error("active plugin manifest does not verify the delegated MCP servers");
}
let user;
try {
  user = JSON.parse(fs.readFileSync(state, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}
function isHistoricalEntrypoint(value, name) {
  const canonicalValue = canonicalAbsolutePath(value, pathApi === path.win32);
  if (!canonicalValue || canonicalValue.pathApi !== pathApi) return false;
  const relative = pathApi.relative(versionsRoot, canonicalValue.normalized);
  if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relative)) return false;
  const parts = relative.split(pathApi.sep);
  const allowedEntrypoints = name === "codex" ? ["launcher.js", "index.js"] : ["index.js"];
  return parts.length === 4 && cacheVersion.test(parts[0]) && parts[1] === "server" &&
    parts[2] === name && allowedEntrypoints.includes(parts[3]);
}
for (const name of legacy) {
  const entry = user.mcpServers?.[name];
  if (!entry || entry.command !== "node" || !Array.isArray(entry.args)) continue;
  if (isHistoricalEntrypoint(entry.args[0], name)) {
    console.log(name);
  }
}
NODE
)"

# 2. Preflight every recognized pair before the first removal. Health checks
#    run in an empty temporary directory so a project/local server cannot shadow
#    the user-scoped legacy entry. A disconnected old entry cannot provide a
#    fallback and does not block cleanup. A connected one requires its connected
#    replacement; legacy gemini maps to Agy, which replaced it in 1.5.0.
is_connected() {
  printf '%s\n' "$1" | grep -Eq '^[[:space:]]*Status:[[:space:]]+[^[:alnum:][:space:]]+[[:space:]]+Connected[[:space:]]*$'
}
status_dir=$(mktemp -d)
trap 'rmdir "$status_dir" >/dev/null 2>&1 || true' EXIT
preflight_failed=0
for s in $legacy_servers; do
  replacement="$s"
  [ "$s" = "gemini" ] && replacement="agy"

  if ! legacy_config=$(CDPATH= cd -- "$status_dir" && claude mcp get "$s" 2>&1); then
    printf '%s\n' "Could not inspect legacy user-scoped $s; preserving all recognized legacy registrations."
    preflight_failed=1
    continue
  fi
  if ! is_connected "$legacy_config"; then
    printf '%s\n' "Legacy user-scoped $s is not Connected; it cannot serve as a fallback."
    continue
  fi

  server="plugin:claude-delegator:$replacement"
  replacement_config=$(CDPATH= cd -- "$status_dir" && claude mcp get "$server" 2>&1) || replacement_config=""
  if is_connected "$replacement_config"; then
    printf '%s\n' "Verified $s -> $server."
  else
    printf '%s\n' "$server is not Connected; preserving all recognized legacy registrations."
    preflight_failed=1
  fi
done

if [ "$preflight_failed" -ne 0 ]; then
  exit 1
fi

for s in $legacy_servers; do
  claude mcp remove --scope user "$s"
  printf '%s\n' "Removed user-scoped legacy $s registration."
done
)
```

3. Restart the CLI.

Removing first leaves you with **no servers at all** whenever the installed copy
predates this change, because a cache from an earlier version has no `mcpServers`
block to fall back on — and the symptom is `CONNECTION_CLOSED`, the same one two
unrelated defects already produced today. Updating first means you are briefly
carrying duplicates, which is harmless, instead of briefly carrying nothing.
Only recognized user-scope entries below the cache family derived from the
active, verified plugin `installPath`, with `node` and the entrypoint in `args[0]`,
are considered. Local/project entries, independent clones, foreign-prefix
marketplace lookalikes, and unrelated user servers with the same short name are
left untouched for manual inspection. If the active root cannot be verified,
the migration stops before removal.
Each provider is gated independently, so a valid partial CLI installation can
migrate, and all gates complete before the first removal.

`gemini` is in the list because that bridge was replaced by Agy in 1.5.0 and an
old registration may still be sitting there. Its exact claude-delegator
entrypoint provenance is required before it is considered, and a connected
legacy Gemini is removed only after the namespaced Agy bridge is Connected.

The user-scoped plugin makes these dynamically configured servers available
across projects; they are not separate user-scope `claude mcp add` entries.

## Step 3: Install Orchestration Rules

```bash
rules_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/rules/delegator"
mkdir -p "$rules_root" && cp "${CLAUDE_PLUGIN_ROOT}"/rules/*.md "$rules_root/"
```

## Step 4: Verify Installation

Run these checks and report results:

```bash
rules_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/rules/delegator"

# Check 1: CLI versions, including measured install-location fallbacks.
is_shell_absolute_path() {
  case "$1" in
    /* | [A-Za-z]:[\\/]* | //*) return 0 ;;
    *) return 1 ;;
  esac
}

is_windows_fully_qualified_root() {
  node -e 'const core = require(process.argv[1]); process.exit(core.isFullyQualifiedWindowsPath(process.argv[2]) ? 0 : 1)' \
    "${CLAUDE_PLUGIN_ROOT}/server/shared/bridge.js" "$1"
}

is_runnable_cli_candidate() {
  case "${OS:-}:$1" in
    Windows_NT:*.[Cc][Mm][Dd] | Windows_NT:*.[Bb][Aa][Tt]) [ -f "$1" ] ;;
    *) [ -x "$1" ] ;;
  esac
}

CODEX_BIN=""
check_cli_version() {
  label="$1"
  cli="$2"
  shift 2
  binary=""
  resolved_binary=$(command -v "$cli" 2>/dev/null) || resolved_binary=""
  if [ -n "$resolved_binary" ] && is_shell_absolute_path "$resolved_binary" && is_runnable_cli_candidate "$resolved_binary"; then
    binary="$resolved_binary"
  fi
  if [ -z "$binary" ]; then
    for fallback in "$@"; do
      if [ -n "$fallback" ] && is_shell_absolute_path "$fallback" && is_runnable_cli_candidate "$fallback"; then
        binary="$fallback"
        break
      fi
    done
  fi
  if [ -z "$binary" ]; then
    echo "$label CLI: NOT INSTALLED"
    return 1
  fi
  if version=$("$binary" --version 2>&1); then
    echo "$label CLI: $(printf '%s\n' "$version" | head -1)"
    if [ "$label" = "Codex" ]; then
      CODEX_BIN="$binary"
    fi
  else
    echo "$label CLI: FAILED TO START"
    printf '%s\n' "$version" | head -1
    return 1
  fi
}

if [ "${OS:-}" = "Windows_NT" ]; then
  windows_home="${USERPROFILE:-$HOME}"
  windows_home="${windows_home//\\//}"
  local_appdata="${LOCALAPPDATA:-}"
  local_appdata="${local_appdata//\\//}"
  appdata="${APPDATA:-}"
  appdata="${appdata//\\//}"
  if ! is_windows_fully_qualified_root "$windows_home"; then windows_home=""; fi
  if ! is_windows_fully_qualified_root "$local_appdata"; then local_appdata=""; fi
  if ! is_windows_fully_qualified_root "$appdata"; then appdata=""; fi
  check_cli_version "Codex" "codex" "${local_appdata:+$local_appdata/Programs/OpenAI/Codex/bin/codex.exe}" "${appdata:+$appdata/npm/codex.cmd}"
  check_cli_version "Agy" "agy" "${local_appdata:+$local_appdata/agy/bin/agy.exe}"
  check_cli_version "Kimi" "kimi" "${windows_home:+$windows_home/.kimi-code/bin/kimi.exe}" "${windows_home:+$windows_home/.kimi-code/bin/kimi.cmd}"
  check_cli_version "Grok" "grok" "${windows_home:+$windows_home/.grok/bin/grok.exe}"
  check_cli_version "Cursor" "cursor-agent" "${local_appdata:+$local_appdata/cursor-agent/cursor-agent.cmd}"
  check_cli_version "Copilot" "copilot" "${appdata:+$appdata/npm/copilot.cmd}"
else
  check_cli_version "Codex" "codex"
  check_cli_version "Agy" "agy" "$HOME/.local/bin/agy"
  check_cli_version "Kimi" "kimi" "$HOME/.kimi-code/bin/kimi"
  check_cli_version "Grok" "grok" "$HOME/.grok/bin/grok" "$HOME/.local/bin/grok"
  check_cli_version "Cursor" "cursor-agent" "$HOME/.local/bin/cursor-agent"
  check_cli_version "Copilot" "copilot" "$HOME/.local/bin/copilot"
fi

# Check 2: all six plugin-owned MCP servers. `claude mcp get` exits zero and
# prints the configured path even when connection failed, so only Status counts.
for server in \
  plugin:claude-delegator:codex \
  plugin:claude-delegator:agy \
  plugin:claude-delegator:kimi \
  plugin:claude-delegator:copilot \
  plugin:claude-delegator:grok \
  plugin:claude-delegator:cursor
do
  config=$(claude mcp get "$server" 2>&1)
  name=${server##*:}
  if printf '%s\n' "$config" | grep -Eq '^[[:space:]]*Status:[[:space:]]+[^[:alnum:][:space:]]+[[:space:]]+Connected[[:space:]]*$'; then
    echo "$name MCP: CONNECTED"
  else
    echo "$name MCP: FAILED"
    printf '%s\n' "$config" | grep -E 'Status:|Issue:|No MCP server' || true
  fi
done

# Check 3: Rules installed (count files, without GNU-only find flags)
rule_count=0
for rule in "$rules_root"/*.md; do
  [ -f "$rule" ] || continue
  rule_count=$((rule_count + 1))
done
printf '%s\n' "$rule_count"

# Check 4: Codex auth status. Reuse the exact absolute binary that passed Check 1;
# do not fall back to a second PATH lookup, and capture its status before printing.
if [ -z "$CODEX_BIN" ]; then
  CODEX_AUTH_EXIT_STATUS=127
  echo "Codex auth: SKIPPED (no verified Codex binary from Check 1)"
else
  codex_auth_output=""
  if codex_auth_output=$("$CODEX_BIN" login status 2>&1); then
    CODEX_AUTH_EXIT_STATUS=0
  else
    CODEX_AUTH_EXIT_STATUS=$?
  fi
  codex_auth_first_line="${codex_auth_output%%$'\n'*}"
  if [ "$CODEX_AUTH_EXIT_STATUS" -eq 0 ]; then
    printf 'Codex auth: %s\n' "${codex_auth_first_line:-(no output)}"
  else
    printf 'Codex auth: FAILED (exit %s): %s\n' \
      "$CODEX_AUTH_EXIT_STATUS" "${codex_auth_first_line:-(no output)}"
    printf 'Codex: Run %q login\n' "$CODEX_BIN"
  fi
fi
```

## Step 5: Report Status

Display actual values from the checks above:

```
claude-delegator Status
───────────────────────────────────────────────────
Node.js:        [version from the Node.js runtime check]
Codex CLI:      [version from check 1]
Agy CLI:        [version from check 1]
Kimi CLI:       [version from check 1]
Grok CLI:       [version from check 1]
Cursor CLI:     [version from check 1]
Copilot CLI:    [version from check 1]
Codex MCP:      [status from check 2]
Agy MCP:        [status from check 2]
Kimi MCP:       [status from check 2]
Grok MCP:       [status from check 2]
Cursor MCP:     [status from check 2]
Copilot MCP:    [status from check 2]
Rules:          ✓ [N] files from check 3 in [resolved rules_root]
Codex Auth:     [status from check 4]
───────────────────────────────────────────────────
```

If any check fails, report the specific issue and how to fix it.

## Step 6: Final Instructions

```
Setup complete!

Next steps:
1. Restart Claude Code to load MCP server(s)
2. Authenticate providers as needed:
   - Codex: Run `codex login`
   - Agy: Run `agy` once to complete the Antigravity OAuth flow. There is no API-key variable; the token lives in the CLI's own user configuration.
   - Kimi: Set an `api_key` in `~/.kimi-code/config.toml` or export `KIMI_API_KEY`. Subscription signup via `kimi login` was not open as of 2026-08-17.
   - Grok: Run `grok login`.
   - Cursor: Run `cursor-agent login`; on macOS, unlock the login keychain if the CLI cannot start.
   - Copilot: Run `copilot login`

Five experts available:

┌──────────────────┬─────────────────────────────────────────────┐
│ Architect        │ "How should I structure this service?"      │
│                  │ "What are the tradeoffs of Redis vs X?"     │
│                  │ → System design, architecture decisions     │
├──────────────────┼─────────────────────────────────────────────┤
│ Plan Reviewer    │ "Review this migration plan"                │
│                  │ "Is this implementation plan complete?"     │
│                  │ → Plan validation before execution          │
├──────────────────┼─────────────────────────────────────────────┤
│ Scope Analyst    │ "Clarify the scope of this feature"         │
│                  │ "What am I missing in these requirements?"  │
│                  │ → Pre-planning, catches ambiguities         │
├──────────────────┼─────────────────────────────────────────────┤
│ Code Reviewer    │ "Review this PR"                            │
│                  │ "Find issues in this implementation"        │
│                  │ → Code quality, bugs, maintainability       │
├──────────────────┼─────────────────────────────────────────────┤
│ Security Analyst │ "Is this authentication flow secure?"       │
│                  │ "Harden this endpoint"                      │
│                  │ → Vulnerabilities, threat modeling          │
└──────────────────┴─────────────────────────────────────────────┘

Every expert can advise or implement. The bridges default to non-interactive
`workspace-write`; advisory intent is carried by a clear "do not modify"
instruction. `read-only` is a provider-specific opt-in and is not universally
enforced: consult the installed `model-selection.md` and `orchestration.md`
rules before relying on it.
Expert is auto-detected based on your request.
Explicit: "Ask GPT to...", "Ask Agy to...", "Ask Kimi to...", "Ask Grok to...", "Ask Cursor to...", or "Ask Copilot to..."
```

## Step 7: Ask About Starring

Use AskUserQuestion to ask the user if they'd like to ⭐ star the claude-delegator repository on GitHub to support the project.

Options: "Yes, star the repo" / "No thanks"

**If yes**: Check if `gh` CLI is available and run:
```bash
gh api -X PUT /user/starred/mateusz-klatt/claude-delegator
```

If `gh` is not available or the command fails, provide the manual link:
```
https://github.com/mateusz-klatt/claude-delegator
```

**If no**: Thank them and complete setup without starring.
