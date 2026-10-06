/** The desktop app's name for the computer it runs on. An older shell sends no platform and runs on a Mac. */
export function thisComputer(): "This Mac" | "This computer" {
  const platform = window.suplexApp?.platform;
  return !platform || platform === "macos" ? "This Mac" : "This computer";
}
