# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A multi-provider MCP delegator. Claude Code can route to Codex, Agy (Google Antigravity), Kimi (Moonshot), or Copilot, while Codex and other MCP clients can also route to Claude through a symmetric `claude` / `claude-reply` bridge. Five domain experts can advise OR implement: Architect, Plan Reviewer, Scope Analyst, Code Reviewer, and Security Analyst.

## Development Commands

```bash
# Test plugin locally (loads from working directory)
claude --plugin-dir /path/to/claude-delegator

# Run setup to test installation flow
/claude-delegator:setup

# Run uninstall to test removal flow
/claude-delegator:uninstall

# Run the automated bridge tests
npm test
npm run test:coverage
```

No build step and no runtime dependencies. Codex supplies its native MCP server through a transparent environment-boundary launcher; zero-dependency bridges adapt Claude, Agy, Kimi, and Copilot CLIs to the same start/reply contract. Tests use Node's built-in test runner.

## Architecture

### Orchestration Flow

Claude acts as orchestrator—delegates to specialized experts based on task type. Supports both **single-shot** (independent calls) and **multi-turn** (context preserved via `threadId`).

```
User Request → Claude Code → [Match trigger → Select expert & provider]
                                    ↓
              ┌─────────────────────┼─────────────────────┐
              ↓                     ↓                     ↓
         Architect            Code Reviewer        Security Analyst
              ↓                     ↓                     ↓
    [Advisory (do-not-modify instruction) OR Implementation; bridges default workspace-write]
              ↓                     ↓                     ↓
    Claude synthesizes response ←──┴──────────────────────┘
```

### How Delegation Works

1. **Match trigger** - Check `rules/triggers.md` for semantic patterns
2. **Read expert prompt** - Load from `prompts/[expert].md`
3. **Build 7-section prompt** - Use format from `rules/delegation-format.md`
4. **Call provider tool** - `mcp__claude__claude`, `mcp__codex__codex`, `mcp__agy__agy`, `mcp__kimi__kimi`, or `mcp__copilot__copilot`
5. **Synthesize response** - Never show raw output; interpret and verify

### The 7-Section Delegation Format

Every delegation prompt must include: TASK, EXPECTED OUTCOME, CONTEXT, CONSTRAINTS, MUST DO, MUST NOT DO, OUTPUT FORMAT. See `rules/delegation-format.md` for templates.

### Retry Handling

Retries use multi-turn (`*-reply` with `threadId`) so the expert remembers previous attempts:
- Attempt 1 fails → retry with error details (context preserved)
- Up to 3 attempts → then escalate to user
- Fallback: new call with full history if multi-turn unavailable

### Component Relationships

| Component | Purpose | Notes |
|-----------|---------|-------|
| `rules/*.md` | When/how to delegate | Installed to `~/.claude/rules/delegator/` |
| `prompts/*.md` | Expert personalities | Injected via `developer-instructions` |
| `prompts/agent-mail-coordination.md` | Optional progress-reporting contract | Injected only with a complete caller envelope |
| `commands/*.md` | Slash commands | `/setup`, `/uninstall` |
| `config/providers.json` | Provider metadata | Discovery/documentation metadata |
| `config/model-catalog.json` | Empirically discovered per-CLI model roster | Consumed by bridges and documentation |
| `server/claude/index.js` | Claude MCP bridge | Wraps Claude CLI as `claude` / `claude-reply` |
| `server/codex/launcher.js` | Transparent Codex launcher | Preserves native MCP/model handling while isolating env and supervising the process tree |
| `server/agy/index.js` | Agy MCP bridge | Wraps the Google Antigravity CLI as MCP server |
| `server/kimi/index.js` | Kimi MCP bridge | Wraps the Kimi Code CLI as MCP server |
| `server/copilot/index.js` | Copilot MCP bridge | Wraps Copilot CLI as MCP server |

> Expert prompts adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)

## Five Experts

| Expert | Prompt | Specialty | Triggers |
|--------|--------|-----------|----------|
| **Architect** | `prompts/architect.md` | System design, tradeoffs | "how should I structure", "tradeoffs of", design questions |
| **Plan Reviewer** | `prompts/plan-reviewer.md` | Plan validation | "review this plan", before significant work |
| **Scope Analyst** | `prompts/scope-analyst.md` | Requirements analysis | "clarify the scope", vague requirements |
| **Code Reviewer** | `prompts/code-reviewer.md` | Code quality, bugs | "review this code", "find issues" |
| **Security Analyst** | `prompts/security-analyst.md` | Vulnerabilities | "is this secure", "harden this" |

Every expert can operate in **advisory** or **implementation** mode. Delegated CLIs default to non-interactive full access so nested approval prompts cannot block the parent; advisory mode is carried by an explicit "do not modify" instruction. The custom bridges expose `workspace-write` as that default full-tool mode and retain `read-only` only as an explicit opt-in — except on Agy, where `read-only` denies shell but not writes, and Kimi, which refuses `read-only` altogether (decisions 11 and 12).

## Key Design Decisions

1. **Native & Bridge MCP** - Codex already exposes `codex` / `codex-reply` through `mcp-server`. Claude's native `mcp serve` exposes internal tools rather than the provider contract, so a thin bridge supplies `claude` / `claude-reply`; Agy, Kimi and Copilot use equivalent bridges.
2. **Single-shot + multi-turn** - Single-shot for advisory (full context per call), multi-turn via `threadId` for chained implementation and retries
3. **Dual mode** - Any expert can advise or implement based on task
4. **Synthesize, don't passthrough** - Claude interprets expert output, applies judgment
5. **Proactive triggers** - Claude checks for delegation triggers on every message
6. **Copilot effort levels** - Copilot supports `--effort` from `none` through `max`; delegation defaults to `max` only for `gpt-5.6-sol` and caps other models at `xhigh`
7. **Copilot disk persistence** - Unlike Codex (in-memory), Copilot persists session state to `~/.copilot/session-state/`, surviving process restarts
8. **Conditional Agent Mail progress** - Callers pass `{projectKey, callerAgentName, mailTopic?, checkpointIntervalSeconds?}` without credentials or caller-provided mail thread ids. The callee replies to its own first checkpoint so Agent Mail maintains the thread internally; the provider session `threadId` remains separate. A target uses MCP Agent Mail only when already available and otherwise completes normally.
9. **No Claude self-target** - Configure the Claude bridge in Codex or another external orchestrator, not in Claude Code itself. Native subagents already cover in-family fan-out, and a self-target adds no model diversity while drawing on the same Anthropic quota.
10. **Delegation-depth guard** - The Claude bridge stamps `CLAUDE_DELEGATOR_CLAUDE_DEPTH` into every child environment and refuses both tools when it is already set. Because the variable survives each further hop, this closes indirect loops too — a delegated Claude that calls Codex cannot have that Codex call back into another Claude. The guard is defence in depth, not a security boundary: under `workspace-write` the child can still invoke any CLI itself. The Agy bridge applies the same guard through `CLAUDE_DELEGATOR_AGY_DEPTH`.
11. **Agy replaces Gemini, with three deviations** - The Antigravity CLI covers Gemini, Claude and GPT-OSS models from one provider, so it supersedes the Gemini bridge removed in 1.5.0. Three seams do not fit the generic pattern, each verified against the live CLI rather than inferred:
    - **No enforced read-only.** `--mode plan` is a slash-command expansion, inert under the `--disable-slash-commands` the bridge must always pass, and even with slash commands enabled it let a write through under an insistent prompt. `read-only` omits `--dangerously-skip-permissions`, which soft-denies `run_command` only; `write_to_file`, `search_web` and `read_url_content` remain, and writes are not workspace-confined. The enum value is kept for cross-bridge uniformity and documented for exactly what it is.
    - **Reply must re-pin the model.** A resumed conversation inherits neither its model nor its workspace, so `agy-reply` requires `model` instead of defaulting it — omitting it silently falls back to the user's `settings.json` default. This deliberately inverts the house rule that a reply drops model-ish knobs.
    - **Success is not exit-code shaped.** A rejected model exits 1 with well-formed JSON and `status: "ERROR"`; an auto-denied tool exits 0 with `status: "SUCCESS"` and an empty response. The bridge parses stdout first and uses the exit code only to pick a message. `--effort` is never emitted because most model ids bake the reasoning tier into the name, and `--add-dir` is never passed because it is what switches on repo-supplied rules injection.
12. **Kimi has no permission tier and no context opt-out** - `kimi -p` rejects `--plan`, `--yolo` and `--auto` outright and runs tools unattended regardless, so the bridge **refuses** `sandbox: read-only` with -32602 rather than accept an inert value. A repository `AGENTS.md` in `cwd` is auto-loaded with no known off switch, which is a wider prompt-injection surface than Agy's; prefer another provider when delegating into code you do not control. Failures are exit-code shaped, unlike Agy's, and the model alias stays free-form because `kimi provider catalog` can extend the roster. That free-form alias is also how local models reach the delegator: Ollama is a model server rather than an agent, so it gets no bridge of its own and instead rides behind this one as an extra `[providers.*]` entry in `~/.kimi-code/config.toml`. Our bridges wrap agents, not models — see `rules/model-selection.md` for the recipe, the VRAM sizing arithmetic, and why local models are advisory-only. The same provider block also reaches Ollama's hosted models via a `:cloud` suffix, which cost no VRAM and, on a Pro plan, no marginal spend; `kimi-k3` is the exception, billed as metered extra usage and cheaper through Copilot.

## When NOT to Delegate

- Simple syntax questions (answer directly)
- First attempt at any fix (try yourself first)
- Trivial file operations
- Research/documentation tasks
