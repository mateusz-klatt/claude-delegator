"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCalleeEnv } = require("../server/shared/environment");

test("callee environment keeps provider auth but scrubs caller Agent Mail identity and credentials", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/callee",
    ANTHROPIC_API_KEY: "provider-auth",
    GITHUB_TOKEN: "provider-auth",
    AGENT_NAME: "CallerAgent",
    AGENT_MAIL_AGENT: "CallerAgent",
    Agent_Mail_Project_Key: "/caller/project",
    AGENT_MAIL_REGISTRATION_TOKEN: "caller-registration-token",
    MCP_AGENT_MAIL_WINDOW_ID: "caller-window-id",
    Mcp_Agent_Mail_Token: "caller-project-token",
    HTTP_BEARER_TOKEN: "caller-server-token",
    integration_bearer_token: "caller-integration-token",
    CLAUDECODE: "nested-session"
  };

  assert.deepEqual(buildCalleeEnv(source), {
    PATH: "/bin",
    HOME: "/home/callee",
    ANTHROPIC_API_KEY: "provider-auth",
    GITHUB_TOKEN: "provider-auth"
  });
  assert.equal(source.AGENT_MAIL_AGENT, "CallerAgent");
});
