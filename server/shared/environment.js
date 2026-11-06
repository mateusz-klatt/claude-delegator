"use strict";

const SENSITIVE_EXACT_KEYS = new Set([
  "claudecode",
  "iris_execution"
]);

/**
 * Preserve provider authentication and normal CLI configuration while keeping
 * the caller's Iris identity out of the delegated CLI.
 *
 * IRIS_EXECUTION is the first thing `iris mcp` consults when it binds a tool
 * call to a session, so a child that inherited it would report as its caller.
 * IRIS_HUB_URL and IRIS_TOKEN_FILE stay: they name the hub, not the session, and
 * the child's own hooks need them.
 *
 * This scrubs the environment and nothing else, which is a narrower boundary
 * than it looks. The callee reaches Iris through its own MCP configuration and
 * lifecycle hooks, both on disk, and registers as its own session. That reach
 * is deliberate (decision 8): a delegate that grinds for a long time needs a
 * channel to report progress on. The point of naming it here is that this file
 * must not be mistaken for the boundary — it severs the caller's identity, not
 * the callee's access.
 */
function buildCalleeEnv(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SENSITIVE_EXACT_KEYS.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

module.exports = { buildCalleeEnv };
