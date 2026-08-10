# Model Selection Guidelines

Claude, GPT (Codex), Copilot, and Gemini experts serve as specialized consultants for complex problems.

## Provider Selection

Before delegating, check which MCP tools are available in the current environment:

1. **If multiple are available**:
   - Use **Claude** when the user explicitly asks for Claude. Do not register Claude as a target inside Claude Code itself.
   - Use **Gemini** for tasks requiring large context or multimodal analysis.
   - Use **GPT (Codex)** for tasks where the user explicitly asked for "GPT" or "Codex".
   - Use **Copilot** for tasks where the user explicitly asked for "Copilot".
   - Default to **Gemini** for general reasoning.
2. **If only one is available**: Use the available provider regardless of the task type.
3. **If none are available**: Do not delegate. In Claude Code, suggest `/claude-delegator:setup`; in another MCP client, point to `config/codex-mcp.example.toml` or that client's MCP configuration.

For the account-specific roster discovered on 2026-08-10, use `config/model-catalog.json` as the source of truth. The catalog records selector/cache/registry/help discovery separately from combinations that completed a live call; backend access still depends on the active account.

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

The mode is determined by the task, not the expert, and must always be stated in `developer-instructions`. The three custom bridges expose only `read-only` and `workspace-write`; unattended delegation defaults to `workspace-write`, which deliberately maps to each provider's non-interactive full-tool mode. Advisory calls use the same default while carrying an explicit "do not modify" instruction. Use `read-only` only when the caller explicitly wants provider-enforced write denial and accepts that unavailable operations will be refused. Native Codex retains its own setting name, `danger-full-access`, with `approval_policy = "never"`. These are provider permission policies, not a portable OS-level sandbox.

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

### `mcp__codex__codex` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Controls file access. The distributed launcher starts the server with `danger-full-access` |
| `approval-policy` | `untrusted`, `on-request`, `never` | Controls shell command approval. The distributed launcher starts the server with `never` |
| `model` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` | Models visible to this Codex account at verification time |
| `config` | key-value object | Override `config.toml` settings per-call |
| `cwd` | path | Working directory for the task |
| `base-instructions` | string | Override default system instructions |
| `compact-prompt` | string | Prompt used when compacting conversation |

### `mcp__codex__codex-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `codex` call |
| `prompt` | string | **Required.** Follow-up instruction |

## Gemini Parameters Reference

### `mcp__gemini__gemini` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write` | `read-only` maps to `plan`; `workspace-write` maps to non-interactive `yolo`. Default: `workspace-write`. |
| `model` | e.g. `gemini-3.1-pro-preview` | Override the default model (free-form string, any model the Gemini CLI accepts) |
| `cwd` | path | Working directory for the task |

**Model guidance**: The default `gemini-3.1-pro-preview` is the right choice for expert work (architecture, security, plan review). Pass `model: "gemini-3.5-flash"` for quick, low-stakes checks where speed matters more than depth.

The locally discovered registry also includes `auto`, `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemma-4-31b-it`, and `gemma-4-26b-a4b-it`. Gemini keeps `--model` free-form; catalog presence is not a guarantee of backend entitlement.

### `mcp__gemini__gemini-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `gemini` call |
| `prompt` | string | **Required.** Follow-up instruction |

## Copilot Parameters Reference

### `mcp__copilot__copilot` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write` | `read-only` denies shell/write/edit; `workspace-write` uses `--allow-all-tools`. Default: `workspace-write`. |
| `model` | One of the 25 entries under `providers.copilot.models` in `config/model-catalog.json` | Override the default model (hard allowlist mirrored from Copilot CLI 1.0.78) |
| `effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Reasoning effort level. Default: `max` (`max` is verified on `gpt-5.6-sol` only; other models are capped to `xhigh` server-side) |
| `cwd` | path | Working directory for the task |

**Model guidance**: `gpt-5.6-sol` (default) at `max` effort for expert work; `gpt-5.6-terra` for everyday tasks; `gpt-5.6-luna` or `gpt-5.3-codex` for fast low-stakes checks; `claude-sonnet-5` for a cross-family second opinion; `gpt-5.5`/`gpt-5.4` as fallbacks when 5.6 quota runs dry (Codex already runs `gpt-5.6-sol` natively at `ultra`); Gemini models only when the Gemini MCP server is unavailable (it covers them natively).

## Claude Parameters Reference (external orchestrators)

The Claude bridge wraps Claude Code 2.1.226 with the same start/reply contract used by the other providers.

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** Full delegation prompt, including optional coordination envelope |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `model` | `opus`, `fable`, `sonnet`, `haiku`, or their full IDs | Override the default `claude-opus-5` model |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | Default: `xhigh` |
| `sandbox` | `read-only`, `workspace-write` | `read-only` maps to `plan`; `workspace-write` bypasses permission prompts. Default: `workspace-write`. |
| `coordination` | object | Optional Agent Mail caller envelope; never include credentials |
| `cwd` | path | Working directory for the task |

### `mcp__claude__claude-reply` (Continue Session)

Pass the `threadId` returned by `claude` plus the follow-up `prompt`. The reply may also carry an updated `coordination` envelope. Repeat `sandbox` when permission continuity matters; omit `effort` to avoid overriding the resumed session.

Do not add this target to Claude Code's own MCP configuration; that would create a self-delegation path.

### `mcp__copilot__copilot-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID (session ID) from previous `copilot` call |
| `prompt` | string | **Required.** Follow-up instruction |
| `effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Optional. Omit to keep the resumed session's effort; per-model backend support varies |


### Response Format (all providers)

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | string | Session ID for multi-turn follow-ups |
| `content` | MCP content array | Text is normally in `content[0].text`; native Codex also returns `structuredContent.content` |

## When NOT to Delegate

- Simple questions you can answer
- First attempt at any fix
- Trivial decisions
- Research tasks (use other tools)
- When user just wants quick info
