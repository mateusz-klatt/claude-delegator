"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCalleeEnv } = require("../server/shared/environment");

test("callee environment keeps provider auth and hub configuration but scrubs the caller Iris identity", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/callee",
    ANTHROPIC_API_KEY: "provider-auth",
    GITHUB_TOKEN: "provider-auth",
    IRIS_HUB_URL: "https://hub.example",
    IRIS_TOKEN_FILE: "/home/callee/.config/iris/hub.token",
    IRIS_EXECUTION: "ex_caller",
    Iris_Execution: "ex_caller_mixed_case",
    CLAUDECODE: "nested-session"
  };

  assert.deepEqual(buildCalleeEnv(source), {
    PATH: "/bin",
    HOME: "/home/callee",
    ANTHROPIC_API_KEY: "provider-auth",
    GITHUB_TOKEN: "provider-auth",
    IRIS_HUB_URL: "https://hub.example",
    IRIS_TOKEN_FILE: "/home/callee/.config/iris/hub.token"
  });
  assert.equal(source.IRIS_EXECUTION, "ex_caller");
});
