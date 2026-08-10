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

5. **Update setup command** - Add checks for the new CLI

6. **Document in README** - Add to provider tables

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

### Manual Testing

After changes, verify with actual MCP calls:

1. Install the plugin in Claude Code
2. Run `/claude-delegator:setup`
3. Verify MCP tools are available (`mcp__codex__codex`)
4. Use `node test/mcp-probe.mjs -- <server command>` for an stdio handshake, then test a live call with a low-cost model
5. Verify responses are properly synthesized
6. Test error cases (timeout, missing CLI)

---

## Questions?

Open an issue for:
- Feature requests
- Bug reports
- Documentation gaps
- Architecture discussions
