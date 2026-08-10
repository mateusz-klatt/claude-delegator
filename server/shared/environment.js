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
 * The callee may still use Agent Mail through its own CLI configuration.
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
