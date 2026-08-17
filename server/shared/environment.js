"use strict";

const SENSITIVE_EXACT_KEYS = new Set([
  "agent_name",
  "claudecode",
  "http_bearer_token",
  "integration_bearer_token"
]);

/**
 * Preserve provider authentication and normal CLI configuration while keeping
 * the caller's Agent Mail identity and credentials out of the delegated CLI.
 *
 * This scrubs the environment and nothing else, which is a narrower boundary
 * than it looks. The callee may still reach Agent Mail two ways, both on disk:
 * its own MCP configuration, and — the stronger one — the per-client lifecycle
 * hooks under `~/.<client>/hooks/mcp-agent-mail/`. Those hooks read a
 * credential from the private store themselves, so removing `AGENT_MAIL_*`
 * from the environment does not affect them at all. Measured: a delegated
 * Copilot received team mail through the hook channel while every MCP read
 * refused for want of a session binding, which is why the same run could both
 * report a message id and find "no retrievable entry".
 *
 * That reach is deliberate (decision 8): a delegate that grinds for a long
 * time needs a channel to report progress on. The point of naming it here is
 * that this file must not be mistaken for the boundary — it severs the
 * caller's identity, not the callee's access.
 */
function buildCalleeEnv(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (
      SENSITIVE_EXACT_KEYS.has(normalized) ||
      normalized.startsWith("agent_mail_") ||
      normalized.startsWith("mcp_agent_mail_")
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

module.exports = { buildCalleeEnv };
