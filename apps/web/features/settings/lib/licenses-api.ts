/** Reads the third-party notices that the web build writes next to the client bundle. */
export async function readThirdPartyNotices(signal: AbortSignal): Promise<string> {
  const response = await fetch("/assets/third-party-licenses.txt", { signal });
  if (!response.ok) throw new Error("The third-party notices are not in this build");
  return response.text();
}
