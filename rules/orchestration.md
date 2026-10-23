# Model Orchestration

You have access to Claude, GPT, Agy, Kimi, Grok, Cursor, and Copilot experts via MCP tools. Use them strategically based on these guidelines. The Claude target is for external orchestrators such as Codex; Claude Code must not target itself.

## Available Tools

| Tool | Provider | Use For |
|------|----------|---------|
| `mcp__claude__claude` | Claude | Start a new Claude expert session from an external orchestrator |
| `mcp__claude__claude-reply` | Claude | Continue an existing Claude session (multi-turn) |
| `mcp__plugin_claude-delegator_codex__codex` | GPT (Codex) | Start a new expert session |
| `mcp__plugin_claude-delegator_codex__codex-reply` | GPT (Codex) | Continue an existing session (multi-turn) |
| `mcp__plugin_claude-delegator_agy__agy` | Agy (Antigravity) | Start a new expert session |
| `mcp__plugin_claude-delegator_agy__agy-reply` | Agy (Antigravity) | Continue an existing session (multi-turn) |
| `mcp__plugin_claude-delegator_kimi__kimi` | Kimi (Moonshot) | Start a new expert session |
| `mcp__plugin_claude-delegator_kimi__kimi-reply` | Kimi (Moonshot) | Continue an existing session (multi-turn) |
| `mcp__plugin_claude-delegator_grok__grok` | Grok (xAI) | Start a new expert session; `read-only` adds built-in write/shell deny rules |
| `mcp__plugin_claude-delegator_grok__grok-reply` | Grok (xAI) | Continue an existing session (multi-turn) |
| `mcp__plugin_claude-delegator_cursor__cursor` | Cursor (Cursor Agent) | Start a new expert session |
| `mcp__plugin_claude-delegator_cursor__cursor-reply` | Cursor (Cursor Agent) | Continue an existing session (multi-turn) |
| `mcp__plugin_claude-delegator_copilot__copilot` | Copilot (GPT/Claude) | Start a new expert session; `read-only` denies shell/write/edit |
| `mcp__plugin_claude-delegator_copilot__copilot-reply` | Copilot (GPT/Claude) | Continue an existing session (multi-turn) |

**`mcp__claude__claude` is deliberately not in that form, and making the table look consistent would
break the one row that is currently right.** The six others carry the `plugin_claude-delegator_`
prefix because Claude Code namespaces manifest-declared servers that way — that is why the old
`mcp__<name>__<tool>` handles stopped resolving when registration moved into `plugin.json`, and the
environment reports them as no longer available rather than aliasing them. The Claude target is
never registered in Claude Code at all (decision 9), so it has no plugin namespace to take: measured,
`claude mcp list` shows six plugin-declared entries and no `claude`, while `server/claude/` still
ships. Its name belongs to whichever external orchestrator configures it, where `claude` is simply
the conventional server name.

## Available Experts

| Expert | Specialty | Prompt File |
|--------|-----------|-------------|
| **Architect** | System design, tradeoffs, complex debugging | `${CLAUDE_PLUGIN_ROOT}/prompts/architect.md` |
| **Plan Reviewer** | Plan validation before execution | `${CLAUDE_PLUGIN_ROOT}/prompts/plan-reviewer.md` |
| **Scope Analyst** | Pre-planning, catching ambiguities | `${CLAUDE_PLUGIN_ROOT}/prompts/scope-analyst.md` |
| **Code Reviewer** | Code quality, bugs, security issues | `${CLAUDE_PLUGIN_ROOT}/prompts/code-reviewer.md` |
| **Security Analyst** | Vulnerabilities, threat modeling | `${CLAUDE_PLUGIN_ROOT}/prompts/security-analyst.md` |

---

## Session Management

Every provider target supports both single-shot and multi-turn delegation.

### Single-Shot (Default)

Use `mcp__claude__claude`, `mcp__plugin_claude-delegator_codex__codex`, `mcp__plugin_claude-delegator_agy__agy`, `mcp__plugin_claude-delegator_kimi__kimi`, `mcp__plugin_claude-delegator_grok__grok`, `mcp__plugin_claude-delegator_cursor__cursor`, or `mcp__plugin_claude-delegator_copilot__copilot` for independent tasks. Each call starts a fresh session with no memory of previous calls. Include ALL relevant context in the delegation prompt.

**Best for:** Advisory reviews, one-off analysis, independent implementation tasks.

### Multi-Turn

Every target returns a `threadId` from the initial call in the same shape: all
seven bridges (Codex, Claude, Agy, Kimi, Grok, Cursor, and Copilot) put a JSON
envelope in `content[0].text`. Pass the id to the corresponding `-reply` tool
for follow-up turns with full context preservation.

```typescript
// Bridge extraction (the same shape for all seven providers)
const threadId = JSON.parse(result.content[0].text).threadId
```

```typescript
// Turn 1: Start session (Codex example)
const result = mcp__plugin_claude-delegator_codex__codex({
  prompt: "Implement input validation for the user endpoint",
  "developer-instructions": "[expert prompt]",
  cwd: "/path/to/project"
})
const threadId = JSON.parse(result.content[0].text).threadId

// Turn 2: Follow up with context preserved. A Codex resume inherits neither
// model nor workspace, so repeat cwd (and any non-default model or effort).
mcp__plugin_claude-delegator_codex__codex-reply({
  threadId,
  prompt: "Now add tests for the validation you just implemented",
  cwd: "/path/to/project"
})
```

**Best for:** Chained implementation steps, iterative refinement, retry after failure.

| Pattern | Tool | Context | Use When |
|---------|------|---------|----------|
| Single-shot | `claude` / `codex` / `agy` / `kimi` / `grok` / `cursor` / `copilot` | Fresh each call | Advisory, one-off tasks |
| Multi-turn | `*-reply` | Preserved via threadId | Chained steps, retries |

---

## PROACTIVE Delegation (Check on EVERY message)

Before handling any request, check if an expert would help:

| Signal | Expert |
|--------|--------|
| Architecture/design decision | Architect |
| 2+ failed fix attempts on same issue | Architect (fresh perspective) |
| "Review this plan", "validate approach" | Plan Reviewer |
| Vague/ambiguous requirements | Scope Analyst |
| "Review this code", "find issues" | Code Reviewer |
| Security concerns, "is this secure" | Security Analyst |

**If a signal matches → delegate to the appropriate expert.**

---

## REACTIVE Delegation (Explicit User Request)

When user explicitly requests a specific provider:

| User Says | Action |
|-----------|--------|
| "ask Claude", "consult Claude" | From a non-Claude orchestrator, identify task type → route to the appropriate expert prompt |
| "ask GPT", "consult GPT", "ask codex" | Identify task type → route to appropriate expert |
| "ask Agy", "consult Agy", "ask agy" | Identify task type → route to appropriate expert |
| "ask Kimi", "consult Kimi", "ask kimi" | Identify task type → route to appropriate expert |
| "ask Grok", "consult Grok", "ask grok" | Identify task type → route to appropriate expert |
| "ask Cursor", "consult Cursor", "ask cursor" | Identify task type → route to appropriate expert |
| "ask Copilot", "consult Copilot", "ask copilot" | Identify task type → route to appropriate expert |
| "ask GPT to review the architecture" | Delegate to Architect |
| "have Agy review this code" | Delegate to Code Reviewer |
| "have Copilot review this code" | Delegate to Code Reviewer |
| "GPT security review" | Delegate to Security Analyst |

**Always honor explicit requests.**

---

## Delegation Flow (Step-by-Step)

When delegation is triggered:

### Step 1: Identify Expert
Match the task to the appropriate expert based on triggers.

### Step 2: Read Expert Prompt
**CRITICAL**: Read the expert's prompt file to get their system instructions:

```
Read ${CLAUDE_PLUGIN_ROOT}/prompts/[expert].md
```

For example, for Architect: `Read ${CLAUDE_PLUGIN_ROOT}/prompts/architect.md`

For the Codex, Claude, Agy, Kimi, Grok, Cursor, and Copilot bridges, do not manually inject the Agent Mail prompt: passing a complete `coordination` object makes the bridge append the canonical `${CLAUDE_PLUGIN_ROOT}/prompts/agent-mail-coordination.md` contract.

### Step 3: Determine Mode
| Provider | Advisory | Implementation |
|----------|----------|----------------|
| Codex bridge | Default `workspace-write` (`danger-full-access` + approval `never`); state "do not modify". `read-only` is Codex's own sandbox, enforced by the OS | Default `workspace-write` |
| Claude bridge | Default `workspace-write` (permission bypass); state "do not modify" | Default `workspace-write` |
| Agy bridge | Default `workspace-write` (`--dangerously-skip-permissions`); state "do not modify". `read-only` soft-denies shell only; file writes and network remain available | Default `workspace-write` |
| Kimi bridge | `workspace-write` only; state "do not modify". `read-only` is refused — print mode has no permission tier | `workspace-write` |
| Grok bridge | Default `workspace-write` (`--permission-mode bypassPermissions`); state "do not modify". `read-only` **denies** — `plan` plus explicit `--deny` rules for Write, Edit and Bash | Default `workspace-write` |
| Cursor bridge | Default `workspace-write` (`--force`); state "do not modify". `read-only` maps to `--mode ask`, which deflects but does not deny | Default `workspace-write` |
| Copilot bridge | Default `workspace-write` (`--allow-all-tools`); state "do not modify". `read-only` denies shell, write and edit tools | Default `workspace-write` |

The unrestricted default is deliberate: an approval prompt inside a headless child blocks both the child and its parent. Bridge `workspace-write` therefore names the full non-interactive provider policy, not an OS boundary. Always carry advisory/implementation intent in `developer-instructions`. Explicit `read-only` behavior is provider-specific: Codex uses its OS-enforced sandbox, Grok and Copilot add deny rules, Claude uses plan mode, Agy soft-denies only shell, Cursor deflects rather than enforces, and Kimi refuses the value. A denying policy may also prevent Agent Mail writes, which must fail open.

### Step 4: Notify User
Always inform the user before delegating:
```
Delegating to [Expert Name]: [brief task summary]
```

### Step 5: Build Delegation Prompt
Use the 7-section format from `rules/delegation-format.md`.

**IMPORTANT:** For single-shot calls, include FULL context. For multi-turn, use the appropriate `*-reply` tool with the `threadId` from the initial call:
- What the user asked for
- Relevant code/files
- Any previous attempts and their results (for retries)

#### Optional Agent Mail coordination

When MCP Agent Mail is already available to the caller, resolve the caller's bound identity and pass a coordination envelope containing:

```json
{
  "projectKey": "/owner/project",
  "callerAgentName": "codex-wsl-home-1",
  "mailTopic": "optional-topic-tag",
  "checkpointIntervalSeconds": 300
}
```

`callerAgentName` is the canonical `<client>-<os>-<host>-<slot>` mailbox address that Agent Mail uses in `to`; do not substitute the numeric database `Agent.id` or a display label. Never pass the caller's registration token, bearer token, or another credential. If a native subagent is only acting as the CLI runner, it must forward the original parent caller envelope unchanged so the parent can receive progress while the runner is blocked.

The callee sends `STARTED` without a `thread_id`, saves `deliveries[0].message.id`, and calls `reply_message` on that first outbound message for later checkpoints. Agent Mail routes a self-reply to the original `to` recipients and maintains the resulting mail thread internally. The provider session `threadId` is unrelated: it is returned by `claude`, `codex`, `agy`, `kimi`, `grok`, `cursor`, or `copilot` and consumed only by the corresponding `*-reply` tool.

For the Codex, Claude, Agy, Kimi, Grok, Cursor, and Copilot bridges, pass the object only through the `coordination` parameter; the bridge injects the canonical contract exactly once. If Agent Mail or a complete caller identity is unavailable, omit the envelope and continue normally.

### Step 6: Call the Expert
```typescript
// Using Codex (GPT) — workspace-write is danger-full-access + approval never
mcp__plugin_claude-delegator_codex__codex({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file — also carries advisory-vs-implementation intent]",
  coordination: { /* optional caller envelope */ },
  sandbox: "workspace-write",
  cwd: "[current working directory]"
})

// OR using Claude from a non-Claude orchestrator
mcp__claude__claude({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert prompt]",
  coordination: { /* optional caller envelope */ },
  model: "claude-opus-5-5",
  sandbox: "workspace-write",
  cwd: "[current working directory]"
})

// OR Using Agy
mcp__plugin_claude-delegator_agy__agy({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  coordination: { /* optional caller envelope */ },
  sandbox: "workspace-write",
  cwd: "[current working directory]"
})

// OR Using Grok — read-only adds built-in Write/Edit/Bash deny rules
mcp__plugin_claude-delegator_grok__grok({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  coordination: { /* optional caller envelope */ },
  sandbox: "read-only",   // denies Write, Edit and Bash at the permission layer
  cwd: "[current working directory]"
})

// OR Using Cursor — read-only deflects but does not deny; carry intent in the instructions
mcp__plugin_claude-delegator_cursor__cursor({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  coordination: { /* optional caller envelope */ },
  sandbox: "workspace-write",
  cwd: "[current working directory]"
})

// OR Using Copilot (GPT) — Copilot defaults to never-asking
mcp__plugin_claude-delegator_copilot__copilot({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  coordination: { /* optional caller envelope */ },
  sandbox: "workspace-write",
  effort: "max",
  cwd: "[current working directory]"
})
```

### Step 7: Handle Response
1. **Synthesize** - Never show raw output directly
2. **Extract insights** - Key recommendations, issues, changes
3. **Apply judgment** - Experts can be wrong; evaluate critically
4. **Verify implementation** - For implementation mode, confirm changes work

---

## Retry Flow (Implementation Mode)

When implementation fails verification, use multi-turn to retry with preserved context:

```
Attempt 1 (initial call) → Verify → [Fail]
     ↓
Attempt 2 (*-reply with threadId + error details) → Verify → [Fail]
     ↓
Attempt 3 (*-reply with threadId + full error history) → Verify → [Fail]
     ↓
Escalate to user
```

### Retry with Multi-Turn

```typescript
// Attempt 1 (Codex here; every bridge returns the same envelope)
const result = mcp__plugin_claude-delegator_codex__codex({ ... })
const threadId = JSON.parse(result.content[0].text).threadId

// Attempt 2 (context preserved — expert remembers attempt 1)
mcp__plugin_claude-delegator_codex__codex-reply({ // or the matching reply tool from the table above
  threadId,
  cwd: "/path/to/project", // a Codex resume runs where it is launched
  prompt: `The previous implementation failed verification.
Error: [exact error message]
Fix the issue and verify the change works.`
})
```

Keep the original caller envelope and Agent Mail reply chain across retries. Do not redirect progress to an intermediary runner. Continue using the provider's independently returned `threadId` only for `*-reply` calls.

Reply calls are new tool invocations, so repeat the original `sandbox` and any
other defaulted argument when continuity matters; omitting `sandbox` returns
bridges to their `workspace-write` default. Agy replies must also repeat
the start call's `model` and `cwd`. Codex replies must repeat `cwd`, and the
start call's `model` and `effort` when those were not the defaults, because a
Codex resume inherits none of them. Keep Kimi's `cwd` when the start used a
non-default directory, and always keep Cursor's `cwd` because its sessions are
workspace-bound. The deliberate exception is `effort` on Claude and Copilot:
omit it to inherit the resumed session's effort, and supply it only for an
explicit override.

### Retry with Single-Shot (Fallback)

If multi-turn is unavailable, use a new delegation call with full context:

```markdown
TASK: [Original task]

PREVIOUS ATTEMPT:
- What was done: [summary of changes made]
- Error encountered: [exact error message]
- Files modified: [list]

REQUIREMENTS:
- Fix the error from the previous attempt
- [Original requirements]
```

---

## Example: Architecture Question

User: "What are the tradeoffs of Redis vs in-memory caching?"

**Step 1**: Signal matches "Architecture decision" → Architect

**Step 2**: Read `${CLAUDE_PLUGIN_ROOT}/prompts/architect.md`

**Step 3**: Advisory mode (question, not implementation) → keep non-interactive full access, but inject an explicit "do not modify" instruction

**Step 4**: "Delegating to Architect: Analyze caching tradeoffs"

**Step 5-6**:
```typescript
mcp__plugin_claude-delegator_codex__codex({
  prompt: `TASK: Analyze tradeoffs between Redis and in-memory caching for [context].
EXPECTED OUTCOME: Clear recommendation with rationale.
CONTEXT: [user's situation, full details]
...`,
  "developer-instructions": "[contents of architect.md] PLUS \"Do not modify code\""
})
```

**Step 7**: Synthesize response, add your assessment.

---

## Example: Retry After Failed Implementation

First attempt failed with "TypeError: Cannot read property 'x' of undefined"

**Attempt 1 (initial call):**
```typescript
const result = mcp__plugin_claude-delegator_codex__codex({
  prompt: `TASK: Add input validation to the user registration endpoint.

CONTEXT:
- Express 4.x application
- Body parser middleware exists in app.ts
- [relevant code snippets]

REQUIREMENTS:
- Add validation middleware to routes/auth.ts
- Ensure validation runs after body parser
- Report all files modified`,
  "developer-instructions": "[contents of code-reviewer.md]",
  cwd: "/path/to/project"
})
const threadId = JSON.parse(result.content[0].text).threadId
```

**Attempt 2 (retry via multi-turn):**
```typescript
mcp__plugin_claude-delegator_codex__codex-reply({
  threadId,
  cwd: "/path/to/project",
  prompt: `The previous implementation failed verification.
Error: TypeError: Cannot read property 'x' of undefined at line 45
The middleware was added but req.body was undefined.
Fix the issue — ensure validation runs after body parser.`
})
```

---

## Provider Configuration Defaults

### Codex

The Codex bridge runs `node "${CLAUDE_PLUGIN_ROOT}"/server/codex/index.js`, which spawns one `codex exec --json` (or `codex exec resume --json`) per call. Every call pins its own policy with `-c` keys — `sandbox_mode`, `approval_policy = "never"`, `model_reasoning_effort` — and names the model with `-m`, so the operator's `config.toml` defaults never decide them. `--skip-git-repo-check` is always passed, because `exec` otherwise refuses to start outside a trusted git repository and the retired `mcp-server` never asked.

This prevents an inner approval prompt from suspending the parent CLI. The bridge scrubs the caller's Agent Mail identity and credentials from the child environment and stamps `CLAUDE_DELEGATOR_CODEX_DEPTH`, so a nested Codex refuses to delegate onward through its own codex target. That makes `-c mcp_servers.codex.enabled=false` unnecessary — which matters, because that override creates the table it means to disable when `config.toml` has none, and Codex then rejects the transport-less entry. Advisory-versus-implementation authorization remains explicit in `developer-instructions`; use `sandbox: "read-only"` only when refusal is preferable to autonomous completion.

`CODEX_DELEGATOR_CODEX_BIN` can still name the binary explicitly. Do not point it at a version-stamped release directory: a pin to 0.152.1 was how one host kept the retired `mcp-server` alive — and, with it, a model roster frozen at that release.

Codex also supports per-project trust configuration:

```toml
[projects."/path/to/your/project"]
trust_level = "trusted"
```

Trusted projects allow the expert full access within the sandbox policy.

### Copilot

Copilot persists session state to disk (`~/.copilot/session-state/`), so sessions survive process restarts. The `effort` parameter accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; start calls default to `max`. On start, the bridge applies verified per-model bounds: `gpt-6.1-sol` and `gpt-5.6-sol` are floored at `low` and accept `max`, while unverified model ceilings stay capped at `xhigh`. A reply does not know the session model, so omit `effort` to retain the current session setting; an explicit reply override is forwarded without the start-only floor.

---

## Cost Awareness

- **Don't spam** - One well-structured delegation beats multiple vague ones
- **Include full context** - Saves retry costs from missing information
- **Reserve for high-value tasks** - Architecture, security, complex analysis

---

## Anti-Patterns

| Don't Do This | Do This Instead |
|---------------|-----------------|
| Delegate trivial questions | Answer directly |
| Show raw expert output | Synthesize and interpret |
| Delegate without reading prompt file | ALWAYS read and inject expert prompt |
| Skip user notification | ALWAYS notify before delegating |
| Retry without including error context | Include FULL history of what was tried |
| Assume expert remembers across sessions | Use the appropriate `*-reply` tool for multi-turn; include full context for single-shot |
