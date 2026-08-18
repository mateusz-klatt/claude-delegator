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
# historical cache provenance below the active plugin's verified cache family is
# required so an independent same-named user MCP is never removed by this command.
claude_plugin_list=$(claude plugin list --json 2>/dev/null) || claude_plugin_list=""
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
const installPath = records[0].installPath;
const windowsDrive = /^[A-Za-z]:[\\/]/.test(installPath);
const windowsDevice = /^[\\/]{2}[?.][\\/]/.test(installPath);
const windowsUnc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(installPath);
const invalidUncComponent = /[\u0000-\u001F<>:"|?*]/;
const validUnc = windowsUnc && windowsUnc.slice(1).every((component) =>
  component !== "." && component !== ".." && !component.endsWith(".") &&
  !component.endsWith(" ") && !invalidUncComponent.test(component));
const windowsShaped = process.platform === "win32" || /^[A-Za-z]:/.test(installPath) ||
  /^[\\]/.test(installPath) || /^\/\//.test(installPath);
const rawParts = installPath.replaceAll("\\", "/").split("/");
if (windowsDevice || (windowsShaped && !windowsDrive && !validUnc) ||
    installPath.trim() !== installPath || rawParts.some((part) => part === "." || part === "..")) {
  throw new Error("active plugin installPath is not canonical and fully qualified");
}
const pathApi = windowsShaped ? path.win32 : path.posix;
if (!pathApi.isAbsolute(installPath)) {
  throw new Error("active plugin installPath is not canonical and fully qualified");
}
const normalizedInstall = pathApi.normalize(installPath);
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
  if (typeof value !== "string" || !pathApi.isAbsolute(value)) return false;
  const relative = pathApi.relative(versionsRoot, pathApi.normalize(value));
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
legacy_scan_status=$?
if [ "$legacy_scan_status" -ne 0 ]; then
  printf '%s\n' "Could not verify the active plugin cache root; preserving all bare MCP registrations." >&2
  legacy_servers=""
fi
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
