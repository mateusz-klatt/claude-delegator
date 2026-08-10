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
  for (const bridge of ["claude", "gemini", "copilot"]) {
    const source = fs.readFileSync(
      path.resolve(__dirname, `../server/${bridge}/index.js`),
      "utf8"
    );
    assert.match(
      source,
      /require\("\.\.\/shared\/result(?:\.js)?"\)/,
      `${bridge} bridge imports the shared result envelope`
    );
    assert.match(
      source,
      /text: resultText\(threadId, /,
      `${bridge} bridge wraps success responses in resultText`
    );
    assert.doesNotMatch(
      source,
      /text: response/,
      `${bridge} bridge has no bare success text without the envelope`
    );
  }
});
