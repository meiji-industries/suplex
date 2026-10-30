/**
 * True in the iOS shell, where App Store rules apply: guideline 4.8 asks for Sign in with Apple next to a third-party
 * login, and guideline 3.1.1 asks for In-App Purchase for any paid plan the app names. So the shell offers only Suplex's
 * own email login and names no paid plan. Google Play has neither rule. The shell bridge does not name its platform,
 * so any mobile shell that is not Android counts as iOS.
 */
export function inAppStoreShell(): boolean {
  return Boolean(globalThis.window?.suplexMobile) && !/Android/i.test(globalThis.navigator?.userAgent ?? "");
}
