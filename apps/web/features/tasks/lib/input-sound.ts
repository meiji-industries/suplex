import inputNeededUrl from "../../../assets/input-needed.wav";
import type { TaskListTask } from "../../../contracts/task-responses.js";

export const inputSoundStorageKey = "suplex.inputSound";

export function parseInputSound(value: string | null): boolean {
  return value !== "off";
}

export function readInputSound(): boolean {
  try { return parseInputSound(window.localStorage.getItem(inputSoundStorageKey)); }
  catch { return true; }
}

export function saveInputSound(enabled: boolean): boolean {
  try { window.localStorage.setItem(inputSoundStorageKey, enabled ? "on" : "off"); }
  catch { /* Browser storage can be disabled. */ }
  return enabled;
}

/**
 * Returns the ids of the tasks that a `changes` frame moved into `waiting_human`.
 * A snapshot starts each connection, so the tasks it shows waiting are not new to this page.
 */
export function tasksEnteringInput(frame: "snapshot" | "changes", before: readonly TaskListTask[] | undefined, after: readonly TaskListTask[] | undefined): string[] {
  if (frame !== "changes" || !before || !after) return [];
  const waiting = new Set(before.filter(task => task.status === "waiting_human").map(task => task.id));
  return after.filter(task => task.status === "waiting_human" && !waiting.has(task.id)).map(task => task.id);
}

/**
 * Plays the sound when the setting is on. A browser can refuse audio before the first interaction with the page.
 * Then the sound plays once on the next pointer or key press.
 */
export function createInputSound(play: () => Promise<void>, enabled: () => boolean = readInputSound, target: EventTarget = window): () => void {
  let pending: AbortController | undefined;
  const retry = (): void => {
    pending?.abort(); pending = undefined;
    if (enabled()) play().catch(() => undefined);
  };
  return () => {
    if (!enabled()) return;
    play().catch((reason: unknown) => {
      if (pending || !(reason instanceof DOMException && reason.name === "NotAllowedError")) return;
      pending = new AbortController();
      target.addEventListener("pointerdown", retry, { once: true, signal: pending.signal });
      target.addEventListener("keydown", retry, { once: true, signal: pending.signal });
    });
  };
}

let audio: HTMLAudioElement | undefined;
function playAudio(): Promise<void> {
  try {
    audio ??= new Audio(inputNeededUrl);
    audio.currentTime = 0;
    return audio.play();
  } catch (reason) { return Promise.reject(reason); }
}

let shared: (() => void) | undefined;
export function playInputSound(): void {
  (shared ??= createInputSound(playAudio))();
}
