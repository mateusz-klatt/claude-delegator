---
name: uninstall
description: Uninstall claude-delegator (remove plugin, legacy MCP registrations, and installed rules)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 30000
---

# Uninstall

Remove the claude-delegator plugin from Claude Code together with legacy user-scoped MCP registrations and copied orchestration rules.

## Confirm Removal

**Question**: "Remove the Codex/Agy/Kimi/Copilot/Grok/Cursor MCP plugin, legacy registrations, and its rules?"
**Options**:
- "Yes, uninstall"
- "No, cancel"

If cancelled, stop here.

## Remove MCP Configuration

```bash
# The MCP servers are declared by the plugin, so uninstalling it removes them.
# Clear only legacy hand-added registrations from a setup before 1.9.0. Exact
# historical cache provenance is required so an independent same-named user MCP
# is never removed by this command.
legacy_servers="$(
  node - <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const state = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
  : path.join(os.homedir(), ".claude.json");
let user;
try {
  user = JSON.parse(fs.readFileSync(state, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}
const legacy = ["codex", "agy", "kimi", "copilot", "grok", "cursor", "gemini"];
const cacheVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function isHistoricalEntrypoint(value, name) {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  for (let i = 0; i + 7 < parts.length; i += 1) {
    if (parts[i] !== "plugins" || parts[i + 1] !== "cache") continue;
    if (parts[i + 2] !== "jarrodwatts-claude-delegator") continue;
    if (parts[i + 3] !== "claude-delegator" || !cacheVersion.test(parts[i + 4])) continue;
    if (parts[i + 5] !== "server" || parts[i + 6] !== name) continue;
    const allowedEntrypoints = name === "codex" ? ["launcher.js", "index.js"] : ["index.js"];
    if (i + 8 === parts.length && allowedEntrypoints.includes(parts[i + 7])) return true;
  }
  return false;
}
for (const name of legacy) {
  const entry = user.mcpServers?.[name];
  if (!entry) continue;
  const candidates = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    .filter((value) => typeof value === "string");
  if (candidates.some((value) => isHistoricalEntrypoint(value, name))) {
    console.log(name);
  }
}
NODE
)"
for s in $legacy_servers; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 || true
done

# Remove the plugin that owns the namespaced plugin:claude-delegator:* servers.
claude plugin uninstall --scope user claude-delegator@jarrodwatts-claude-delegator
```

## Remove Installed Rules

```bash
rules_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/rules/delegator"
rm -rf -- "$rules_root"
```

## Confirm Completion

```
✓ Removed the claude-delegator plugin and its MCP servers
✓ Removed recognized legacy user-scoped MCP registrations
✓ Preserved ambiguous or independently owned same-named MCP registrations
✓ Removed rules from the active Claude profile's rules/delegator/ directory
```

Restart Claude Code to unload any tools retained by the current process.

To reinstall, restore the command first and then run setup:

1. `/plugin install claude-delegator@jarrodwatts-claude-delegator`
2. `/claude-delegator:setup`
