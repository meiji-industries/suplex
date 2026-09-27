# Herdr integration

Herdr displays task sessions and provides the interactive task Shell. Execution
belongs to native provider runtimes. Read the [current architecture](architecture/herdr.md)
for ownership, pane discovery, provider display differences, and recovery.

## Observe a task terminal

Session views use read-only observer streams. They cannot send input, resize the
native terminal, scroll Herdr history, or take control. The bridge follows the
pane's dimensions and replaces its observer when the pane changes size or the
observer exits. The separate Shell view accepts input, resize, and scroll.

Herdr pane states describe its detected process. An idle or closed pane does not
mean the Suplex task is complete. Use the task conversation for agent instructions
and historical work; a passive output viewer is not an interactive agent session.

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
