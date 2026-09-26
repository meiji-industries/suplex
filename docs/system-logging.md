# System event log

The native host writes lifecycle observations to `system.log`. A checkout uses `.suplex/logs/system.log`. Each line is one JSON object. Native agent transcripts remain in the provider's own storage. A Coordinator bridge sends selected events to the host over a local socket. If the host is absent, the bridge continues its tool call and drops the event.

## Record fields

Every record has `schemaVersion`, `time`, `eventId`, `bootId`, `sequence`, `pid`, `bootElapsedMs`, `type`, and `source`. `time` is when the API wrote the record. `bootElapsedMs` uses the API process monotonic clock. A forwarded bridge record also has `producerTime`, `producerPid`, `producerSequence`, and `processInstanceId`. Its `eventId` comes from the bridge. `causeEventId` links an observed action to a known cause. Missing causes remain unknown.

Request actions carry `requestId` and, when supplied, `clientId`. The client ID identifies a browser tab. `documentId` distinguishes page loads, including tabs copied from another tab's session storage. `client_lifecycle` records are browser reports with both `clientTime` and server `time`. They do not prove that the laptop slept or woke. `clock_gap` reports timer drift using wall and monotonic durations. It does not assert an operating system sleep. Suplex does not observe Herdr reconnects unless a separate native observation reports them.

`task_admitted` is emitted after its database transaction commits. Dependent admission includes `prerequisiteTaskId`. `task_snapshot` is an authoritative database observation at API startup. It has no claimed cause and covers events lost while the API was unavailable. Queue waits contain prerequisite IDs and reason codes, without titles. `native_turn` snapshots include the known native state, reason, unsettled tool IDs, and process state when the runtime observes it. `outputAgeMs: null` means the runtime has no separate tool-output timestamp. Transcript modification time is not treated as tool progress. CPU use is not sampled. `agent_final` means native final evidence was observed; it does not imply that the process exited or tools settled. `headless_process.exit_observed` has the actual exit code and signal from the child callback. A code of 137 alone does not establish a signal.

`command_process` records a task command's process ID, step ID, elapsed time, exit code, and actual close signal. It omits command text, arguments, environment, and output. `process_signal` records Suplex's requested signal separately from the process's observed exit.

The writer accepts at most 8 KiB per record. It rotates at 10 MiB or when the UTC day changes. It retains archives for at most seven days and caps current plus archives at 100 MiB. The cap can shorten retention. Rotation and pruning affect only `system-<date>-<id>.log` archives. Files use mode `0600`. A missing or unwritable log path cannot block task execution. The bridge socket uses mode `0600`, accepts bounded messages, and sends no prompt text, command environment, session cookie, or native transcript. Telemetry is never used as task authority.

If `system.log` ends with a partial line after a crash or starts with a malformed record, the next event moves that file to an archive and creates a clean `system.log`. The archive keeps the partial evidence until normal retention pruning removes it. Use `jq -R 'fromjson? // empty'` to read valid lines from an archive that contains a partial line.

## Reconstruct a task timeline

Run this command from the repository root of the checkout. Replace `TASK_ID` with the task ID.

```bash
jq -c 'select(.taskId == "TASK_ID" or .prerequisiteTaskId == "TASK_ID") | {time, type, state, taskId, prerequisiteTaskId, source, trigger, requestId, clientId, causeEventId, eventId, reason}' .suplex/logs/system*.log
```

Use `rg 'TASK_ID' .suplex/logs/system*.log` when `jq` is unavailable. Compare `bootId` and `sequence` within one API run. Use `producerTime` and `producerSequence` for bridge order. Clocks in separate processes can differ. A transport outage leaves a gap, so inspect the next `task_snapshot` and the native transcript before assigning a cause.
