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
else
  echo "CODEX_MISSING"
fi
```

### Agy (Antigravity)
```bash
if command -v agy >/dev/null 2>&1; then
  agy --version 2>&1 | head -1
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
Install with: npm install -g @openai/codex
Then authenticate: codex login
```

**Agy Missing:**
```
Agy (Google Antigravity) CLI not found.
Install the Antigravity CLI; it lands as a native binary, typically ~/.local/bin/agy.
Then authenticate: launch `agy` once and complete the Antigravity OAuth flow.
Note: ~/.local/bin is often absent from the minimal PATH an MCP server inherits.
```

**Kimi Missing:**
```
Kimi Code CLI not found.
Install Kimi Code; it lands in ~/.kimi-code/bin/kimi.
Then authenticate: set an api_key in ~/.kimi-code/config.toml or export KIMI_API_KEY.
(`kimi login` covers the subscription device-code flow, but subscription signup
was not open for registration as of 2026-08-17.)
Note: ~/.kimi-code/bin is often absent from the minimal PATH an MCP server inherits.
```

**Grok Missing:**
```
Grok CLI not found.
Install the Grok CLI; it typically lands in ~/.grok/bin/grok or ~/.local/bin/grok.
Then authenticate: grok login
```

**Cursor Missing:**
```
Cursor Agent CLI not found.
Install Cursor Agent; on POSIX it typically lands in ~/.local/bin/cursor-agent.
Then authenticate: cursor-agent login
On macOS, unlock the login keychain if even `cursor-agent --version` fails.
On Windows, only PATH is supported; no install-location fallback has been measured.
```

**Copilot Missing:**
```
Copilot CLI not found.
Install with: npm install -g @github/copilot
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
`~/.grok/bin`, and Kimi's `~/.kimi-code/bin`. Cursor on Windows remains
PATH-only because its install directory has not been measured; the bridge ships
no guessed fallback. `test/provider-config.test.js` holds that guarantee.

### Clearing registrations from an older install

If you ran a previous setup, you still have hand-added entries that will now
duplicate the plugin-provided ones. **Reinstall first, remove second** — the order
matters and the other way round is destructive:

```bash
# Keep the fail-closed migration isolated: `exit` below stops this subshell,
# not an interactive parent shell into which the block may be pasted.
(
set -e

# 1. Get a plugin copy that actually declares the servers.
claude plugin marketplace update jarrodwatts-claude-delegator
claude plugin uninstall claude-delegator@jarrodwatts-claude-delegator
claude plugin install   claude-delegator@jarrodwatts-claude-delegator

# 1b. Confirm the reinstall actually delivered what step 2 depends on. Read the
#     manifest from Claude Code's active user-scope installPath, never by guessing
#     which version-shaped cache directory is active. Fail closed on ambiguity.
node - <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const expected = ["agy", "codex", "copilot", "cursor", "grok", "kimi"];
const state = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const installed = JSON.parse(fs.readFileSync(state, "utf8"));
const records = (installed.plugins?.["claude-delegator@jarrodwatts-claude-delegator"] || [])
  .filter((record) => record.scope === "user");
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

# 1c. A present manifest is not enough: each namespaced bridge must start before
#     the fallback registrations are removed.
for server in \
  plugin:claude-delegator:codex \
  plugin:claude-delegator:agy \
  plugin:claude-delegator:kimi \
  plugin:claude-delegator:copilot \
  plugin:claude-delegator:grok \
  plugin:claude-delegator:cursor
do
  config=$(claude mcp get "$server" 2>&1)
  if ! printf '%s\n' "$config" | grep -Eq '^[[:space:]]*Status:[[:space:]]+[^[:alnum:][:space:]]+[[:space:]]+Connected[[:space:]]*$'; then
    printf '%s\n' "$server is not Connected; stop before removing legacy registrations."
    exit 1
  fi
done

# 2. Only now drop the hand-added entries.
for s in codex agy kimi copilot grok cursor gemini; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 || true
done
)
```

3. Restart the CLI.

Removing first leaves you with **no servers at all** whenever the installed copy
predates this change, because a cache from an earlier version has no `mcpServers`
block to fall back on — and the symptom is `CONNECTION_CLOSED`, the same one two
unrelated defects already produced today. Reinstalling first means you are briefly
carrying duplicates, which is harmless, instead of briefly carrying nothing.

`gemini` is in the list because that bridge was removed in 1.5.0 and an old
registration may still be sitting there.

The user-scoped plugin makes these dynamically configured servers available
across projects; they are not separate user-scope `claude mcp add` entries.

## Step 3: Install Orchestration Rules

```bash
mkdir -p ~/.claude/rules/delegator && cp ${CLAUDE_PLUGIN_ROOT}/rules/*.md ~/.claude/rules/delegator/
```

## Step 4: Verify Installation

Run these checks and report results:

```bash
# Check 1: CLI versions, including measured install-location fallbacks.
check_cli_version() {
  label="$1"
  cli="$2"
  shift 2
  binary=""
  if command -v "$cli" >/dev/null 2>&1; then
    binary="$cli"
  else
    for fallback in "$@"; do
      if [ -x "$fallback" ]; then
        binary="$fallback"
        break
      fi
    done
  fi
  if [ -z "$binary" ]; then
    echo "$label CLI: NOT INSTALLED"
    return
  fi
  if version=$("$binary" --version 2>&1); then
    echo "$label CLI: $(printf '%s\n' "$version" | head -1)"
  else
    echo "$label CLI: FAILED TO START"
    printf '%s\n' "$version" | head -1
  fi
}

check_cli_version "Codex" "codex"
check_cli_version "Agy" "agy" "$HOME/.local/bin/agy"
check_cli_version "Kimi" "kimi" "$HOME/.kimi-code/bin/kimi"
check_cli_version "Grok" "grok" "$HOME/.grok/bin/grok" "$HOME/.local/bin/grok"
if [ "${OS:-}" = "Windows_NT" ]; then
  check_cli_version "Cursor" "cursor-agent"
else
  check_cli_version "Cursor" "cursor-agent" "$HOME/.local/bin/cursor-agent"
fi
check_cli_version "Copilot" "copilot" "$HOME/.local/bin/copilot"

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

# Check 3: Rules installed (count files)
ls ~/.claude/rules/delegator/*.md 2>/dev/null | wc -l

# Check 4: Codex auth status
codex login status 2>&1 | head -1 || echo "Codex: Run 'codex login'"
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
Rules:          ✓ [N] files from check 3 in ~/.claude/rules/delegator/
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

Every expert can advise or implement. The bridges default to non-interactive `workspace-write`; advisory intent is carried by a clear "do not modify" instruction, while `read-only` is an explicit provider-specific opt-in with the limitations documented above.
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
