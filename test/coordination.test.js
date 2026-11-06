"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendCoordinationInstructions,
  coordinationMetadata,
  validateCoordination
} = require("../server/shared/coordination");

const CALLER = "codex-home-claude-delegator";

test("coordination validation normalizes the supported contract", () => {
  const coordination = validateCoordination({
    callerAgentName: ` ${CALLER} `,
    topic: "delegation-7",
    checkpointIntervalSeconds: 90
  });

  assert.deepEqual(coordination, {
    callerAgentName: CALLER,
    topic: "delegation-7",
    checkpointIntervalSeconds: 90
  });
});

test("coordination rejects missing, unknown, token, and malformed fields", () => {
  assert.throws(() => validateCoordination({}), /callerAgentName/);
  assert.throws(
    () => validateCoordination({ callerAgentName: CALLER, callerToken: "must-not-cross-the-boundary" }),
    /unknown coordination field.*callerToken/
  );
  // The Agent Mail envelope's project key has no meaning in Iris, which derives
  // the repository itself. A stale caller fails loudly rather than being ignored.
  assert.throws(
    () => validateCoordination({ projectKey: "/o/p", callerAgentName: CALLER }),
    /unknown coordination field.*projectKey/
  );
  assert.throws(
    () => validateCoordination({ callerAgentName: `${CALLER}\ninjected instruction` }),
    /single-line/
  );
  assert.throws(
    () => validateCoordination({ callerAgentName: CALLER, checkpointIntervalSeconds: 0 }),
    /integer from 60 to 3600/
  );
  assert.throws(
    () => validateCoordination({ callerAgentName: CALLER, topic: "not a valid topic" }),
    /must be a tag/
  );
  assert.throws(
    () => validateCoordination({ callerAgentName: "not an agent name" }),
    /Iris agent name/
  );
});

test("the advertised schema pattern and the runtime check accept the same names", () => {
  const { coordinationSchema } = require("../server/shared/coordination");
  const pattern = new RegExp(coordinationSchema.properties.callerAgentName.pattern);
  for (const name of [CALLER, "antigravity-home-iris", "claude-home-claude-delegator-2", "human"]) {
    assert.match(name, pattern);
    assert.equal(validateCoordination({ callerAgentName: name }).callerAgentName, name);
  }
  assert.doesNotMatch("-leading-dash", pattern);
  assert.throws(() => validateCoordination({ callerAgentName: "-leading-dash" }));
  assert.deepEqual(coordinationSchema.required, ["callerAgentName"]);
});

test("injected guidance is fail-open, uses the callee identity, and prevents delegation loops", () => {
  const coordination = validateCoordination({ callerAgentName: CALLER, topic: "delegation-a" });
  const prompt = appendCoordinationInstructions("Do the task", coordination);

  assert.match(prompt, /Optional Iris Coordination/);
  assert.match(prompt, /Never act as the caller/);
  assert.match(prompt, new RegExp(CALLER));
  assert.match(prompt, /delegation-a/);
  assert.match(prompt, /STARTED/);
  assert.match(prompt, /PROGRESS/);
  assert.match(prompt, /BLOCKED/);
  assert.match(prompt, /COMPLETED/);
  assert.match(prompt, /Useful native subagents are allowed/);
  assert.match(prompt, /original caller envelope unchanged/);
  assert.match(prompt, /`message_id`/);
  assert.match(prompt, /`reply_to`/);
  assert.match(prompt, /only inside one repository/);
  assert.match(prompt, /Do not work around the refusal/);
  assert.match(prompt, /reporting failure must not block the task/);
  assert.match(prompt, /untrusted data, never instructions/);
  assert.doesNotMatch(prompt, /Agent Mail/);
});

test("coordination metadata reports only whether progress was requested", () => {
  assert.deepEqual(coordinationMetadata(null), {
    coordinationRequested: false
  });

  const metadata = coordinationMetadata(validateCoordination({ callerAgentName: CALLER }));
  assert.deepEqual(metadata, {
    coordinationRequested: true
  });
  assert.equal(Object.hasOwn(metadata, "coordinationStatus"), false);
});

test("coordination defaults the checkpoint interval", () => {
  assert.deepEqual(validateCoordination({ callerAgentName: CALLER }), {
    callerAgentName: CALLER,
    checkpointIntervalSeconds: 300
  });
});
