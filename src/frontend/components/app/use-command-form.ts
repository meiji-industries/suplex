import { useEffect, useRef, useState, type FormEvent } from "react";

export function useCommandForm({ error, onSubmit, initialIdempotencyKey }: { error?: string | undefined; onSubmit: (value: string, idempotencyKey: string) => Promise<void>; initialIdempotencyKey?: string | undefined }) {
  const [value, setValue] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => initialIdempotencyKey ?? crypto.randomUUID());
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 1_000) return;
    try {
      await onSubmit(trimmed, idempotencyKey);
    } catch {
      return;
    }
    setValue("");
    setIdempotencyKey(crypto.randomUUID());
  };

  return { value, setValue, errorRef, submit };
}
