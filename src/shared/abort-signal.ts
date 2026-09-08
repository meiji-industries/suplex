export function isAbortSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
