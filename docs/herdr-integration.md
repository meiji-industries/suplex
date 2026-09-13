# Herdr integration

Forge uses Herdr panes to display native OpenCode and Claude Code sessions. Herdr owns the pane and its current process observations. Forge owns task intent, task status, and completion.

## Observe a task terminal

The task terminal in Forge opens a Herdr observer stream. Multiple browser views can observe the same pane at the same time. An observer cannot send input, resize the native terminal, scroll Herdr history, or take terminal control.

When a browser viewport changes size, Forge replaces that browser's observer with one that uses the new dimensions. This replacement does not affect another observer or the native terminal. Use the task conversation to read historical work and use the native terminal to interact with the agent.

Herdr can report an agent or pane as `idle`, `working`, `blocked`, `done`, or `unknown`. These states describe the pane and its detected agent. An idle or closed pane does not mean that the Forge task is complete.

## Check Herdr readiness

The host health response reports the Herdr client version, server version, private terminal protocol, private protocol compatibility, endpoint compatibility, and API reachability when Herdr exposes those facts.

Herdr readiness can report these conditions:

- `Herdr is not installed` means that Forge could not resolve the Herdr CLI.
- `Forge cannot reach Herdr` means that the CLI answered but Forge could not list workspaces.
- `Restart Herdr for terminal views` means that the API is reachable but its private terminal protocol is incompatible.
- `Herdr diagnostics are incomplete` means that the API is reachable but its diagnostic output is missing or unrecognized.
- `Forge could not check Herdr` means that a probe timed out or returned an ambiguous result.
- `Herdr API and terminal views are available` means that the API is reachable and Herdr reports a compatible private terminal protocol.

Herdr readiness does not block native task execution. A terminal observation error affects the display. It does not change task admission or task status.

## Add Forge metadata to the sidebar

Forge reports these display-only custom tokens for an attached task pane:

- `$forge_task` contains the Forge task ID.
- `$forge_role` contains `Coordinator`, `Worker`, or the advisor label.
- `$forge_model` contains the configured model ID.
- `$forge_provider` contains the configured provider ID.

Forge also reports `forge_binding_id`, `forge_task_id`, `forge_native_session_id`, and `forge_server_generation` for attachment identity. Keep these tokens out of the sidebar unless you need to diagnose attachment ownership.

To show the concise tokens, copy the relevant settings from [`herdr-sidebar.toml`](herdr-sidebar.toml) into the `[ui.sidebar.agents]` section of your local Herdr config. On Linux and macOS, Herdr reads `~/.config/herdr/config.toml`. On Windows, Herdr reads `%APPDATA%\herdr\config.toml`. Run `herdr --help` to confirm the path.

The example uses ordered `equals` and `contains` rules to style Forge roles. It styles Herdr's built-in `state_text` token for attention state. Forge does not publish an attention-state token.

After you save the config, run:

```bash
herdr server reload-config
```

You can instead select **Reload config** from the Herdr global menu. The snippet replaces the complete Agent row layout. Merge any rows that you want to keep from your current config.
