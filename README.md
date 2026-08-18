# Claude Delegator

Multi-provider expert subagents over MCP. Claude Code can orchestrate Codex, Agy, Kimi, Copilot, Grok, and Cursor; Codex and other MCP clients can invoke all seven targets, including Claude, through the same start/reply contract.

[![License](https://img.shields.io/github/license/mateusz-klatt/claude-delegator?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/mateusz-klatt/claude-delegator?v=2)](https://github.com/mateusz-klatt/claude-delegator/stargazers)

> Fork of [jarrodwatts/claude-delegator](https://github.com/jarrodwatts/claude-delegator) with Claude, Copilot, Grok, and Cursor targets, empirically refreshed per-CLI model catalogs, and optional out-of-band progress reporting through MCP Agent Mail.

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

Done! Claude now routes complex tasks to Codex, Agy, Kimi, Copilot, Grok, and Cursor experts automatically.

> **Note**: Requires at least one of [Codex CLI](https://github.com/openai/codex), the Google Antigravity CLI (`agy`), Kimi Code (`kimi`), the Grok CLI (`grok`), the Cursor Agent CLI (`cursor-agent`), or [Copilot CLI](https://github.com/github/copilot). Setup guides you through installation.

---

## What is Claude Delegator?

An MCP-capable coding agent gains a team of specialists: Claude through Claude CLI, GPT through Codex, Gemini/Claude/GPT-OSS through the Antigravity CLI, Moonshot Kimi through Kimi Code, xAI models through Grok, Cursor's hosted model roster, and the multi-family roster exposed by Copilot. Each expert has a distinct specialty and can advise OR implement.

**Note:** Claude Code should use Codex, Agy, Kimi, Copilot, Grok, or Cursor targets. Configure the Claude target only in a different orchestrator such as Codex; registering Claude inside Claude Code creates an avoidable self-delegation path.

| What You Get | Why It Matters |
|--------------|----------------|
| **5 domain experts** | Right specialist for each problem type |
| **Seven MCP targets** | Choose Claude, Codex, Agy, Kimi, Copilot, Grok, or Cursor |
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
        │  (or mcp__plugin_claude-delegator_agy__agy)          │
        │  (or mcp__plugin_claude-delegator_kimi__kimi)        │
        │  (or mcp__plugin_claude-delegator_copilot__copilot)   │
        │  (or mcp__plugin_claude-delegator_grok__grok)         │
        │  (or mcp__plugin_claude-delegator_cursor__cursor)     │
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

Reply calls are new tool invocations, so arguments with bridge schema defaults
are evaluated again. In particular, repeat `sandbox: "read-only"` on every
reply in a read-only chain; otherwise the custom bridges default back to
`workspace-write`. This is not a blanket loss of provider session state:
omitting `effort` on Claude and Copilot replies intentionally lets the resumed
session retain its current effort. Agy replies must repeat the start call's
`model` and `cwd`, because its resumed conversation inherits neither. Keep the
same `cwd` for Kimi when the start used a non-default working directory, and for
Cursor, whose sessions are workspace-bound. See each tool schema for the other
provider-specific arguments.

### Long-running delegation progress

When the caller supplies a complete Agent Mail coordination envelope and the invoked CLI already has MCP Agent Mail, the target reports `STARTED`, milestone `PROGRESS`, genuine `BLOCKED`, and terminal `COMPLETED` checkpoints out of band. Pass the envelope through the dedicated `coordination` argument for Claude, Agy, Kimi, Copilot, Grok, and Cursor; their bridges inject the canonical prompt contract exactly once. Native Codex has no such argument, so its caller embeds the envelope and contract in the task prompt. The envelope carries only `projectKey`, the canonical routable `callerAgentName` (`<client>-<os>-<host>-<slot>`), an optional `mailTopic`, and a checkpoint interval—never a caller token, database id, delegation id, or mail thread id. After `STARTED`, the callee replies to its own outbound message, so Agent Mail establishes and preserves the thread internally. The provider session `threadId` remains separate and is used only by `*-reply`. Bridge subprocesses scrub inherited Agent Mail identities and bearer credentials so the callee cannot accidentally report as the caller; provider authentication remains available. If Agent Mail is unavailable or contact policy prevents delivery, delegation continues normally.

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

The native Codex target is launched with Codex's own `danger-full-access` sandbox and `never` approval values. A transparent Node launcher preserves the native `codex` / `codex-reply` contract while removing the caller's Agent Mail identity and credentials before Codex starts. The six custom bridges default to their non-interactive `workspace-write` modes so a nested approval prompt cannot suspend both CLIs; advisory intent is always carried in the expert instruction. Explicit `read-only` behavior is provider-specific: Claude uses plan mode, Grok adds deny rules for its built-in write and shell tools, Copilot denies shell/write/edit, Agy soft-denies shell but not file writes or network access, Cursor's ask mode deflects but does not enforce, and Kimi refuses the value because print mode has no permission tier.

### Supported Models

| Provider | Default | Selectable models |
|---|---|---|
| **Claude** | `opus` / `claude-opus-5` (`xhigh`) | `opus`, `fable`, `sonnet`, `haiku` aliases and their full IDs. |
| **Codex** | `gpt-5.6-sol` (`ultra`) | Seven account-visible models, from `gpt-5.6-sol` through `gpt-5.3-codex-spark`. |
| **Agy** | `gemini-3.1-pro-high` | Fourteen ids across Gemini, Claude and GPT-OSS; the reasoning tier is baked into the id, so there is no separate effort knob. |
| **Kimi** | `moonshot-ai/kimi-k3` | Four configured aliases; `--model` stays free-form because the roster is user-extensible. Also routes to **Ollama** (local VRAM and cloud `:cloud` models) through the same bridge — see below. |
| **Grok** | `grok-4.6` | One model on this account. `read-only` adds deny rules for built-in write and shell tools. |
| **Cursor** | `auto` | 204 ids listed, three usable on a Free plan. `auto` is server-routed and not stable across turns. |
| **Copilot** | `gpt-5.6-sol` (`max`) | 27 models across Claude, GPT, Gemini, Grok, Kimi, and MAI; start calls clamp verified per-model effort floors and ceilings. Reply calls should omit `effort` to retain the session setting. |

The discovery sources, account-visible rosters, CLI versions, effort ceilings, live-call evidence, and rejected combinations live in [`config/model-catalog.json`](config/model-catalog.json). Availability still depends on the active account and may change after a CLI update.

The supplied Codex registration pins `model_reasoning_effort=ultra`, which is
valid only for `gpt-5.6-sol` and `gpt-5.6-terra` in the verified catalog.
`gpt-5.6-luna` tops out at `max`; the remaining listed Codex models top out at
`xhigh`. When changing the registered Codex model, change the effort in the
same `args` array to a supported value as well.

**Kimi as a bridge to Ollama.** The Kimi bridge reaches more than Moonshot: the same `kimi` / `kimi-reply` tools route to locally-run Ollama weights (VRAM, no cloud spend, code stays on the machine) and to Ollama's hosted models (a `:cloud` suffix, no VRAM). One `[providers.*]` block in `~/.kimi-code/config.toml` buys both; pass `model: "ollama-local/ornith-9b"` for a local model or `model: "ollama-cloud/deepseek-v4-pro"` for a hosted one. Local models are **advisory only** — a plausible-looking wrong edit is the failure that matters, not slowness, so read the work before using it. The full recipe, VRAM sizing arithmetic, and a tier-by-tier comparison live in [`rules/model-selection.md`](rules/model-selection.md) → "Ollama through the Kimi bridge".

### Repair MCP registration after an upgrade

If `/setup` doesn't work after an upgrade, repair the plugin-owned registrations as follows:

Nothing to register by hand. The plugin declares its MCP servers in
`.claude-plugin/plugin.json`, so installing or updating it is enough and they
appear as `plugin:claude-delegator:<name>`.

Earlier versions told you to run `claude mcp add ... ${CLAUDE_PLUGIN_ROOT}/...`.
The shell expanded that variable at setup time and stored a version-stamped
cache path, which stopped working as soon as that version directory was removed.
Declared in the manifest, Claude Code resolves it on every launch instead.

If you set up before 1.9.0, clear the stale entries once — UPDATE FIRST,
then remove, because an installed copy from before this change has no
`mcpServers` block and removing first would leave you with no servers at all:

```bash
# Keep the fail-closed migration isolated: `exit` below stops this subshell,
# not an interactive parent shell into which the block may be pasted.
(
set -e

claude plugin marketplace update jarrodwatts-claude-delegator
claude plugin update --scope user claude-delegator@jarrodwatts-claude-delegator

# Ask Claude Code which install is active instead of assuming its default state
# or cache directories; both can be overridden. Fail closed unless that active
# user-scope install declares all six servers.
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

# Discover only user-scoped bare registrations created by the pre-1.9 setup:
# their entrypoint must have the exact historical marketplace-cache lineage.
# Same-named MCP servers in independent clones are deliberately ignored.
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

# Preflight every recognized pair before the first removal. Running health
# checks in an empty temporary directory prevents a same-named project/local
# registration from shadowing the user-scoped legacy entry. A disconnected old
# entry cannot provide a fallback and therefore does not block cleanup. A
# connected one requires its own connected replacement; legacy gemini maps to
# Agy, which replaced that provider in 1.5.0.
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

The scan ignores local/project registrations, independent clones, and unrelated
user MCP servers that merely share one of these short names. Only the exact
historical marketplace-cache lineage is auto-removed; inspect any ambiguous
same-named entry manually. Preflight completes for every recognized entry before
any removal; a connected legacy `gemini` requires the namespaced Agy replacement.
Then restart the CLI.

Verify with:

```bash
claude mcp list
for s in codex agy kimi copilot grok cursor; do
  claude mcp get "plugin:claude-delegator:$s"
done
```

### Codex as orchestrator (including Claude)

The Claude bridge intentionally exposes `claude` and `claude-reply`, matching the existing provider contracts. Add all desired targets to the active Codex host's `CODEX_HOME/config.toml`; the desktop app and CLI can use different homes, so verify with `codex mcp list`.

```toml
[mcp_servers.claude]
command = "node"
args = ["/absolute/path/to/claude-delegator/server/claude/index.js"]
enabled_tools = ["claude", "claude-reply"]
startup_timeout_sec = 45
tool_timeout_sec = 3600
```

See [`config/codex-mcp.example.toml`](config/codex-mcp.example.toml) for all seven targets: Claude, Codex, Agy, Kimi, Copilot, Grok, and Cursor. Restart the local Codex client after changing its MCP configuration. Do not add this Claude bridge to Claude Code itself.

The static plugin manifest cannot safely disable `mcp_servers.codex`: that override creates an invalid transport when the host has no such table. If the active Codex host does keep a self-referential `[mcp_servers.codex]`, add `-c mcp_servers.codex.enabled=false` to that registration as shown in `config/codex-mcp.example.toml`. `server/codex/launcher.js` is not a protocol bridge and does not load or restrict models: native Codex still owns its tool schema and model selection. The launcher forwards stdio unchanged, scrubs caller identity and credentials, resolves Windows npm shims, and terminates the child process tree with its parent. An explicit `CODEX_DELEGATOR_CODEX_BIN` override must be an absolute executable or JS-loader path; omit it to use the normal PATH lookup.

### Tests and CI

Unit tests use Node's built-in test runner; `c8` produces the LCOV report consumed by SonarCloud:

```bash
npm ci
npm test
npm run test:coverage
```

[`test/mcp-probe.mjs`](test/mcp-probe.mjs) is a manual stdio handshake/live-call probe and is intentionally excluded from the unit-test glob. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the suite on Node 22 and 24, uploads exact-commit coverage, and scans the [`mateusz-klatt_claude-delegator`](https://sonarcloud.io/project/overview?id=mateusz-klatt_claude-delegator) SonarCloud project when the repository has a `SONAR_TOKEN` Actions secret. Without the secret, tests remain green and the scan is skipped with a warning.

### Customizing Expert Prompts

Expert prompts live in `prompts/`. Each follows the same structure:
- Role definition and context
- Advisory vs Implementation modes
- Response format guidelines
- When to invoke / when NOT to invoke

Edit these to customize expert behavior for your workflow.

---

## Requirements

The MCP bridges require **Node.js 22.12.0 or newer**.

You need at least one of the following target CLIs configured:

- **Claude CLI** (for Claude, from a non-Claude orchestrator): install Claude Code and run `claude auth login`
- **Codex CLI** (for GPT): `npm install -g @openai/codex`; measured Windows fallbacks are `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` and `%APPDATA%\npm\codex.cmd`
- **Antigravity CLI** (for Agy): typically `~/.local/bin/agy` on POSIX or `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows
- **Kimi Code** (for Kimi): `~/.kimi-code/bin/kimi` on POSIX; `kimi.exe` or `kimi.cmd` in the same directory on Windows
- **Copilot CLI** (for GPT and Claude models): `npm install -g @github/copilot`; the measured Windows npm fallback is `%APPDATA%\npm\copilot.cmd`
- **Grok CLI** (for xAI models): `~/.grok/bin/grok` or `~/.local/bin/grok` on POSIX; `~/.grok/bin/grok.exe` on Windows
- **Cursor Agent CLI** (for Cursor-hosted models): `~/.local/bin/cursor-agent` on POSIX or `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd` on Windows

**Authentication**:
- Codex: run `codex login`
- Agy: run `agy` once and complete the Antigravity OAuth flow (no API-key variable)
- Kimi: set an `api_key` in `~/.kimi-code/config.toml` or export `KIMI_API_KEY`. (`kimi login` exists for the subscription device-code flow, but subscription signup was not yet open at the time of writing.)
- Copilot: run `copilot login`
- Grok: run `grok login`
- Cursor: run `cursor-agent login`; on macOS, unlock the login keychain if the CLI cannot start


---

## Commands

| Command | Description |
|---------|-------------|
| `/claude-delegator:setup` | Verify plugin-owned MCP servers and install orchestration rules |
| `/claude-delegator:uninstall` | Remove the plugin, legacy MCP registrations, and copied rules |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP server not found | Restart Claude Code after setup |
| Provider not authenticated | Codex: `codex login`. Agy: run `agy` once. Kimi: set `KIMI_API_KEY` or an `api_key` in `~/.kimi-code/config.toml`. Copilot: `copilot login`. Grok: `grok login`. Cursor: `cursor-agent login` |
| Tool not appearing | Run `claude mcp list` and verify registration |
| Expert not triggered | In Claude Code, try explicit: "Ask GPT/Agy/Kimi/Copilot/Grok/Cursor to review..." The Claude target is for a different MCP orchestrator such as Codex. |
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
