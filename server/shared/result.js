"use strict";

// MCP clients such as Claude Code surface only the text content of a tool
// result to the orchestrating model; sibling result fields like `threadId`
// are stripped before the model sees them. Mirror the native Codex
// mcp-server contract by embedding the session id in the text itself as a
// JSON envelope, so orchestrators can chain multi-turn calls without
// recovering session ids from provider state on disk.
function resultText(threadId, content) {
  return JSON.stringify({ threadId, content });
}

module.exports = { resultText };
