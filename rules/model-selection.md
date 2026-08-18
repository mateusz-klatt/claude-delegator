# Model Selection Guidelines

Claude, GPT (Codex), Agy, Kimi, Copilot, Grok, and Cursor experts serve as specialized consultants for complex problems.

## Provider Selection

Before delegating, check which MCP tools are available in the current environment:

1. **If multiple are available**:
   - Use **Claude** when the user explicitly asks for Claude. Do not register Claude as a target inside Claude Code itself.
   - Use **Agy** for tasks requiring large context, or when you want a Gemini, Claude or GPT-OSS model from a single provider.
   - Use **GPT (Codex)** for tasks where the user explicitly asked for "GPT" or "Codex".
   - Use **Copilot** for tasks where the user explicitly asked for "Copilot".
   - Use **Kimi** for tasks where the user explicitly asked for "Kimi", or for a Moonshot second opinion.
   - Use **Grok** when the user explicitly asks for Grok or wants an xAI second opinion.
   - Use **Cursor** when the user explicitly asks for Cursor or a Composer model.
   - Default to **Agy** for general reasoning.
   - Do **not** use Agy, Kimi, or Cursor when the caller genuinely needs enforced denial; Agy and Cursor are advisory/deflecting, and Kimi refuses `read-only`. Use Claude or Copilot for provider-enforced denial, Grok for denial of its built-in write/shell tools, or a native Codex registration explicitly configured read-only instead of this project's `danger-full-access` default.
   - Prefer Claude, Codex or Agy over Kimi when delegating into a repository you do not control: Kimi auto-loads its `AGENTS.md` with no off switch.
2. **If only one is available**: Use the available provider regardless of the task type.
3. **If none are available**: Do not delegate. In Claude Code, suggest `/claude-delegator:setup`; in another MCP client, point to `config/codex-mcp.example.toml` or that client's MCP configuration.

For the account-specific roster, use `config/model-catalog.json` as the source of truth. Rosters were refreshed on 2026-08-17; installed CLI versions were rechecked on 2026-08-18 (agy via `agy models`, copilot via `copilot help config`, codex via its models cache). Claude's roster is corroborated against the CLI bundle because its selector is interactive. The catalog records selector/cache/registry/help discovery separately from combinations that completed a live call; backend access still depends on the active account.

## Expert Directory

| Expert | Specialty | Best For |
|--------|-----------|----------|
| **Architect** | System design | Architecture, tradeoffs, complex debugging |
| **Plan Reviewer** | Plan validation | Reviewing plans before execution |
| **Scope Analyst** | Requirements analysis | Catching ambiguities, pre-planning |
| **Code Reviewer** | Code quality | Code review, finding bugs |
| **Security Analyst** | Security | Vulnerabilities, threat modeling, hardening |

## Operating Modes

Every expert can operate in two modes:

The mode is determined by the task, not the expert, and must always be stated in `developer-instructions`. The six custom bridges expose `read-only` and `workspace-write` (Kimi accepts `workspace-write` alone); unattended delegation defaults to `workspace-write`, which deliberately maps to each provider's non-interactive full-tool mode. Advisory calls use the same default while carrying an explicit "do not modify" instruction. Explicit `read-only` behavior is provider-specific: Grok and Copilot add deny rules, Claude uses plan mode, Agy soft-denies only shell, Cursor deflects rather than enforces, and Kimi refuses the value. Native Codex retains its own setting name, `danger-full-access`, with `approval_policy = "never"`. These are provider permission policies, not a portable OS-level sandbox.

## Expert Details

### Architect

**Specialty**: System design, technical strategy, complex decision-making

**When to use**:
- System design decisions
- Database schema design
- API architecture
- Multi-service interactions
- After 2+ failed fix attempts
- Tradeoff analysis

**Philosophy**: Pragmatic minimalism—simplest solution that works.

**Output format**:
- Advisory: Bottom line, action plan, effort estimate
- Implementation: Summary, files modified, verification

### Plan Reviewer

**Specialty**: Plan validation, catching gaps and ambiguities

**When to use**:
- Before starting significant work
- After creating a work plan
- Before delegating to other agents

**Philosophy**: Ruthlessly critical—finds every gap before work begins.

**Output format**: APPROVE/REJECT with justification and criteria assessment

### Scope Analyst

**Specialty**: Pre-planning analysis, requirements clarification

**When to use**:
- Before planning unfamiliar work
- When requirements feel vague
- When multiple interpretations exist
- Before irreversible decisions

**Philosophy**: Surface problems before they derail work.

**Output format**: Intent classification, findings, questions, risks, recommendation

### Code Reviewer

**Specialty**: Code quality, bugs, maintainability

**When to use**:
- Before merging significant changes
- After implementing features (self-review)
- For security-sensitive changes

**Philosophy**: Review like you'll maintain it at 2 AM during an incident.

**Output format**:
- Advisory: Issues list with APPROVE/REQUEST CHANGES/REJECT
- Implementation: Issues fixed, files modified, verification

### Security Analyst

**Specialty**: Vulnerabilities, threat modeling, security hardening

**When to use**:
- Authentication/authorization changes
- Handling sensitive data
- New API endpoints
- Third-party integrations
- Periodic security audits

**Philosophy**: Attacker's mindset—find vulnerabilities before they do.

**Output format**:
- Advisory: Threat summary, vulnerabilities, risk rating
- Implementation: Vulnerabilities fixed, files modified, verification

## Codex Parameters Reference

### `mcp__plugin_claude-delegator_codex__codex` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Controls file access. The distributed launcher starts the server with `danger-full-access` |
| `approval-policy` | `untrusted`, `on-request`, `never` | Controls shell command approval. The distributed launcher starts the server with `never` |
| `model` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` | Models visible to this Codex account at verification time |
| `config` | key-value object | Override `config.toml` settings per-call — including `model_reasoning_effort`, which a `model` override does not adjust on its own |
| `cwd` | path | Working directory for the task |
| `base-instructions` | string | Override default system instructions |
| `compact-prompt` | string | Prompt used when compacting conversation |

**Effort guidance**: the launcher pins `model_reasoning_effort=ultra` when it starts the server, and a per-call `model` override does **not** lower it. Only `gpt-5.6-sol` and `gpt-5.6-terra` accept `ultra`; `gpt-5.6-luna` stops at `max`, and `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.3-codex-spark` stop at `xhigh`. Delegating to any of those without also passing `config: {"model_reasoning_effort": "xhigh"}` (or `"max"` for `gpt-5.6-luna`) fails with an HTTP 400 `unsupported_value` on `reasoning.effort` before the session starts, so no work happens and no `threadId` comes back to resume. Codex reports the pinned value as `max` in that error because it normalises `ultra` at the API layer. Unlike the Copilot bridge, which clamps effort per model in `resolveEffort`, the transparent launcher never inspects the call and cannot correct this for you.

### `mcp__plugin_claude-delegator_codex__codex-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `codex` call |
| `prompt` | string | **Required.** Follow-up instruction |

## Agy Parameters Reference

### `mcp__plugin_claude-delegator_agy__agy` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`), prepended to the prompt |
| `sandbox` | `read-only`, `workspace-write` | `workspace-write` passes `--dangerously-skip-permissions`; `read-only` omits it. Default: `workspace-write`. See **Sandbox honesty**. |
| `model` | one of the 14 ids under `providers.agy.models` in `config/model-catalog.json` | Hard allowlist. Default: `gemini-3.1-pro-high` |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `cwd` | path | Working directory; it becomes the session workspace |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

**Model guidance**: `gemini-3.1-pro-high` (default) for expert work. The reasoning tier is baked into most ids — `-low`, `-medium`, `-high` — so pick the tier by picking the model. Use `gemini-3.5-flash-low` for quick low-stakes checks, `claude-sonnet-4-6` or `claude-opus-4-6-thinking` for a cross-family second opinion, and `gpt-oss-120b-medium` for an open-weights perspective.

**No effort parameter**: the bridge never emits `--effort` and the tools do not expose it. Combining `--effort` with a tier-suffixed id fails pre-flight (`conflicts with --effort=high`), the two Claude ids reject the flag outright, and a bare family id would require it. Selecting the tier through `model` makes all of those unreachable. This is the opposite of the Codex trap documented above: there, a `model` override without a matching effort override fails; here, effort simply is not a separate knob.

**Timeout guidance**: Advisory consults finish well inside the 15-minute default, so leave `timeout` unset for them. Raise it explicitly — up to `3600000` (1 hour, the ceiling) — for implementation runs that refactor across files or execute a test suite. The bridge also passes agy's own `--print-timeout`, set to the requested timeout minus a 30-second startup budget, so agy gives up fractionally before our hard kill. That ordering matters: on its own timeout agy still persists the conversation and returns its id, so the run is resumable via `agy-reply`, and the bridge surfaces that id in the error text as `(resumable threadId: …)`. Edits already written to disk are **not** rolled back either way, so estimate generously.

**Sandbox honesty**: agy has no provider-enforced read-only tier in headless print mode. `--mode plan` is delivered as a slash-command expansion, so it is inert under the `--disable-slash-commands` the bridge must always pass; with slash commands enabled it is only a behavioural nudge and was verified letting a write through under an insistent prompt. `read-only` therefore omits `--dangerously-skip-permissions`, which soft-denies `run_command` and nothing else — `write_to_file`, `search_web` and `read_url_content` all remain available, and writes are not confined to the workspace. It is strictly more restrictive than the default and nothing more. Carry advisory intent in `developer-instructions`, exactly as for every other provider. An operator who needs real denial must add `permissions.deny` entries to `~/.gemini/antigravity-cli/settings.json`; the bridge never writes that file.

**Workspace context**: the bridge deliberately does not pass `--add-dir`. The `cwd` alone becomes the session workspace and already grants file access, whereas `--add-dir` additionally triggers agy's rules discovery and injects repository-supplied `AGENTS.md` / `GEMINI.md` into the session — a prompt-injection surface when the delegation target is code you did not write. Verified: with `cwd` only, the agent read workspace files while a planted `AGENTS.md` sentinel never reached the model. Repo-supplied `.agents/plugins/*/mcp_config.json` likewise did not execute without `--add-dir`. Note that outbound HTTP (`search_web`, `read_url_content`) is always available regardless of `sandbox`, so a delegation into untrusted code retains an exfiltration path; deny those tools in `settings.json` if that matters.

**Prompt paths**: state the absolute workspace path in the prompt body. Relative phrasing such as "the current directory" was observed making agy target `~/.gemini/antigravity-cli/scratch` instead, while still reporting `status: SUCCESS`.

**Reply re-pins the model**: unlike every sibling bridge, `agy-reply` **requires** `model`. A resumed agy conversation inherits neither its model nor its workspace — omitting the flag silently falls back to the user's `settings.json` default, which was observed switching a Flash-tier session to Gemini 3.7 Flash (High) mid-conversation. Echo back the model the start call used, and pass the same `cwd`.

### `mcp__plugin_claude-delegator_agy__agy-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** `conversation_id` from the previous `agy` call. The bridge fails loudly if agy resumes a different conversation. |
| `prompt` | string | **Required.** Follow-up instruction |
| `model` | same allowlist | **Required.** A resume does not inherit the model |
| `sandbox` | `read-only`, `workspace-write` | Repeat the original value; a resume inherits no permission state |
| `cwd` | path | Repeat the original value; a resume does not inherit the workspace |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

## Kimi Parameters Reference

### `mcp__plugin_claude-delegator_kimi__kimi` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`), prepended to the prompt |
| `sandbox` | `workspace-write` only | `read-only` is **refused** with -32602. See **Sandbox honesty** below. |
| `model` | alias from `~/.kimi-code/config.toml` | Free-form; the roster is user-extensible. Default: `moonshot-ai/kimi-k3` |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `cwd` | path | Working directory. **A repository `AGENTS.md` here is auto-loaded.** |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

**Model guidance**: `moonshot-ai/kimi-k3` (default) for expert work; `moonshot-ai/kimi-k2.7-code` for coding tasks, `moonshot-ai/kimi-k2.7-code-highspeed` for quick low-stakes checks, `moonshot-ai/kimi-k2.6` as a fallback. The alias is free-form because `kimi provider catalog` can import more providers; an unknown alias fails with exit 1 and a clear message before any work happens.

**Authentication**: Kimi Code supports a subscription (`kimi login`, device-code flow) and an API key, but subscription signup was not yet open as of 2026-08-17 — in practice it is the API key. Put it in `~/.kimi-code/config.toml` or export `KIMI_API_KEY` / `MOONSHOT_API_KEY`; the bridge forwards the caller environment untouched apart from Agent Mail identity. Be aware the CLI also recognises a large catalog of third-party provider key variables (`ANTHROPIC_API_KEY`, `AZURE_API_KEY` and many more), so any such key exported in the parent shell is visible to the delegated process.

**No effort parameter**: kimi exposes no effort flag. Reasoning depth is the `[thinking]` toggle in `~/.kimi-code/config.toml`, which is user state the bridge deliberately does not touch.

**Timeout guidance**: kimi has no timeout flag of its own, so the bridge deadline is the only one. On expiry the bridge SIGTERMs the process group; edits already written to disk are **not** rolled back, and there is no resumable-id recovery path like Agy's. Estimate generously for implementation runs.

**Sandbox honesty**: kimi print mode has **no permission tier at all**. `--plan`, `--yolo` and `--auto` are each rejected outright when combined with `--prompt` (`Cannot combine --prompt with --plan`), and a plain `-p` run created a file unprompted. There is nothing to map `read-only` onto, so the bridge **refuses** it with -32602 rather than accept a value that would change nothing. Every kimi delegation is effectively implementation-mode; carry any do-not-modify intent in `developer-instructions` and treat it as advisory only, not enforced. When a caller genuinely needs enforced denial, route to Claude or Copilot, use Grok for denial of its built-in write/shell tools, or use a native Codex registration explicitly configured read-only.

**Workspace context**: a repository-supplied `AGENTS.md` in `cwd` is auto-loaded into the session. Verified: the sentinel instruction was honoured with the file present and the model answered `NO_CODEWORD` in a clean directory. `--skills-dir` pointed at an empty directory does **not** suppress it, and no off switch was found. This is a wider prompt-injection surface than Agy's, where omitting `--add-dir` prevents rules injection entirely — so treat every kimi delegation as trusting the target repository, and prefer another provider when delegating into code you did not write.

### `mcp__plugin_claude-delegator_kimi__kimi-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** `session_id` from the previous `kimi` call. The bridge fails loudly if kimi resumes a different session. |
| `prompt` | string | **Required.** Follow-up instruction |
| `sandbox` | `workspace-write` only | Repeat the supported start value; `read-only` is refused |
| `cwd` | path | Working directory. **Match the start call's `cwd`** when it was non-default — see below |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

The bridge never passes `--continue`, which resumes "the previous session for the working directory" and would cross-talk between concurrent delegations sharing a `cwd`.

**`cwd` must match the start call's `cwd`** when the start used a non-default working directory. The kimi CLI binds a session to the directory it was created under, and resuming from a different one fails with `Session was created under a different directory`. The bridge passes `cwd` through unchanged and so preserves this binding faithfully; the table marks `cwd` optional only because a start that used the default cwd needs no `cwd` on reply either. Verified cross-host: a reply that omitted `cwd` after a non-default-cwd start failed on the first retry and succeeded once `cwd` was repeated. Repeat the start call's `cwd` on every reply to be safe.

### Ollama through the Kimi bridge — local and cloud

Ollama is a **model server, not an agent**: it has no tool loop and no sessions, so it gets no bridge of its own — wrapping it would mean writing an agent, not adapting one. Instead it rides behind the Kimi bridge as an extra provider, which costs no code at all. The same provider reaches both locally-run weights and Ollama's hosted models, so one config block buys both. Add to `~/.kimi-code/config.toml` without touching `default_model`:

```toml
[providers.ollama-local]
base_url = "http://127.0.0.1:11434/v1"
type = "openai"
api_key = "ollama"

[models."ollama-local/ornith-9b"]
provider = "ollama-local"
model = "ornith:9b"
max_context_size = 32768
capabilities = [ "tool_use" ]
```

Then delegate normally and pass `model: "ollama-local/ornith-9b"`. Verify with `kimi provider list`. `type` must be one of `anthropic`, `azure`, `bedrock`, `google`, `kimi`, `openai`; Ollama speaks the OpenAI shape on `/v1`.

**Sizing.** Two consumers share the card: weights and the KV cache. At `Q4_K_M` weights run about 0.55 GB per billion parameters, and the KV cache costs roughly 0.13 GB per 1k tokens of context for a 9B model — so context, not weights, is usually what runs you out of memory. On a 12 GB card (about 10.6 GB usable once the desktop takes its share) a 9B model at 32k context fits with room to spare, a 14B only at 8–16k, and anything above 20B not at all. Setting `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves the context cost and is what makes 32k comfortable.

Worth setting on the Ollama service: `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_CONTEXT_LENGTH=32768`, and `OLLAMA_KEEP_ALIVE=30m` — the default 5-minute keep-alive evicts the model between delegations and each reload costs about a minute of disk-to-VRAM transfer.

**Capability, honestly.** Verified on `ornith:9b` (5.6 GB, tools, RTX 3060): correct tool selection with correct arguments, correct use of the returned tool result, the requested output format respected, no files touched under an advisory instruction, and about 49 tok/s steady state using 5.9 GB of VRAM at 32k. On a planted-vulnerability review it found four of six issues including every critical one — but it also misread GET as POST, left its own mid-answer self-correction in the text, garbled the exploitation mechanism it had correctly identified, and proposed a fix with an inverted condition that would have broken the code it was reviewing.

Treat local models as **advisory only**. They are a genuine first pass when the work will be read before it is used, and the obvious choice when code must not leave the machine. Do not give them implementation mode: the failure that matters is not slowness, it is a plausible-looking wrong edit applied without anyone reading it.

**Cloud models through the same provider.** Ollama also serves hosted models, addressed by appending `:cloud` to the name (`deepseek-v4-pro:cloud`). They need `ollama signin`, consume no VRAM, and reach the delegator through an identical `[providers.*]` block — only the model entries differ. Declare `max_output_size` explicitly on every cloud entry: the bridge derives `max_tokens` from `max_context_size`, and a million-token context produces a request the backend rejects with `max_tokens exceeds model's maximum output tokens` before any work happens.

Access is tiered, and the tiers do not follow model size. `gpt-oss:20b`/`:120b`, `gemma4:31b`, `nemotron-3-nano` and `minimax-m3` answer on a free account; a Pro plan adds `deepseek-v4-pro`, `glm-5.1`/`5.2`, `qwen3.5:397b`, `mistral-large-3:675b`, `minimax-m2.7`, `nemotron-3-super`/`-ultra` and `kimi-k2.6`/`k2.7-code`. `kimi-k3` sits outside the plan allowance entirely and bills against separately purchased "extra usage" — and since Copilot carries the same model inside its flat subscription, route K3 through Copilot rather than here unless there is a reason not to.

**How the tiers actually compare.** On one planted-vulnerability review, identical prompt and file: the local 9B found four of six issues and proposed one fix with an inverted condition; a local 8B found three and missed plaintext password storage; `deepseek-v4-pro:cloud` found all six, added a rate-limiting issue nobody planted, mapped each to an OWASP category, and made no errors. Local weights are for the case where code must not leave the machine. When that is not the constraint, a hosted model on the same bridge is better work at no marginal cost.

### Claude through the Kimi bridge — Anthropic direct

The same bridge reaches Anthropic's own API as another `[providers.*]` entry, so a host that already runs kimi can route to real Claude without a separate Claude installation. `type = "anthropic"` is one of kimi's built-in provider types, so this costs no code at all — only a config block. Verified end-to-end through the MCP bridge on four hosts (macOS, Windows, WSL, Linux): a start/reply canary returned a genuine Claude self-identification on a stable `threadId`, not a false-success from the bridge.

```toml
[providers.anthropic-via-kimi]
base_url = "https://api.anthropic.com"
type = "anthropic"
api_key = "<ANTHROPIC_API_KEY>"

[models."anthropic-via-kimi/claude-haiku-4-5"]
provider = "anthropic-via-kimi"
model = "claude-haiku-4-5-20251001"
max_context_size = 200000
capabilities = [ "tool_use" ]
```

Leave `default_model` untouched (still `moonshot-ai/kimi-k3`). The key lives in the provider block, which kimi reads from config on every invocation — the bridge spawns `kimi -p` per call and re-reads `config.toml` each time, so a new provider is picked up without restarting the bridge. Delegate normally and pass `model: "anthropic-via-kimi/claude-haiku-4-5"`.

Three things are easy to get wrong, each measured:

- **`base_url` has no `/v1`.** kimi's `type = "anthropic"` provider appends `/v1/messages` itself, following the Anthropic SDK convention. Writing `https://api.anthropic.com/v1` would double the prefix and the call would not land. This is the opposite of the Ollama entries above, whose `type = "openai"` expects `/v1` already in `base_url`.
- **`max_output_size` is not needed for the anthropic provider.** The Ollama-cloud footgun — where the bridge derives `max_tokens` from `max_context_size` and a million-token context produces a request the backend rejects with `max_tokens exceeds model's maximum output tokens` — does **not** apply to `type = "anthropic"`. The recipe above has no `max_output_size` and ran identically to one that set it. Do not transfer the Ollama-cloud conclusion here; the anthropic recipe is the simpler of the two.
- **Config wins over environment.** A provider block's `base_url` and `api_key` override `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from the environment. Measured on a WSL host whose `ANTHROPIC_BASE_URL` points at a local non-Anthropic proxy: with the proxy set in the env and the real endpoint in the config block, kimi connected to `api.anthropic.com` and ignored the env. So the recipe works on hosts with a conflicting `ANTHROPIC_BASE_URL` (a corporate proxy, a local glm shim) without unsetting anything — and the bridge, which forwards the caller's env through `buildCalleeEnv`, is safe to use here for the same reason. The env vars are a fallback for providers that do not name their own, not an override.

**Cleanup.** A key generated for a verification burn (the 3-hour, $5 throwaway used to measure this) should be removed from `config.toml` afterward — do not leave a credential at rest in a config file once the test is over. `kimi provider list` confirms the provider is gone.

## Grok Parameters Reference

### `mcp__plugin_claude-delegator_grok__grok` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`), prepended to the prompt |
| `sandbox` | `read-only`, `workspace-write` | `read-only` is **enforced**, not advisory — see **Sandbox honesty** below. Default: `workspace-write` |
| `model` | `grok-4.6` | Hard allowlist from `config/model-catalog.json`. This account sees one model |
| `effort` | free-form string | Passed through as `--reasoning-effort`. The CLI does not enumerate its values, so the bridge forwards the string rather than inventing an allowlist |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `cwd` | path | Working directory. **Project instruction files here are auto-loaded** |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

**Sandbox honesty**: Grok's `read-only` denies rather than advises because of the explicit deny rules, not the permission mode. (Copilot also enforces its narrower `read-only` contract through its own shell/write/edit deny flags.) `--permission-mode plan` on its own cancelled both a write attempt and a shell escape under an insistent prompt, then was **defeated** by a permissive allow list in the caller's own Claude Code settings, which grok reads. The bridge therefore always adds `--deny` for `Write`, `Edit` and `Bash`; with those, the model tried the file tool, the shell and a third path, was denied each time, and said so. `--sandbox read-only` is never emitted: the CLI accepts it and it did **not** stop a write. Real sandbox profiles live in `~/.grok/sandbox.toml` and are operator configuration the bridge never writes.

That guarantee is limited to Grok's built-in Write/Edit/Bash tools. It is not an OS sandbox and does not deny writes exposed by an MCP server; reachable MCP tools remain operator-controlled surface.

That inherited-permission coupling is also why the denials are not optional: it loads rules only when the caller's settings contain `allow`/`deny`/`ask` entries, measured as 7 rules on WSL, 1 on macOS and 0 on Linux and Windows. Without our own denials the same argv would grant different permissions on different machines.

**Verification status**: verified with live positive controls on WSL, macOS, Linux, and Windows. Under a permissive allow list in the caller's own Claude Code settings (6 rules loaded, checked against a 0-rule control): `bypassPermissions` wrote the file, proving the condition non-empty; `--permission-mode plan` **alone** wrote it too, so the mode by itself is defeated by what the caller has granted; `plan` plus the deny rules refused an insistent prompt, and also refused an **adversarial** prompt asserting the mode label was a display artifact and demanding real tool calls — the same prompt that defeated cursor-agent's `--mode ask`. The model attempted both tools and the permission layer refused them (`Denied by permission policy: deny rule on edit` / `... on bash`).

The deny rules often make refusal **legible** as well: observed runs with them usually ended `end_turn` and reported each tool error, while a run without them ended `stopReason: cancelled` with a truncated answer. Treat that as a tendency, not a contract; `cancelled` also occurred once with the deny rules.

All four hosts returned identical verbatim denial strings; several runs put control and test in the same directory, so the written control file sat beside the absent target. Reproduction took all day because a shared free-tier limit blocked it; a SuperGrok subscription lifts it per account, but propagation lags per host — a CLI that has not re-authenticated returns "no file" for **every** case including the control, which is precisely the result that looks like success. Check a positive control before reading any refusal as enforcement.

**Workspace context**: project instruction files in `cwd` are auto-loaded with no known off switch — `CLAUDE.md` was measured loading on Linux, macOS, WSL and Windows, and a planted `AGENTS.md` loaded too. Delegating grok into this repository injects its own `CLAUDE.md`. This is the same prompt-injection surface as Kimi's, so prefer another provider when delegating into code you do not control. `--no-memory` disables cross-session memory, not project instructions.

**Model guidance**: `grok-4.6` is the only model this account advertises, and `grok models` lists the roster headlessly, so a refresh needs no PTY. A free account has a usage limit that returns a JSON error object rather than a non-zero exit — budget for it on long runs.

### `mcp__plugin_claude-delegator_grok__grok-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** `sessionId` from the previous `grok` call. The bridge fails loudly if grok resumes a different session |
| `prompt` | string | **Required.** Follow-up instruction |
| `sandbox` | `read-only`, `workspace-write` | Repeat the original value; a resume inherits no permission state |
| `effort` | free-form string | Optional override for this turn |
| `cwd` | path | Working directory |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

Unlike `agy-reply`, no `model` is required: a resumed grok session keeps its model. The bridge never passes `--continue`/`-c`, which resumes "the most recent session for the current working directory" and would cross-talk between concurrent delegations sharing a `cwd`.

## Cursor Parameters Reference

### `mcp__plugin_claude-delegator_cursor__cursor` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`), prepended to the prompt |
| `sandbox` | `read-only`, `workspace-write` | `workspace-write` passes `--force`; `read-only` passes `--mode ask`. Default: `workspace-write`. See **Sandbox honesty** below. |
| `model` | free-form string | Default: `auto`. Not an enum — see **Model guidance** |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `cwd` | path | Working directory; it also becomes the workspace |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

**Model guidance**: the roster is free-form for the same reason as Kimi's, but a different one in detail — the CLI documents bracket-parameterised overrides such as `claude-opus-4-8[context=1m,effort=high,fast=false]`, which no allowlist can express. There is **no effort parameter**: the reasoning tier is baked into most ids (`-low`, `-high`, `-xhigh`, plus `-fast` variants), exactly as on Agy.

Be careful reading `cursor-agent models`: it printed **204 ids** on the verification account, and only three of them ran. Every named third-party model failed with `Named models unavailable. Free plans can only use Auto.` before any work happened, leaving `auto`, `composer-2.5` and `composer-2.5-fast`. A paid plan should reach more; the catalog records what completed a live call, not what the CLI listed.

`auto` is **server-routed and not stable**. It resolved to `cursor-grok-4.6-high-fast` on one turn and `cursor-grok-4.6-high` on the next turn of the *same* session — so the plan restricts *choosing* a model, not *using* one. Pick a Composer id when a run has to be reproducible.

**Sandbox honesty**: `read-only` **deflects, it does not deny.** `--mode ask` refused an insistent write-or-shell prompt twice, including under a permissive allow list — and was then defeated by a prompt asserting the mode label was a display artefact and demanding real tool calls. Both the write and the shell command went through, and the model's own report read "the Ask mode label did not block either call". This is Agy's category, not Grok's: the value is kept because it is strictly more restrictive than the alternative, and it is documented for exactly what it is. Carry advisory intent in `developer-instructions` too.

`--mode plan` is never emitted despite promising "no edits" in its own help: with workspace trust granted it wrote the file on the first insistent prompt. `--sandbox` is never emitted either — it is accepted and did not stop a workspace write. There are no command-line deny rules, so the trick that makes Grok's `read-only` enforce is unavailable here; **route to Claude or Copilot for provider-enforced denial, to Grok for denial of its built-in write/shell tools, or to a native Codex registration explicitly configured read-only.**

**Workspace trust**: the bridge always passes `--trust`, and this is load-bearing. Without it a headless run prints `Workspace Trust Required` and exits **0** having executed nothing — indistinguishable from a permission mode successfully denying the task. That false negative already cost one measurement here.

**macOS keychain**: on macOS the bridge can fail to start at all, with a message that names the wrong cause. `cursor-agent --version` touches the login keychain, and the bridge runs exactly that to validate the CLI at startup. With the keychain locked — after a reboot before the first unlock, over SSH, or in any headless context — the touch fails, validation throws, and the bridge exits before serving, surfacing as `CONNECTION_CLOSED` with a "Cursor Agent CLI not found" message that points at the CLI rather than the keychain. Unlocking the login keychain once clears it; this is a platform property, not a regression (it blocked 1.8.0 too). Linux and Windows touch no keychain, so the bridge starts there without it.

**Output and failure**: `--output-format json` emits one single-line object (`result`, `session_id`, `is_error`). The **exit code does not classify the run** — a transient backend failure returned code 0 with plain-text "Connection lost, reconnecting…" and no JSON, while a rejected model returned code 1, also without JSON. The bridge parses stdout first and uses the code only to pick a message, the same rule as Agy.

**Context**: `--add-dir` is never passed, for the Agy reason — `cwd` alone grants file access, while `--add-dir` widens rules discovery.

### `mcp__plugin_claude-delegator_cursor__cursor-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** `session_id` from the previous `cursor` call. The bridge fails loudly if cursor resumes a different session. |
| `prompt` | string | **Required.** Follow-up instruction |
| `sandbox` | `read-only`, `workspace-write` | Repeat the original value |
| `cwd` | path | **Use the same workspace path as the start call** |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

**No `model` on reply**, and this is the opposite of Agy: a Cursor resume **inherits** the model the session started with. Verified by starting on `auto` while the configured default was `composer-2.5-fast` and finding no fallback. `--continue` is never emitted — it resumes the previous session for the working directory and would cross-talk between concurrent delegations sharing a `cwd`, as on Kimi.


## Copilot Parameters Reference

### `mcp__plugin_claude-delegator_copilot__copilot` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write` | `read-only` denies shell/write/edit; `workspace-write` uses `--allow-all-tools`. Default: `workspace-write`. |
| `model` | One of the 27 entries under `providers.copilot.models` in `config/model-catalog.json` | Override the default model (hard allowlist mirrored from Copilot CLI 1.0.80) |
| `effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Reasoning effort level. Default: `max`; verified per-model floors and ceilings are applied server-side |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min); raise it for long implementation runs |
| `cwd` | path | Working directory for the task |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

**Model guidance**: `gpt-5.6-sol` (default) at `max` effort for expert work; its backend rejects `minimal`, while `low` and `max` completed live calls, so the bridge floors both `none` and `minimal` to `low`. `gpt-5.6-terra` is suitable for everyday tasks; use `gpt-5.6-luna` or `gpt-5.3-codex` for fast low-stakes checks, `claude-sonnet-5` for a cross-family second opinion, and `gpt-5.5`/`gpt-5.4` as fallbacks when 5.6 quota runs dry (Codex already runs `gpt-5.6-sol` natively at `ultra`). Use Gemini models only when the Agy MCP server is unavailable (it covers them natively).

## Claude Parameters Reference (external orchestrators)

The Claude bridge wraps Claude Code 2.1.234 with the same start/reply contract used by the other providers.

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** Full delegation prompt, including optional coordination envelope |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `model` | `opus`, `fable`, `sonnet`, `haiku`, or their full IDs | Override the default `claude-opus-5` model |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | Default: `xhigh` |
| `sandbox` | `read-only`, `workspace-write` | `read-only` maps to `plan`; `workspace-write` bypasses permission prompts. Default: `workspace-write`. |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min); raise it for long implementation runs |
| `cwd` | path | Working directory for the task |

### `mcp__claude__claude-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Session ID from the previous `claude` call |
| `prompt` | string | **Required.** Follow-up instruction |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | Optional; omit to avoid overriding the resumed session |
| `sandbox` | `read-only`, `workspace-write` | Repeat the original value for permission continuity |
| `cwd` | path | Working directory for the task |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |

Do not add this target to Claude Code's own MCP configuration; that would create a self-delegation path.

### `mcp__plugin_claude-delegator_copilot__copilot-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID (session ID) from previous `copilot` call |
| `prompt` | string | **Required.** Follow-up instruction |
| `effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Optional. Omit to keep the resumed session's effort; per-model backend support varies |
| `sandbox` | `read-only`, `workspace-write` | Repeat the original value; otherwise the reply defaults to `workspace-write` |
| `cwd` | path | Working directory for the task |
| `timeout` | 10000–3600000 ms | Hard kill deadline. Default: 900000 (15 min) |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |


### Response Format (all providers)

| Field | Type | Description |
|-------|------|-------------|
| MCP result `content` | content-block array | The visible tool response; its first text block carries the bridge envelope |
| Envelope `threadId` | string | Session ID for multi-turn follow-ups |
| Envelope `content` | string | Expert response text inside the JSON envelope |

Native Codex may additionally expose `structuredContent.content`; do not depend on
that sibling field because MCP clients can strip it before the orchestrator sees it.

The six custom bridges (Claude, Agy, Kimi, Grok, Cursor, and Copilot) put a JSON envelope `{"threadId": "...", "content": "..."}` in `content[0].text`, mirroring native Codex output. MCP clients strip sibling result fields before the model sees them, so the text envelope is the only way the orchestrator learns the `threadId` needed for `*-reply` calls — parse it from the text rather than expecting a separate field.

## When NOT to Delegate

- Simple questions you can answer
- First attempt at any fix
- Trivial decisions
- Research tasks (use other tools)
- When user just wants quick info
