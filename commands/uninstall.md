---
name: uninstall
description: Uninstall claude-delegator (remove MCP config and rules)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 30000
---

# Uninstall

Remove claude-delegator from Claude Code.

## Confirm Removal

**Question**: "Remove the Codex/Agy/Kimi/Copilot/Grok/Cursor MCP plugin and its rules?"
**Options**:
- "Yes, uninstall"
- "No, cancel"

If cancelled, stop here.

## Remove MCP Configuration

```bash
# The MCP servers are declared by the plugin, so uninstalling it removes them.
# These lines only clear hand-added registrations from a setup before 1.9.0,
# which wrote a version-stamped cache path and would otherwise linger.
for s in codex agy kimi copilot grok cursor gemini; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 || true
done

# Remove the plugin that owns the namespaced plugin:claude-delegator:* servers.
claude plugin uninstall --scope user claude-delegator@jarrodwatts-claude-delegator
```

## Remove Installed Rules

```bash
rm -rf ~/.claude/rules/delegator/
```

## Confirm Completion

```
✓ Removed the claude-delegator plugin and its MCP servers
✓ Removed rules from ~/.claude/rules/delegator/

Restart Claude Code to unload any tools retained by the current process.

To reinstall: /claude-delegator:setup
```
