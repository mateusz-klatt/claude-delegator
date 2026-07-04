# Model Selection Guidelines

GPT (Codex), Copilot (GPT/Claude), and Gemini experts serve as specialized consultants for complex problems.

## Provider Selection

Before delegating, check which MCP tools are available in the current environment:

1. **If multiple are available**:
   - Use **Gemini** for tasks requiring large context or multimodal analysis.
   - Use **GPT (Codex)** for tasks where the user explicitly asked for "GPT" or "Codex".
   - Use **Copilot** for tasks where the user explicitly asked for "Copilot".
   - Default to **Gemini** for general reasoning.
2. **If only one is available**: Use the available provider regardless of the task type.
3. **If none are available**: Do not delegate; inform the user that they need to run `/claude-delegator:setup`.

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

| Mode | Sandbox | Approval | Use When |
|------|---------|----------|----------|
| **Advisory** | `danger-full-access` | `never` | Analysis, recommendations, reviews |
| **Implementation** | `danger-full-access` | `never` | Making changes, fixing issues |

**Key principle**: The mode is determined by the task, not the expert. The advisory-vs-implementation intent is carried by `developer-instructions` (e.g., "Do not modify code" for advisory; "Make the change and verify" for implementation), NOT by the sandbox parameter.

**Why both modes use `danger-full-access` + `never`**: Operator-level user preference. On hosts where `bwrap` sandboxing helper is broken (loopback / RTM_NEWADDR errors), the `read-only` and `workspace-write` sandbox modes silently escalate to permission-prompt fallback. `approval-policy=never` only auto-DECLINES the prompt; it doesn't grant the sandbox more room — so the expert can't read repo files and gives degraded "best guess from the inlined prompt" responses. Using `danger-full-access` bypasses bwrap entirely and gives the expert reliable shell access. Set globally in `~/.codex/config.toml`:

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

Per-call values still override the global. For advisory consults, prefer leaving them blank (inheriting global) and let the `developer-instructions` carry the "do not modify" intent.

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
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Controls file access. Default from `~/.codex/config.toml` |
| `approval-policy` | `untrusted`, `on-failure`, `on-request`, `never` | Controls shell command approval. Default from config |
| `model` | e.g. `gpt-5.5` | Override the default model |
| `config` | key-value object | Override `config.toml` settings per-call |
| `cwd` | path | Working directory for the task |
| `base-instructions` | string | Override default system instructions |
| `compact-prompt` | string | Prompt used when compacting conversation |
| `profile` | string | Configuration profile from config.toml |

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
| `sandbox` | `read-only`, `workspace-write` | Controls file access. |
| `model` | e.g. `gemini-3.1-pro-preview` | Override the default model (free-form string, any model the Gemini CLI accepts) |
| `cwd` | path | Working directory for the task |

**Model guidance**: The default `gemini-3.1-pro-preview` is the right choice for expert work (architecture, security, plan review). Pass `model: "gemini-3.5-flash"` for quick, low-stakes checks where speed matters more than depth.

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
| `sandbox` | `read-only`, `workspace-write` | Controls file access. |
| `model` | one of: `gpt-5.4` (default), `gpt-5.5`, `gpt-5.3-codex`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `claude-sonnet-5` | Override the default model (hard allowlist — other values are rejected) |
| `effort` | `low`, `medium`, `high`, `xhigh` | Reasoning effort level. Default: `xhigh` |
| `cwd` | path | Working directory for the task |

**Model guidance**: `gpt-5.4` (default) for everyday expert work; `gpt-5.3-codex` for fast code-focused tasks; `claude-sonnet-5` for a cross-family second opinion; `gpt-5.5` only when Codex is unavailable (Codex already runs `gpt-5.5` natively); Gemini models only when the Gemini MCP server is unavailable (it covers them natively).

### `mcp__copilot__copilot-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID (session ID) from previous `copilot` call |
| `prompt` | string | **Required.** Follow-up instruction |
| `effort` | `low`, `medium`, `high`, `xhigh` | Optional. Omit to keep the resumed session's effort; pass a value only to change it |


### Response Format (all providers)

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | string | Session ID for multi-turn follow-ups |
| `content` | string | The expert's text response |

## When NOT to Delegate

- Simple questions you can answer
- First attempt at any fix
- Trivial decisions
- Research tasks (use other tools)
- When user just wants quick info
