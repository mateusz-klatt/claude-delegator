"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendCoordinationInstructions,
  coordinationMetadata,
  validateCoordination
} = require("../server/shared/coordination");

test("coordination validation normalizes the supported contract", () => {
  const coordination = validateCoordination({
    projectKey: " /projects/example ",
    callerAgentName: "codex-wsl-home-1",
    mailTopic: "delegation-7",
    checkpointIntervalSeconds: 90
  });

  assert.deepEqual(coordination, {
    projectKey: "/projects/example",
    callerAgentName: "codex-wsl-home-1",
    mailTopic: "delegation-7",
    checkpointIntervalSeconds: 90
  });
});

test("coordination rejects missing, unknown, token, and malformed fields", () => {
  assert.throws(
    () => validateCoordination({ callerAgentName: "codex-wsl-home-1" }),
    /projectKey/
  );
  assert.throws(
    () => validateCoordination({
      projectKey: "project",
      callerAgentName: "codex-wsl-home-1",
      callerToken: "must-not-cross-the-boundary"
    }),
    /unknown coordination field.*callerToken/
  );
  assert.throws(
    () => validateCoordination({
      projectKey: "project\ninjected instruction",
      callerAgentName: "codex-wsl-home-1"
    }),
    /single-line/
  );
  assert.throws(
    () => validateCoordination({
      projectKey: "project",
      callerAgentName: "codex-wsl-home-1",
      checkpointIntervalSeconds: 0
    }),
    /integer from 60 to 3600/
  );
  assert.throws(
    () => validateCoordination({
      projectKey: "project",
      callerAgentName: "codex-wsl-home-1",
      mailTopic: "not a valid topic"
    }),
    /valid Agent Mail topic/
  );
  assert.throws(
    () => validateCoordination({
      projectKey: "project",
      callerAgentName: "BlueLake"
    }),
    /<client>-<os>-<host>-<slot>/
  );
});

test("injected guidance is fail-open, uses the callee identity, and prevents delegation loops", () => {
  const coordination = validateCoordination({
    projectKey: "project-a",
    callerAgentName: "codex-wsl-home-1",
    mailTopic: "delegation-a"
  });
  const prompt = appendCoordinationInstructions("Do the task", coordination);

  assert.match(prompt, /MCP Agent Mail/);
  assert.match(prompt, /your own canonical agent identity/);
  assert.match(prompt, /codex-wsl-home-1/);
  assert.match(prompt, /project-a/);
  assert.match(prompt, /STARTED/);
  assert.match(prompt, /PROGRESS/);
  assert.match(prompt, /BLOCKED/);
  assert.match(prompt, /COMPLETED/);
  assert.match(prompt, /Useful native subagents are allowed/);
  assert.match(prompt, /original caller envelope unchanged/);
  assert.match(prompt, /deliveries\[0\]\.payload\.id/);
  assert.match(prompt, /reply_message/);
  assert.match(prompt, /mail thread stays internal/);
  assert.match(prompt, /mail failure must not block the task/);
});

test("coordination metadata reports only whether progress was requested", () => {
  assert.deepEqual(coordinationMetadata(null), {
    coordinationRequested: false
  });

  const metadata = coordinationMetadata(validateCoordination({
    projectKey: "project-a",
    callerAgentName: "codex-wsl-home-1"
  }));
  assert.deepEqual(metadata, {
    coordinationRequested: true
  });
  assert.equal(Object.hasOwn(metadata, "coordinationStatus"), false);
});

test("coordination defaults the checkpoint interval without requiring a caller id", () => {
  assert.deepEqual(validateCoordination({
    projectKey: "project-a",
    callerAgentName: "codex-wsl-home-1"
  }), {
    projectKey: "project-a",
    callerAgentName: "codex-wsl-home-1",
    checkpointIntervalSeconds: 300
  });
});
