import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// lib.dom does not declare the Web Speech recognizer yet.
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionConstructor = new () => Recognition;
declare global {
  interface Window { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
}

const deniedMessage = "The browser blocked the microphone. Open the browser settings and allow microphone access for this site.";
const stoppedMessage = "Dictation stopped. Start dictation again.";

function recognitionConstructor(): RecognitionConstructor | undefined {
  // The desktop app exposes the API but cannot record. macOS system dictation works there.
  if (window.suplexApp) return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/** Puts a dictated phrase in place of the selection, with one space on each side, and returns the caret after it. */
export function insertDictation(draft: string, phrase: string, start = draft.length, end = start): { text: string; caret: number } {
  const before = draft.slice(0, Math.min(start, draft.length));
  const after = draft.slice(Math.min(Math.max(start, end), draft.length));
  const head = `${before}${before && !/\s$/.test(before) ? " " : ""}${phrase}${after && !/^\s/.test(after) ? " " : ""}`;
  return { text: head + after, caret: head.length };
}

/**
 * Browser speech recognition that types each final phrase at the field's caret. The browser vendor processes the audio.
 * `onEdit` receives an update for the field's controlled value.
 */
export function useDictation(field: RefObject<HTMLTextAreaElement | null>, onEdit: (update: (draft: string) => string) => void, onError: (message: string) => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const handlers = useRef({ onEdit, onError });
  handlers.current = { onEdit, onError };
  useEffect(() => () => { recognition.current?.abort(); recognition.current = null; }, []);
  const Constructor = recognitionConstructor();
  const stop = useCallback(() => {
    if (!recognition.current) return;
    // A phrase the browser finalizes after stop still arrives through onresult.
    recognition.current.stop();
    recognition.current = null;
    setListening(false);
  }, []);
  const toggle = () => {
    if (recognition.current) { stop(); return; }
    if (!Constructor) return;
    const next = new Constructor();
    next.continuous = true;
    next.interimResults = false;
    next.lang = navigator.language;
    next.onresult = event => {
      const phrases: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const phrase = result?.isFinal ? result[0]?.transcript.trim() : "";
        if (phrase) phrases.push(phrase);
      }
      if (!phrases.length) return;
      const element = field.current;
      const start = element?.selectionStart, end = element?.selectionEnd;
      let caret = -1;
      handlers.current.onEdit(draft => {
        const edit = insertDictation(draft, phrases.join(" "), start ?? draft.length, end ?? draft.length);
        caret = edit.caret;
        return edit.text;
      });
      // React writes the new value first, which moves the caret to the end; put it back after the phrase.
      requestAnimationFrame(() => { if (element && caret >= 0) element.setSelectionRange(caret, caret); });
    };
    next.onerror = event => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      handlers.current.onError(event.error === "not-allowed" || event.error === "service-not-allowed" ? deniedMessage : stoppedMessage);
    };
    next.onend = () => {
      if (recognition.current !== next) return;
      recognition.current = null;
      setListening(false);
    };
    recognition.current = next;
    setListening(true);
    // The focused field shows the caret where the next phrase goes.
    field.current?.focus();
    try { next.start(); }
    catch { recognition.current = null; setListening(false); handlers.current.onError(stoppedMessage); }
  };
  return { supported: Boolean(Constructor), listening, toggle, stop };
}
