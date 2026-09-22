# Herdr integration

Suplex uses Herdr panes to display native OpenCode, Claude Code, and Devin CLI sessions. Herdr owns the pane and its current process observations. Suplex owns task intent, task status, and completion.

A provider that only assigns its native session identity inside a turn cannot attach a display before work starts. For those providers Suplex runs one bounded no-op warm-up turn first so the pane can attach immediately; the warm-up runs at most once per session.

## Observe a task terminal

The task terminal in Suplex opens a Herdr observer stream. Multiple browser views can observe the same pane at the same time. An observer cannot send input, resize the native terminal, scroll Herdr history, or take terminal control.

When a browser viewport changes size, Suplex replaces that browser's observer with one that uses the new dimensions. This replacement does not affect another observer or the native terminal. Use the task conversation to read historical work and use the native terminal to interact with the agent.

Herdr can report an agent or pane as `idle`, `working`, `blocked`, `done`, or `unknown`. These states describe the pane and its detected agent. An idle or closed pane does not mean that the Suplex task is complete.

## Check Herdr readiness

The host health response reports the Herdr client version, server version, private terminal protocol, private protocol compatibility, endpoint compatibility, and API reachability when Herdr exposes those facts.

Herdr readiness can report these conditions:

- `Herdr is not installed` means that Suplex could not resolve the Herdr CLI.
- `Suplex cannot reach Herdr` means that the CLI answered but Suplex could not list workspaces.
- `Restart Herdr for terminal views` means that the API is reachable but its private terminal protocol is incompatible.
- `Herdr diagnostics are incomplete` means that the API is reachable but its diagnostic output is missing or unrecognized.
- `Suplex could not check Herdr` means that a probe timed out or returned an ambiguous result.
- `Herdr API and terminal views are available` means that the API is reachable and Herdr reports a compatible private terminal protocol.

Herdr readiness does not block native task execution. A terminal observation error affects the display. It does not change task admission or task status.

## Add Suplex metadata to the sidebar

Suplex reports these display-only custom tokens for an attached task pane:

- `$suplex_task` contains the Suplex task ID.
- `$suplex_role` contains `Coordinator`, `Worker`, or the advisor label.
- `$suplex_model` contains the configured model ID.
- `$suplex_provider` contains the configured provider ID.

Suplex also reports `suplex_binding_id`, `suplex_task_id`, `suplex_native_session_id`, and `suplex_server_generation` for attachment identity. Keep these tokens out of the sidebar unless you need to diagnose attachment ownership.

To show the concise tokens, copy the relevant settings from [`herdr-sidebar.toml`](herdr-sidebar.toml) into the `[ui.sidebar.agents]` section of your local Herdr config. On Linux and macOS, Herdr reads `~/.config/herdr/config.toml`. On Windows, Herdr reads `%APPDATA%\herdr\config.toml`. Run `herdr --help` to confirm the path.

The example uses ordered `equals` and `contains` rules to style Suplex roles. It styles Herdr's built-in `state_text` token for attention state. Suplex does not publish an attention-state token.

After you save the config, run:

```bash
herdr server reload-config
```

You can instead select **Reload config** from the Herdr global menu. The snippet replaces the complete Agent row layout. Merge any rows that you want to keep from your current config.
