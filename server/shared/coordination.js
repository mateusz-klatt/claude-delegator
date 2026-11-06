"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COORDINATION_PROMPT = fs.readFileSync(
  path.resolve(__dirname, "../../prompts/iris-coordination.md"),
  "utf8"
).trim();

const COORDINATION_FIELDS = new Set([
  "callerAgentName",
  "topic",
  "checkpointIntervalSeconds"
]);

// The caller's own `agent.name` from Iris, passed back verbatim. Iris chooses
// the form (<client>-<host>-<worktree> by default, with a slot for concurrent
// sessions), so this checks only that the value is one safe token.
const CALLER_AGENT_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const CALLER_AGENT_NAME_RE = new RegExp(CALLER_AGENT_NAME_PATTERN);
const TOPIC_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
const TOPIC_RE = new RegExp(TOPIC_PATTERN);

const coordinationSchema = Object.freeze({
  type: "object",
  description: "Optional fail-open progress reporting through Iris",
  additionalProperties: false,
  properties: {
    callerAgentName: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: CALLER_AGENT_NAME_PATTERN,
      description: "The caller's Iris agent name, from whoami, used in the message 'to' field"
    },
    topic: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: TOPIC_PATTERN,
      description: "Optional tag the callee puts at the start of each message subject"
    },
    checkpointIntervalSeconds: {
      type: "integer",
      minimum: 60,
      maximum: 3600,
      default: 300,
      description: "Requested interval between PROGRESS checkpoints"
    }
  },
  required: ["callerAgentName"]
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSingleLineString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`'coordination.${field}' must be a non-empty string`);
  }
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`'coordination.${field}' must be a single-line string of at most 512 characters`);
  }
  return value.trim();
}

function validateCoordination(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new TypeError("'coordination' must be an object when provided");
  }

  const unknownFields = Object.keys(value).filter((field) => !COORDINATION_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new TypeError(`unknown coordination field(s): ${unknownFields.join(", ")}`);
  }

  const callerAgentName = validateSingleLineString(value.callerAgentName, "callerAgentName");
  if (!CALLER_AGENT_NAME_RE.test(callerAgentName)) {
    throw new TypeError("'coordination.callerAgentName' must be an Iris agent name of at most 128 characters");
  }

  const coordination = { callerAgentName };

  if (value.topic !== undefined) {
    coordination.topic = validateSingleLineString(value.topic, "topic");
    if (!TOPIC_RE.test(coordination.topic)) {
      throw new TypeError("'coordination.topic' must be a tag of at most 64 characters");
    }
  }

  const checkpointIntervalSeconds = value.checkpointIntervalSeconds ?? 300;
  if (!Number.isInteger(checkpointIntervalSeconds) ||
      checkpointIntervalSeconds < 60 ||
      checkpointIntervalSeconds > 3600) {
      throw new TypeError("'coordination.checkpointIntervalSeconds' must be an integer from 60 to 3600");
  }
  coordination.checkpointIntervalSeconds = checkpointIntervalSeconds;

  return coordination;
}

function coordinationInstructions(coordination) {
  if (!coordination) return "";

  return [
    COORDINATION_PROMPT,
    "## Validated caller envelope",
    "Use exactly this credential-free envelope for this delegation and its checkpoints:",
    "```json",
    JSON.stringify(coordination, null, 2),
    "```"
  ].join("\n\n");
}

function appendCoordinationInstructions(prompt, coordination) {
  const instructions = coordinationInstructions(coordination);
  return instructions ? `${prompt}\n\n${instructions}` : prompt;
}

function coordinationMetadata(coordination) {
  return {
    coordinationRequested: coordination != null
  };
}

module.exports = {
  appendCoordinationInstructions,
  coordinationInstructions,
  coordinationMetadata,
  coordinationSchema,
  validateCoordination
};
