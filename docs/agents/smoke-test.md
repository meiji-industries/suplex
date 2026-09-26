# Native runtime smoke test

This is an on-demand check for a disposable task, not a CI prerequisite. Run `mise run dev:status` first and reuse an already listening stack. Do not restart a shared stack or interrupt a live agent pane for a smoke test.

1. Create and start a disposable task. Confirm Root and Worker use the configured native provider session and the task worktree.
2. Inspect the task's chat and native session while it runs. Steering and questions should appear once, and Herdr should display the session without becoming the authority for its status.
3. In an isolated stack, restart the host during an unsettled turn. Confirm the same native session is observed and an admitted prompt is not sent again.
4. Complete or cancel the task. Check the worktree and Git result directly, then archive it. A missing or recreated Herdr pane must not prevent archive.

Record the installed provider and exact task/turn evidence. Provider sign-in, external GitHub writes, and real app packaging need separate verification.
