# Claude Delegator

Claude, GPT, and Gemini expert subagents over MCP. Claude Code can orchestrate Codex, Agy, Kimi, and Copilot; Codex and other MCP clients can invoke Claude through the same start/reply contract.

[![License](https://img.shields.io/github/license/mateusz-klatt/claude-delegator?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/mateusz-klatt/claude-delegator?v=2)](https://github.com/mateusz-klatt/claude-delegator/stargazers)

> Fork of [jarrodwatts/claude-delegator](https://github.com/jarrodwatts/claude-delegator) with Copilot and Claude targets, empirically refreshed per-CLI model catalogs, and optional out-of-band progress reporting through MCP Agent Mail.

![Claude Delegator in action](claude-delegator.png)

## Install for Claude Code

Inside a Claude Code instance, run the following commands:

**Step 1: Add the marketplace**
```
/plugin marketplace add mateusz-klatt/claude-delegator
```

**Step 2: Install the plugin**
```
/plugin install claude-delegator@jarrodwatts-claude-delegator
```

> The marketplace registers under the historical label `jarrodwatts-claude-delegator` (preserved in `marketplace.json` for upstream attribution), even though the source repo is the fork.

**Step 3: Run setup**
```
/claude-delegator:setup
```

Done! Claude now routes complex tasks to GPT, Agy, Kimi, and Copilot experts automatically.

> **Note**: Requires at least one of [Codex CLI](https://github.com/openai/codex), the Google Antigravity CLI (`agy`), Kimi Code (`kimi`), the Grok CLI (`grok`), the Cursor Agent CLI (`cursor-agent`), or [Copilot CLI](https://github.com/github/copilot). Setup guides you through installation.

---

## What is Claude Delegator?

An MCP-capable coding agent gains a team of specialists: Claude through Claude CLI, GPT through Codex, Gemini/Claude/GPT-OSS through the Antigravity CLI, Moonshot Kimi through Kimi Code, and the multi-family roster exposed by Copilot. Each expert has a distinct specialty and can advise OR implement.

**Note:** Claude Code should use Codex, Agy, Kimi, or Copilot targets. Configure the Claude target only in a different orchestrator such as Codex; registering Claude inside Claude Code creates an avoidable self-delegation path.

| What You Get | Why It Matters |
|--------------|----------------|
| **5 domain experts** | Right specialist for each problem type |
| **Claude, GPT, or Gemini** | Use your preferred provider (Claude, Codex, Copilot, or Agy) |
| **Dual mode** | Experts can advise or implement; intent is explicit even though bridges default to full non-interactive tools |
| **Auto-routing** | Claude detects when to delegate based on your request |
| **Synthesized responses** | Claude interprets expert output, never raw passthrough |

### The Experts

| Expert | What They Do | Example Triggers |
|--------|--------------|------------------|
| **Architect** | System design, tradeoffs, complex debugging | "How should I structure this?" / "What are the tradeoffs?" |
| **Plan Reviewer** | Validate plans before you start | "Review this migration plan" / "Is this approach sound?" |
| **Scope Analyst** | Catch ambiguities early | "What am I missing?" / "Clarify the scope" |
| **Code Reviewer** | Find bugs, improve quality | "Review this PR" / "What's wrong with this?" |
| **Security Analyst** | Vulnerabilities, threat modeling | "Is this secure?" / "Harden this endpoint" |

### When Experts Help Most

- **Architecture decisions** — "Should I use Redis or in-memory caching?"
- **Stuck debugging** — After 2+ failed attempts, get a fresh perspective
- **Pre-implementation** — Validate your plan before writing code
- **Security concerns** — "Is this auth flow safe?"
- **Code quality** — Get a second opinion on your implementation

### When NOT to Use Experts

- Simple file operations (Claude handles these directly)
- First attempt at any fix (try yourself first)
- Trivial questions (no need to delegate)

---

## How It Works

```
You: "Is this authentication flow secure?"
                    ↓
Claude: [Detects security question → selects Security Analyst]
                    ↓
        ┌───────────────────────────────┐
        │  mcp__plugin_claude-delegator_codex__codex            │
        │  (or mcp__claude__claude)     │
        │  (or mcp__plugin_claude-delegator_agy__agy)          │
        │  (or mcp__plugin_claude-delegator_kimi__kimi)        │
        │  (or mcp__plugin_claude-delegator_copilot__copilot)   │
        │  → Security Analyst prompt    │
        │  → Expert analyzes your code  │
        └───────────────────────────────┘
                    ↓
Claude: "Based on the analysis, I found 3 issues..."
        [Synthesizes response, applies judgment]
```

**Key details:**
- Each expert has a specialized system prompt (in `prompts/`)
- The orchestrator reads your request → picks the right expert → delegates via MCP
- Responses are synthesized, not passed through raw
- Experts can retry up to 3 times before escalating
- Multi-turn conversations preserve context via `threadId` for chained tasks

### Multi-Turn Conversations

For chained implementation steps, the expert preserves context across turns:

```
Turn 1: mcp__*__* → returns threadId
Turn 2: mcp__*__*-reply(threadId) → expert remembers turn 1
Turn 3: mcp__*__*-reply(threadId) → expert remembers turns 1-2
```

Use single-shot (`claude`, `codex`, `agy`, `kimi`, `grok`, `cursor`, or `copilot`) for advisory tasks. Use the matching `*-reply` tool for implementation chains and retries.

### Long-running delegation progress

When the caller supplies a complete Agent Mail coordination envelope and the invoked CLI already has MCP Agent Mail, the target reports `STARTED`, milestone `PROGRESS`, genuine `BLOCKED`, and terminal `COMPLETED` checkpoints out of band. The envelope carries only `projectKey`, the canonical routable `callerAgentName` (`<client>-<os>-<host>-<slot>`), an optional `mailTopic`, and a checkpoint interval—never a caller token, database id, delegation id, or mail thread id. After `STARTED`, the callee replies to its own outbound message, so Agent Mail establishes and preserves the thread internally. The provider session `threadId` remains separate and is used only by `*-reply`. Bridge subprocesses scrub inherited Agent Mail identities and bearer credentials so the callee cannot accidentally report as the caller; provider authentication remains available. If Agent Mail is unavailable or contact policy prevents delivery, delegation continues normally.

---

## Configuration

### Operating Modes

Every expert supports two modes based on the task:

| Mode | Sandbox | Use When |
|------|---------|----------|
| **Advisory** | Default `workspace-write` plus a strict "do not modify" instruction | Analysis, recommendations, reviews without nested approval prompts |
| **Implementation** | `workspace-write` (the provider's non-interactive full-tool mode) | Making changes, fixing issues |

The orchestrator selects the mode based on your request.

### Configuration Defaults

The native Codex target is launched with Codex's own `danger-full-access` sandbox and `never` approval values. A transparent Node launcher preserves the native `codex` / `codex-reply` contract while removing the caller's Agent Mail identity and credentials before Codex starts. The three custom bridges expose only `read-only` and `workspace-write`, defaulting to `workspace-write`: Claude uses permission bypass, Agy uses `--dangerously-skip-permissions`, and Copilot uses `--allow-all-tools`. This avoids an approval prompt blocking both nested CLIs; advisory behavior is enforced by the expert instruction. Explicit `read-only` remains available when refusal is preferable to completion — with two honest exceptions: on Agy it denies shell only, not file writes or network access, and Kimi refuses it outright because print mode has no permission tier.

### Supported Models

| Provider | Default | Selectable models |
|---|---|---|
| **Claude** | `opus` / `claude-opus-5` (`xhigh`) | `opus`, `fable`, `sonnet`, `haiku` aliases and their full IDs. |
| **Codex** | `gpt-5.6-sol` (`ultra`) | Seven account-visible models, from `gpt-5.6-sol` through `gpt-5.3-codex-spark`. |
| **Agy** | `gemini-3.1-pro-high` | Fourteen ids across Gemini, Claude and GPT-OSS; the reasoning tier is baked into the id, so there is no separate effort knob. |
| **Kimi** | `moonshot-ai/kimi-k3` | Four configured aliases; `--model` stays free-form because the roster is user-extensible. |
| **Grok** | `grok-4.6` | One model on this account. The only bridge whose `read-only` denies rather than advises. |
| **Cursor** | `auto` | 204 ids listed, three usable on a Free plan. `auto` is server-routed and not stable across turns. |
| **Copilot** | `gpt-5.6-sol` (`max`) | 27 models across Claude, GPT, Gemini, Grok, Kimi, and MAI; efforts `none` through `max`. |

The discovery sources, account-visible rosters, CLI versions, effort ceilings, live-call evidence, and rejected combinations live in [`config/model-catalog.json`](config/model-catalog.json). Availability still depends on the active account and may change after a CLI update.

### Manual MCP Setup

If `/setup` doesn't work, register the MCP server(s) manually:

```text
Nothing to register by hand. The plugin declares its MCP servers in
.claude-plugin/plugin.json, so installing or updating it is enough and they
appear as plugin:claude-delegator:<name>.

Earlier versions told you to run `claude mcp add ... ${CLAUDE_PLUGIN_ROOT}/...`.
The shell expanded that variable at setup time and stored a version-stamped
cache path, which stopped working as soon as that version directory was removed.
Declared in the manifest, Claude Code resolves it on every launch instead.

If you set up before 1.8.0, clear the stale entries once — REINSTALL FIRST,
then remove, because an installed copy from before this change has no
mcpServers block and removing first would leave you with no servers at all:

  claude plugin marketplace update jarrodwatts-claude-delegator
  claude plugin uninstall claude-delegator@jarrodwatts-claude-delegator
  claude plugin install   claude-delegator@jarrodwatts-claude-delegator
  for s in codex agy kimi copilot grok cursor gemini; do
    claude mcp remove "$s" >/dev/null 2>&1 || true
  done
  # then restart the CLI
```

Verify with:

```bash
claude mcp list
printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' | node ${CLAUDE_PLUGIN_ROOT}/server/agy/index.js
printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' | node ${CLAUDE_PLUGIN_ROOT}/server/copilot/index.js
```

### Codex as orchestrator (including Claude)

The Claude bridge intentionally exposes `claude` and `claude-reply`, matching the existing provider contracts. Add all desired targets to the active Codex host's `CODEX_HOME/config.toml`; the desktop app and CLI can use different homes, so verify with `codex mcp list`.

```toml
[mcp_servers.claude]
command = "node"
args = ["/absolute/path/to/claude-delegator/server/claude/index.js"]
enabled_tools = ["claude", "claude-reply"]
startup_timeout_sec = 20
tool_timeout_sec = 3600
```

See [`config/codex-mcp.example.toml`](config/codex-mcp.example.toml) for Claude, Codex, Agy, Kimi, and Copilot entries. Restart the local Codex client after changing its MCP configuration. Do not add this Claude bridge to Claude Code itself.

The Codex entry disables its own nested `mcp_servers.codex` target, preventing an MCP-started Codex session from recursively targeting itself. `server/codex/launcher.js` is not a protocol bridge and does not load or restrict models: native Codex still owns its tool schema and model selection. The launcher forwards stdio unchanged, scrubs caller identity and credentials, resolves Windows npm shims, and terminates the child process tree with its parent.

### Tests and CI

Unit tests use Node's built-in test runner; `c8` produces the LCOV report consumed by SonarCloud:

```bash
npm ci
npm test
npm run test:coverage
```

[`test/mcp-probe.mjs`](test/mcp-probe.mjs) is a manual stdio handshake/live-call probe and is intentionally excluded from the unit-test glob. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the suite on Node 22 and 24, uploads exact-commit coverage, and scans the [`mateusz-klatt_snapper-delegate`](https://sonarcloud.io/project/overview?id=mateusz-klatt_snapper-delegate) SonarCloud project when the repository has a `SONAR_TOKEN` Actions secret. Without the secret, tests remain green and the scan is skipped with a warning.

### Customizing Expert Prompts

Expert prompts live in `prompts/`. Each follows the same structure:
- Role definition and context
- Advisory vs Implementation modes
- Response format guidelines
- When to invoke / when NOT to invoke

Edit these to customize expert behavior for your workflow.

---

## Requirements

You need at least one of the following target CLIs configured:

- **Claude CLI** (for Claude, from a non-Claude orchestrator): install Claude Code and run `claude auth login`
- **Codex CLI** (for GPT): `npm install -g @openai/codex`
- **Antigravity CLI** (for Agy): install the Google Antigravity CLI; it lands as a native binary, typically `~/.local/bin/agy`
- **Kimi Code** (for Kimi): installs to `~/.kimi-code/bin/kimi`
- **Copilot CLI** (for GPT and Claude models): `npm install -g @github/copilot`

**Authentication**:
- Codex: run `codex login`
- Agy: run `agy` once and complete the Antigravity OAuth flow (no API-key variable)
- Kimi: set an `api_key` in `~/.kimi-code/config.toml` or export `KIMI_API_KEY`. (`kimi login` exists for the subscription device-code flow, but subscription signup was not yet open at the time of writing.)
- Copilot: run `copilot login`


---

## Commands

| Command | Description |
|---------|-------------|
| `/claude-delegator:setup` | Configure MCP server and install rules |
| `/claude-delegator:uninstall` | Remove MCP config and rules |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP server not found | Restart Claude Code after setup |
| Provider not authenticated | Codex: run `codex login`. Agy: run `agy` once to complete the OAuth flow. Kimi: set `KIMI_API_KEY` or an `api_key` in `~/.kimi-code/config.toml`. Copilot: run `copilot login` |
| Tool not appearing | Run `claude mcp list` and verify registration |
| Expert not triggered | Try explicit: "Ask Claude/GPT/Agy/Kimi/Copilot to review..." |
| Codex cannot see targets | Check the active `CODEX_HOME`, run `codex mcp list`, then restart the Codex client |

---

## Development

```bash
git clone https://github.com/mateusz-klatt/claude-delegator
cd claude-delegator

# Test locally without reinstalling
claude --plugin-dir /path/to/claude-delegator
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Acknowledgments

Expert prompts adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by [@code-yeongyu](https://github.com/code-yeongyu).

---

## License

MIT — see [LICENSE](LICENSE)

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mateusz-klatt/claude-delegator&type=Date&v=2)](https://star-history.com/#mateusz-klatt/claude-delegator&Date)
