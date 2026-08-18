"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { resultText } = require("../server/shared/result");

test("resultText produces a parseable JSON envelope with threadId and content", () => {
  const text = resultText("019c58e5-abc", "All checks passed.");
  assert.deepEqual(JSON.parse(text), {
    threadId: "019c58e5-abc",
    content: "All checks passed."
  });
});

test("resultText survives quotes, newlines, and non-ASCII content", () => {
  const content = 'line one\nline two with "quotes" — and ünïcode\n\t{"nested": true}';
  const parsed = JSON.parse(resultText("unknown", content));
  assert.equal(parsed.threadId, "unknown");
  assert.equal(parsed.content, content);
});

test("every bridge embeds threadId in the success text envelope", () => {
  const runtime = fs.readFileSync(
    path.resolve(__dirname, "../server/shared/provider-runtime.js"),
    "utf8"
  );
  assert.match(runtime, /require\("\.\/result(?:\.js)?"\)/);
  assert.match(runtime, /text: resultText\(threadId, /);
  assert.doesNotMatch(runtime, /text: response/);

  for (const bridge of ["agy", "kimi", "copilot", "grok", "cursor"]) {
    const source = fs.readFileSync(
      path.resolve(__dirname, `../server/${bridge}/index.js`),
      "utf8"
    );
    assert.match(
      source,
      /require\("\.\.\/shared\/provider-runtime(?:\.js)?"\)/,
      `${bridge} bridge uses the runtime that wraps success responses in resultText`
    );
  }

  const claude = fs.readFileSync(
    path.resolve(__dirname, "../server/claude/index.js"),
    "utf8"
  );
  assert.match(claude, /require\("\.\.\/shared\/result(?:\.js)?"\)/);
  assert.match(claude, /text: resultText\(threadId, /);
  assert.doesNotMatch(claude, /text: response/);
});
