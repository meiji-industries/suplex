// The desktop bridge. The shell injects this function into the main frame of each view it creates and
// calls it with that view's configuration as JSON data:
//   { "kind": "setup" | "unavailable" | "host", "origin": "<the view's exact origin>", "platform": "macos" | "linux" | "windows",
//     "target": "<host shown by the failure page>" }
// Hiding or exposing these objects is a convenience only. The shell enforces command permissions per view
// and origin, and checks the calling webview natively, so raw IPC from any other page or frame is refused.
(config) => {
  if (window.top !== window) return;
  const here = location.protocol === "tauri:" ? `tauri://${location.host}` : location.origin;
  if (here !== config.origin) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args ?? {});
  const listeners = new Set();
  // The shell delivers events by calling this function in the same frame; nothing else can replace it.
  Object.defineProperty(window, "__suplexBridgeEvent", {
    value: (payload) => { for (const listener of [...listeners]) listener(payload); },
    writable: false,
    configurable: false,
  });
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const done = async (promise) => { await promise; };

  if (config.kind === "setup") {
    window.suplexDesktop = Object.freeze({
      snapshot: () => invoke("desktop_snapshot"),
      choose: (mode) => done(invoke("desktop_choose", { mode })),
      cancel: () => done(invoke("desktop_cancel")),
      retry: () => done(invoke("desktop_retry")),
      launch: () => done(invoke("desktop_launch")),
      back: () => done(invoke("desktop_back")),
      openLogs: () => done(invoke("desktop_open_logs")),
      copyOutput: () => done(invoke("desktop_copy_output")),
      testConnection: (url) => invoke("desktop_test_connection", { url }),
      tailscaleStatus: () => invoke("desktop_tailscale_status"),
      turnOnTailscale: () => invoke("desktop_turn_on_tailscale"),
      openTailscale: () => done(invoke("desktop_open_tailscale")),
      removeHost: (origin) => done(invoke("desktop_remove_host", { origin })),
      selectHost: (origin) => done(invoke("desktop_select_host", { origin })),
      on: (listener) => subscribe(listener),
    });
  } else if (config.kind === "unavailable") {
    window.suplexUnavailable = Object.freeze({
      target: config.target,
      retry: () => done(invoke("unavailable_retry")),
      openHostPicker: () => done(invoke("unavailable_open_host_picker")),
    });
  } else if (config.kind === "host") {
    window.suplexApp = Object.freeze({
      platform: config.platform,
      version: config.version,
      accountCleared: () => done(invoke("app_account_cleared")),
      openHostPicker: () => done(invoke("app_open_host_picker")),
      networkAccess: () => invoke("app_network_access"),
      saveNetworkAccessPreference: (mode) => invoke("app_save_network_access_preference", { mode }),
      restartNetworkAccess: () => invoke("app_restart_network_access"),
      // Events carrying `update` are the updater's; everything else is a network access snapshot.
      onNetworkAccessChange: (listener) => subscribe((payload) => { if (!payload.update) listener(payload); }),
      updateStatus: () => invoke("app_update_status"),
      checkForUpdates: () => done(invoke("app_check_for_updates")),
      onUpdateChange: (listener) => subscribe((payload) => { if (payload.update) listener(payload.update); }),
      zoom: (step) => done(invoke("app_zoom", { step })),
    });
  }
}
