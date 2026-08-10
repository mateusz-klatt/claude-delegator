"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COORDINATION_PROMPT = fs.readFileSync(
  path.resolve(__dirname, "../../prompts/agent-mail-coordination.md"),
  "utf8"
).trim();

const COORDINATION_FIELDS = new Set([
  "projectKey",
  "callerAgentName",
  "mailTopic",
  "checkpointIntervalSeconds"
]);

const coordinationSchema = Object.freeze({
  type: "object",
  description: "Optional fail-open progress reporting through MCP Agent Mail",
  additionalProperties: false,
  properties: {
    projectKey: {
      type: "string",
      minLength: 1,
      description: "MCP Agent Mail project key shared with the caller"
    },
    callerAgentName: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: String.raw`^(?:claude|codex|copilot|gemini)-(?:linux|wsl|win|mac|other)-[A-Za-z0-9][A-Za-z0-9._-]{0,95}-[1-9]\d*$`,
      description: "Canonical routable Agent Mail name (<client>-<os>-<host>-<slot>) used in the message 'to' field"
    },
    mailTopic: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      description: "Optional Agent Mail topic tag for filtering; the callee derives a concise message subject from the task"
    },
    checkpointIntervalSeconds: {
      type: "integer",
      minimum: 60,
      maximum: 3600,
      default: 300,
      description: "Requested interval between PROGRESS checkpoints"
    }
  },
  required: ["projectKey", "callerAgentName"]
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

  const projectKey = validateSingleLineString(value.projectKey, "projectKey");
  const callerAgentName = validateSingleLineString(value.callerAgentName, "callerAgentName");
  if (callerAgentName.length > 128 ||
      !/^(?:claude|codex|copilot|gemini)-(?:linux|wsl|win|mac|other)-[A-Za-z0-9][A-Za-z0-9._-]{0,95}-[1-9]\d*$/.test(callerAgentName)) {
    throw new TypeError("'coordination.callerAgentName' must use <client>-<os>-<host>-<slot> and be at most 128 characters");
  }

  const coordination = {
    projectKey,
    callerAgentName
  };

  if (value.mailTopic !== undefined) {
    coordination.mailTopic = validateSingleLineString(value.mailTopic, "mailTopic");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(coordination.mailTopic)) {
      throw new TypeError("'coordination.mailTopic' must be a valid Agent Mail topic of at most 64 characters");
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
