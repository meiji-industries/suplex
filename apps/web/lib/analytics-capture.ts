type ApiFailure = { url: string; status: number; code?: string };

let apiFailureCapture: ((failure: ApiFailure) => void) | undefined;

export function registerApiFailureCapture(capture: ((failure: ApiFailure) => void) | undefined): void {
  apiFailureCapture = capture;
}

export function reportApiFailure(failure: ApiFailure): void {
  try { apiFailureCapture?.(failure); } catch { /* Analytics cannot change an API result. */ }
}
