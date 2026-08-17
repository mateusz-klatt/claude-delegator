---
name: setup
description: Configure claude-delegator with Codex (GPT), Agy, Kimi, or Copilot MCP servers
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 60000
---

# Setup

Configure GPT (via Codex or Copilot), Agy (Google Antigravity) or Kimi (Moonshot) as specialized expert subagents via native MCP. Five domain experts that can advise OR implement.

## Step 1: Check CLI Dependencies

### Codex (GPT)
```bash
which codex 2>/dev/null && codex --version 2>&1 | head -1 || echo "CODEX_MISSING"
```

### Agy (Antigravity)
```bash
which agy 2>/dev/null || [ -x "$HOME/.local/bin/agy" ] && agy --version 2>&1 | head -1 || echo "AGY_MISSING"
```

### Kimi
```bash
which kimi 2>/dev/null || [ -x "$HOME/.kimi-code/bin/kimi" ] && kimi --version 2>&1 | head -1 || echo "KIMI_MISSING"
```

### Copilot (GPT)
```bash
which copilot 2>/dev/null && copilot --version 2>&1 | head -1 || echo "COPILOT_MISSING"
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
If registration succeeds but the bridge cannot start, re-register with
`--env=PATH=$HOME/.local/bin:$PATH`.
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

**Copilot Missing:**
```
Copilot CLI not found.
Install with: npm install -g @github/copilot
Then authenticate: copilot login
```

**STOP here if no providers are installed.**

## Step 2: Configure MCP Servers

Register your preferred provider(s) as MCP servers using Claude Code's native command:

### Codex (GPT)
```bash
# Idempotent: safe to rerun setup
claude mcp remove codex >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user codex -- node ${CLAUDE_PLUGIN_ROOT}/server/codex/launcher.js -m gpt-5.6-sol -s danger-full-access -a never -c model_reasoning_effort=ultra -c mcp_servers.codex.enabled=false mcp-server
```

### Agy (Antigravity)
```bash
# Idempotent: safe to rerun setup. agy needs no API-key variable — it authenticates
# through the Antigravity OAuth token in its own user configuration.
# ~/.local/bin is frequently missing from the PATH an MCP server inherits, so pin it.
claude mcp remove agy >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user --env=PATH="$HOME/.local/bin:$PATH" agy -- node ${CLAUDE_PLUGIN_ROOT}/server/agy/index.js

# Gemini was removed in 1.5.0; clear any stale registration left by an older install.
claude mcp remove gemini >/dev/null 2>&1 || true
```

### Copilot (GPT)
```bash
# Idempotent: safe to rerun setup
claude mcp remove copilot >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user copilot -- node ${CLAUDE_PLUGIN_ROOT}/server/copilot/index.js
```

This registers the MCP servers at user scope (available across all projects).

## Step 3: Install Orchestration Rules

```bash
mkdir -p ~/.claude/rules/delegator && cp ${CLAUDE_PLUGIN_ROOT}/rules/*.md ~/.claude/rules/delegator/
```

## Step 4: Verify Installation

Run these checks and report results:

```bash
# Check 1: CLI versions
codex --version 2>&1 | head -1 || echo "Not installed"
agy --version 2>&1 | head -1 || echo "Not installed"
kimi --version 2>&1 | head -1 || echo "Not installed"
copilot --version 2>&1 | head -1 || echo "Not installed"

# Check 2: Codex MCP server
CODEX_CONFIG=$(claude mcp get codex 2>/dev/null)
if echo "$CODEX_CONFIG" | grep -q "codex"; then
  MODEL=$(echo "$CODEX_CONFIG" | grep -oE 'gpt-[0-9]+\.[0-9]+-?[a-z]*' | head -1)
  echo "Codex: OK (model: ${MODEL:-unknown})"
else
  echo "Codex: NOT CONFIGURED"
fi

# Check 3: Agy MCP server (authentication is the Antigravity OAuth token, not an env var)
AGY_CONFIG=$(claude mcp get agy 2>/dev/null)
if echo "$AGY_CONFIG" | grep -q "server/agy/index.js"; then
  echo "Agy: OK (using the Antigravity CLI OAuth configuration; verify with a live call)"
else
  echo "Agy: NOT CONFIGURED"
fi

# Check 4: Agy bridge health (initialize handshake)
if echo "$AGY_CONFIG" | grep -q "server/agy/index.js"; then
  BRIDGE_HEALTH=$(printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' \
    | node "${CLAUDE_PLUGIN_ROOT}/server/agy/index.js" 2>/dev/null \
    | grep -q '"id":"health"' && echo "Agy Bridge: HEALTHY" || echo "Agy Bridge: UNHEALTHY")
  echo "$BRIDGE_HEALTH"
else
  echo "Agy Bridge: SKIPPED (Agy MCP not configured)"
fi

# Check 5: Kimi MCP server
KIMI_CONFIG=$(claude mcp get kimi 2>/dev/null)
if echo "$KIMI_CONFIG" | grep -q "server/kimi/index.js"; then
  echo "Kimi: OK"
else
  echo "Kimi: NOT CONFIGURED"
fi

# Check 6: Copilot MCP server
COPILOT_CONFIG=$(claude mcp get copilot 2>/dev/null)
if echo "$COPILOT_CONFIG" | grep -q "server/copilot/index.js"; then
  echo "Copilot: OK"
else
  echo "Copilot: NOT CONFIGURED"
fi

# Check 6: Copilot bridge health (initialize handshake)
if echo "$COPILOT_CONFIG" | grep -q "server/copilot/index.js"; then
  BRIDGE_HEALTH=$(printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' \
    | node "${CLAUDE_PLUGIN_ROOT}/server/copilot/index.js" 2>/dev/null \
    | grep -q '"id":"health"' && echo "Copilot Bridge: HEALTHY" || echo "Copilot Bridge: UNHEALTHY")
  echo "$BRIDGE_HEALTH"
else
  echo "Copilot Bridge: SKIPPED (Copilot MCP not configured)"
fi

# Check 7: Rules installed (count files)
ls ~/.claude/rules/delegator/*.md 2>/dev/null | wc -l

# Check 8: Codex auth status
codex login status 2>&1 | head -1 || echo "Codex: Run 'codex login'"
```

## Step 5: Report Status

Display actual values from the checks above:

```
claude-delegator Status
───────────────────────────────────────────────────
Codex CLI:      [version from check 1]
Agy CLI:        [version from check 1]
Kimi CLI:       [version from check 1]
Copilot CLI:    [version from check 1]
Codex MCP:      [status from check 2]
Agy MCP:        [status from check 3]
Kimi MCP:       [status from check 5]
Agy Bridge:     [status from check 4]
Copilot MCP:    [status from check 5]
Copilot Bridge: [status from check 6]
Rules:          ✓ [N] files in ~/.claude/rules/delegator/
Codex Auth:     [status from check 8]
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

Every expert can advise or implement. The bridges default to non-interactive `workspace-write`; advisory intent is enforced by a clear "do not modify" instruction, while `read-only` is an explicit opt-in.
Expert is auto-detected based on your request.
Explicit: "Ask GPT to...", "Ask Agy to...", "Ask Kimi to...", or "Ask Copilot to..."
```

## Step 7: Ask About Starring

Use AskUserQuestion to ask the user if they'd like to ⭐ star the claude-delegator repository on GitHub to support the project.

Options: "Yes, star the repo" / "No thanks"

**If yes**: Check if `gh` CLI is available and run:
```bash
gh api -X PUT /user/starred/jarrodwatts/claude-delegator
```

If `gh` is not available or the command fails, provide the manual link:
```
https://github.com/jarrodwatts/claude-delegator
```

**If no**: Thank them and complete setup without starring.
