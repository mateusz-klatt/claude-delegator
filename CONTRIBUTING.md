# Contributing to claude-delegator

Contributions welcome. This document covers how to contribute effectively.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/mateusz-klatt/claude-delegator
cd claude-delegator

# Install development dependencies and run the bridge suite
npm ci
npm test
```

---

## What to Contribute

| Area | Examples |
|------|----------|
| **New Providers** | Ollama, Mistral, local model integrations |
| **Role Prompts** | New roles for `prompts/`, improved existing prompts |
| **Rules** | Better delegation triggers, model selection logic |
| **Bug Fixes** | Command issues, error messages |
| **Documentation** | README improvements, examples, troubleshooting |

---

## Project Structure

```
claude-delegator/
├── .claude-plugin/         # Plugin manifest
│   └── plugin.json
├── commands/               # Slash commands (/setup, /uninstall)
├── rules/                  # Orchestration logic (installed to ~/.claude/rules/)
├── prompts/                # Five expert prompts + Agent Mail contract
├── server/                 # MCP bridges plus the transparent Codex launcher
│   └── shared/             # bridge.js core, coordination, environment, result
├── test/                   # Shared contract and catalog tests
├── config/                 # Provider registry and model catalog
├── CLAUDE.md               # Development guidance for Claude Code
└── README.md               # User-facing docs
```

---

## Pull Request Process

### Before Submitting

1. **Test your changes** - Run `/claude-delegator:setup` and verify
2. **Update docs** - If you change behavior, update relevant docs
3. **Keep commits atomic** - One logical change per commit

### PR Guidelines

| Do | Don't |
|----|-------|
| Focus on one change | Bundle unrelated changes |
| Write clear commit messages | Leave vague descriptions |
| Test with actual MCP calls | Assume it works |
| Update CLAUDE.md if needed | Ignore developer docs |

### Commit Message Format

```
type: short description

Longer explanation if needed.
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`

Examples:
- `feat: add Ollama provider support`
- `fix: handle Codex timeout correctly`
- `docs: add troubleshooting for auth issues`

---

## Adding a New Provider

1. **Check native MCP support** - If the CLI has `mcp-server` like Codex, no wrapper needed

2. **Create an MCP bridge** (if needed):
   ```
   server/your-provider/
   ├── index.js
   └── index.test.js
   ```

   **Build on `server/shared/bridge.js`; do not restate it.** The core owns the
   JSON-RPC stdio loop, `superviseChild()`, the process-group kill, the Windows
   `.cmd` shim resolver, CLI lookup, common validation and the depth guard. Four
   things are yours, and a bridge that needs a fifth is worth discussing first:

   | Yours | Where |
   |-------|-------|
   | Tool schemas | `YOUR_TOOLS`, exported as `toolDefinitions` |
   | The argv you build | your `run*` function, before it calls `superviseChild` |
   | Parsing the CLI's output | your `parse*Output` |
   | Classifying failure | `onClose({code, stdout, stderr})` — return the result or throw |

   Guard the bootstrap with `require.main === module` and export
   `toolDefinitions`, so the contract tests can require the module on a runner
   where the CLI is absent instead of asserting over your source text.

3. **Add to providers.json**:
   ```json
   {
     "your-provider": {
       "cli": "your-cli",
       "mcp": { ... },
       "experts": ["architect", "plan-reviewer", "scope-analyst", "code-reviewer", "security-analyst"],
       "strengths": ["what it's good at"]
     }
   }
   ```

4. **Add role prompts** (optional):
   ```
   prompts/your-role.md
   ```

5. **Add to `config/model-catalog.json`** - Record `cliVersion`, `discoverySource`, `defaultModel` and the roster. Bridges read their schema enums from here, so a missing entry crashes the bridge at load. Say how you discovered the roster; `agy models`, `copilot help config` and `~/.codex/models_cache.json` all work headlessly, while Claude's `/model` selector does not.

6. **Add your client to `CALLER_CLIENTS`** - one array in `server/shared/coordination.js`; the advertised schema `pattern` and the runtime check are both derived from it. This used to be two hard-coded literals with a note asking you to remember both, and grok shipped with neither updated — so `test/coordination.test.js` now walks `server/*` and fails if a bridge directory is not a routable client. You will be told rather than trusted.

7. **Update the hard-coded provider lists in `test/`** - `result-format.test.js`, `model-catalog.test.js` and `provider-config.test.js` each enumerate bridges by name. A new bridge that is not added there is silently untested.

8. **Update setup and uninstall commands** - Add detection, registration and a health check to `commands/setup.md`, and a `claude mcp remove` line to `commands/uninstall.md`

9. **Document in README, CLAUDE.md and `rules/`** - Add to provider tables, the component table, and `rules/model-selection.md` (a `timeout` row there is asserted by tests)

Land the bridge and its test file in the same commit: coverage counts `server/**` from the moment the file exists, so a bridge merged ahead of its tests drags the coverage gate down.

---

## Code Style

### Markdown (Rules/Prompts)

- Use tables for structured data
- Keep prompts concise and actionable
- Test with actual Claude Code usage

### JavaScript (MCP bridges)

- Keep the runtime zero-dependency; development-only test dependencies are acceptable
- Validate all public tool arguments before invoking a CLI
- Never forward caller identity or Agent Mail credentials into a delegated process

---

## Testing

### Automated Testing

```bash
npm ci
npm test
npm run test:coverage
```

CI runs the suite on Ubuntu and Windows with Node 22 and 24. Add stub-CLI tests for command construction, validation, session resume, cancellation, timeouts, and environment boundaries whenever a bridge changes.

Behaviour the core owns is tested once, in `server/shared/bridge.test.js`. Behaviour that *deviates* is tested per bridge, driving the spawned server and inspecting real argv — `server/agy` asserts `--model` is passed on reply, `server/copilot` asserts it is not, and a single test in the core could satisfy neither. When in doubt: if the assertion would read the same for every provider, it belongs to the core; if it only makes sense because this provider is odd, it stays where the oddity is.

### Manual Testing

After changes, verify with actual MCP calls:

1. Install the plugin in Claude Code
2. Run `/claude-delegator:setup`
3. Verify MCP tools are available (`mcp__codex__codex`)
4. Use `node test/mcp-probe.mjs -- <server command>` for an stdio handshake, then test a live call with a low-cost model. Its exit code is a taxonomy, not a boolean — `0` success, `1` the bridge answered and the answer is a tool-level failure, `2` contract failure (bad usage, tool not advertised, JSON-RPC error, server died mid-handshake). Read it that way: a provider outage is `1` and says nothing about your bridge, while `2` means the bridge broke its own contract
5. Verify responses are properly synthesized
6. Test error cases (timeout, missing CLI)

---

## Questions?

Open an issue for:
- Feature requests
- Bug reports
- Documentation gaps
- Architecture discussions
