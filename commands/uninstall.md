---
name: uninstall
description: Uninstall claude-delegator (remove MCP config and rules)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 30000
---

# Uninstall

Remove claude-delegator from Claude Code.

## Confirm Removal

**Question**: "Remove Codex/Agy/Kimi/Copilot MCP configuration and plugin rules?"
**Options**:
- "Yes, uninstall"
- "No, cancel"

If cancelled, stop here.

## Remove MCP Configuration

```bash
# The MCP servers are declared by the plugin, so uninstalling it removes them.
# These lines only clear hand-added registrations from a setup before 1.8.0,
# which wrote a version-stamped cache path and would otherwise linger.
for s in codex agy kimi copilot grok cursor gemini; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 || true
done
```

## Remove Installed Rules

```bash
rm -rf ~/.claude/rules/delegator/
```

## Confirm Completion

```
✓ Removed providers from MCP servers
✓ Removed rules from ~/.claude/rules/delegator/

To reinstall: /claude-delegator:setup
```
