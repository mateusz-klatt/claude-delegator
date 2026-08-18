# Optional MCP Agent Mail Coordination

Apply this contract only when the delegation includes a `coordination` envelope and MCP Agent Mail tools are already available. Agent Mail is out-of-band progress reporting; it must never become a prerequisite for completing the delegated task.

## Addressing

- Deliver to `callerAgentName` in `projectKey`. It is the canonical `<client>-<os>-<host>-<slot>` value that Agent Mail calls `Agent.name` and accepts in `to`; it is not the numeric database `Agent.id` or a display label.
- Register or reuse your own canonical agent identity for the target. Never act as the caller.
- Never request, receive, or use the caller's registration token. Do not include any credential in progress messages.
- Useful native subagents are allowed. If a native runner or subagent forwards the delegation, keep the original caller envelope unchanged so progress reaches the agent that can make decisions.

## Progress protocol

For work expected to take more than a couple of minutes, and only when Agent Mail is available:

1. Send `STARTED` with `send_message` after you have understood the task and established your own identity. Use `to: [callerAgentName]`, derive a concise `subject` from the task, pass `mailTopic` as `topic` when supplied, and do not supply a caller-generated `thread_id`.
2. Save the first delivery's message id from `deliveries[0].message.id`.
3. Send `PROGRESS` at meaningful milestone boundaries, no more frequently than `checkpointIntervalSeconds`, by calling `reply_message` on that first outbound message id. Agent Mail deliberately routes a reply to your own outbound message back to its original recipients and establishes/preserves the mail thread internally.
4. Send `BLOCKED` in the same reply chain only when caller input is genuinely needed. Request acknowledgement in the body; `reply_message` inherits the first message's flags and cannot raise importance or `ack_required` by itself.
5. Send `COMPLETED` in the same reply chain with the outcome, changed files, verification evidence, and remaining risks.

The mail thread stays internal to Agent Mail and is not part of the bridge contract. The provider session `threadId` returned by `claude`, `codex`, `agy`, `kimi`, `grok`, `cursor`, or `copilot` remains unrelated and is consumed only by the matching `*-reply` tool. Include the target's canonical Agent Mail name, current milestone, completed work, next step, and blocker state in each checkpoint.

If Agent Mail is unavailable, registration/contact fails, or the envelope is incomplete, continue the task normally and mention the reporting limitation in the final response. A mail failure must not block the task. Only claim a checkpoint was sent when the MCP call actually succeeded. Do not install or reconfigure Agent Mail during the delegated task. Do not recursively delegate the same task back through this delegator or to the provider that invoked you merely to satisfy reporting.
