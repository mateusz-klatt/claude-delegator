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
claude mcp remove --scope user codex
claude mcp remove --scope user agy
claude mcp remove --scope user kimi
claude mcp remove --scope user gemini  # removed in 1.5.0; clears a stale registration
claude mcp remove --scope user copilot
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
