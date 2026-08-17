# Model Orchestration

You have access to Claude, GPT, Agy, Kimi, and Copilot experts via MCP tools. Use them strategically based on these guidelines. The Claude target is for external orchestrators such as Codex; Claude Code must not target itself.

## Available Tools

| Tool | Provider | Use For |
|------|----------|---------|
| `mcp__claude__claude` | Claude | Start a new Claude expert session from an external orchestrator |
| `mcp__claude__claude-reply` | Claude | Continue an existing Claude session (multi-turn) |
| `mcp__codex__codex` | GPT (Codex) | Start a new expert session |
| `mcp__codex__codex-reply` | GPT (Codex) | Continue an existing session (multi-turn) |
| `mcp__agy__agy` | Agy (Antigravity) | Start a new expert session |
| `mcp__agy__agy-reply` | Agy (Antigravity) | Continue an existing session (multi-turn) |
| `mcp__kimi__kimi` | Kimi (Moonshot) | Start a new expert session |
| `mcp__kimi__kimi-reply` | Kimi (Moonshot) | Continue an existing session (multi-turn) |
| `mcp__copilot__copilot` | Copilot (GPT/Claude) | Start a new expert session |
| `mcp__copilot__copilot-reply` | Copilot (GPT/Claude) | Continue an existing session (multi-turn) |

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

All four provider targets support both single-shot and multi-turn delegation.

### Single-Shot (Default)

Use `mcp__claude__claude`, `mcp__codex__codex`, `mcp__agy__agy`, `mcp__kimi__kimi`, or `mcp__copilot__copilot` for independent tasks. Each call starts a fresh session with no memory of previous calls. Include ALL relevant context in the delegation prompt.

**Best for:** Advisory reviews, one-off analysis, independent implementation tasks.

### Multi-Turn

All four targets return a `threadId` from the initial call. Pass it to the corresponding `-reply` tool for follow-up turns with full context preservation.

```typescript
// Turn 1: Start session (Codex example)
const result = mcp__codex__codex({
  prompt: "Implement input validation for the user endpoint",
  "developer-instructions": "[expert prompt]",
  cwd: "/path/to/project"
})
// result includes threadId: "019c58e5-..."

// Turn 2: Follow up with context preserved
mcp__codex__codex-reply({
  threadId: "019c58e5-...",
  prompt: "Now add tests for the validation you just implemented"
})
```

**Best for:** Chained implementation steps, iterative refinement, retry after failure.

| Pattern | Tool | Context | Use When |
|---------|------|---------|----------|
| Single-shot | `claude` / `codex` / `agy` / `kimi` / `copilot` | Fresh each call | Advisory, one-off tasks |
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

For the Claude, Agy, Kimi, and Copilot bridges, do not manually inject the Agent Mail prompt: passing a complete `coordination` object makes the bridge append the canonical `${CLAUDE_PLUGIN_ROOT}/prompts/agent-mail-coordination.md` contract. For native Codex, read that file and append it with the envelope because its native tool has no `coordination` parameter.

### Step 3: Determine Mode
| Provider | Advisory | Implementation |
|----------|----------|----------------|
| Codex native MCP | Default `danger-full-access` + `never`; state "do not modify" in developer instructions | Same non-interactive policy; edits are authorized in developer instructions |
| Claude bridge | Default `workspace-write` (permission bypass); state "do not modify" | Default `workspace-write` |
| Agy bridge | Default `workspace-write` (`--dangerously-skip-permissions`); state "do not modify". `read-only` denies shell only, never writes | Default `workspace-write` |
| Kimi bridge | `workspace-write` only; state "do not modify". `read-only` is refused — print mode has no permission tier | `workspace-write` |
| Copilot bridge | Default `workspace-write` (`--allow-all-tools`); state "do not modify" | Default `workspace-write` |

The unrestricted default is deliberate: an approval prompt inside a headless child blocks both the child and its parent. Bridge `workspace-write` therefore names the full non-interactive provider policy, not an OS boundary. Always carry advisory/implementation intent in `developer-instructions`. The explicit bridge `read-only` option is available for provider-enforced denial; it may also prevent Agent Mail writes, which must fail open.

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

The callee sends `STARTED` without a `thread_id`, saves `deliveries[0].payload.id`, and calls `reply_message` on that first outbound message for later checkpoints. Agent Mail routes a self-reply to the original `to` recipients and maintains the resulting mail thread internally. The provider session `threadId` is unrelated: it is returned by `claude`, native `codex`, `agy`, `kimi`, or `copilot` and consumed only by the corresponding `*-reply` tool.

For the Claude, Agy, Kimi, and Copilot bridges, pass the object only through the `coordination` parameter; the bridge injects the canonical contract exactly once. Codex's native server does not define that field, so embed the same envelope plus the contents of `agent-mail-coordination.md` in the Codex task prompt. If Agent Mail or a complete caller identity is unavailable, omit the envelope and continue normally.

### Step 6: Call the Expert
```typescript
// Using Codex (GPT) — sandbox/approval inherit from ~/.codex/config.toml
mcp__codex__codex({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file — also carries advisory-vs-implementation intent]",
  cwd: "[current working directory]"
})

// OR using Claude from a non-Claude orchestrator
mcp__claude__claude({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert prompt]",
  coordination: { /* optional caller envelope */ },
  model: "claude-opus-5",
  sandbox: "workspace-write",
  cwd: "[current working directory]"
})

// OR Using Agy
mcp__agy__agy({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  coordination: { /* optional caller envelope */ },
  sandbox: "workspace-write",
  cwd: "[current working directory]"
})

// OR Using Copilot (GPT) — Copilot defaults to never-asking
mcp__copilot__copilot({
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
// Attempt 1 (Claude, Codex, Agy, Kimi, or Copilot)
const result = mcp__codex__codex({ ... }) // or mcp__claude__claude / mcp__agy__agy / mcp__kimi__kimi / mcp__copilot__copilot

// Attempt 2 (context preserved — expert remembers attempt 1)
mcp__codex__codex-reply({ // or mcp__claude__claude-reply / mcp__agy__agy-reply / mcp__kimi__kimi-reply / mcp__copilot__copilot-reply
  threadId: result.threadId,
  prompt: `The previous implementation failed verification.
Error: [exact error message]
Fix the issue and verify the change works.`
})
```

Keep the original caller envelope and Agent Mail reply chain across retries. Do not redirect progress to an intermediary runner. Continue using the provider's independently returned `threadId` only for `*-reply` calls.

For bridge reply calls, repeat the original `sandbox` when permission continuity matters. Claude and Copilot only change effort on reply when an explicit override is supplied.

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
mcp__codex__codex({
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
const result = mcp__codex__codex({
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
```

**Attempt 2 (retry via multi-turn):**
```typescript
mcp__codex__codex-reply({
  threadId: result.threadId,
  prompt: `The previous implementation failed verification.
Error: TypeError: Cannot read property 'x' of undefined at line 45
The middleware was added but req.body was undefined.
Fix the issue — ensure validation runs after body parser.`
})
```

---

## Provider Configuration Defaults

### Codex

The native Codex MCP server is started through the transparent environment-boundary launcher with explicit unattended settings:

```bash
node ${CLAUDE_PLUGIN_ROOT}/server/codex/launcher.js \
  -m gpt-5.6-sol -s danger-full-access -a never \
  -c model_reasoning_effort=ultra \
  -c mcp_servers.codex.enabled=false mcp-server
```

This prevents an inner approval prompt from suspending the parent CLI. The launcher preserves native MCP stdio while scrubbing the caller's Agent Mail identity and credentials. Advisory-versus-implementation authorization remains explicit in `developer-instructions`; use a restrictive per-call override only when refusal is preferable to autonomous completion.

Codex also supports per-project trust configuration:

```toml
[projects."/path/to/your/project"]
trust_level = "trusted"
```

Trusted projects allow the expert full access within the sandbox policy.

### Copilot

Copilot persists session state to disk (`~/.copilot/session-state/`), so sessions survive process restarts. The `effort` parameter accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; default is `max` for delegation tasks (`max` is verified on `gpt-5.6-sol` only — other models are capped to `xhigh` server-side).

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
