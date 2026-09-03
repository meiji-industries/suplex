import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";

import { readJson } from "../../../lib/api.js";
import { Button } from "../../ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select.js";
import { Textarea } from "../../ui/textarea.js";

type LivePane = { role: string; status: string | null };
type LivePaneResponse = { panes?: LivePane[] };

function defaultTarget(phase: string, panes: readonly LivePane[]): string {
  if (phase === "planning" || phase === "approval") return "planner";
  return panes.find((pane) => pane.status === "blocked" || pane.status === "awaiting_human" || pane.status === "working")?.role ?? "planner";
}

export function ChatComposer({ taskId, phase, disabled, plannerAvailable, onSubmit }: { taskId: string; phase: string; disabled: boolean; plannerAvailable: boolean; onSubmit: (note: string, commandId: string) => Promise<void> }) {
  const [panes, setPanes] = useState<LivePane[]>([]);
  const [target, setTarget] = useState("planner");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [userSelectedTarget, setUserSelectedTarget] = useState(false);
  const terminal = phase === "done" || phase === "cancelled";

  useEffect(() => {
    let active = true;
    void readJson<LivePaneResponse>(`/api/tasks/${encodeURIComponent(taskId)}/pane`)
      .then((response) => { if (active) setPanes(response.panes ?? []); })
      .catch(() => { if (active) setPanes([]); });
    return () => { active = false; };
  }, [taskId]);

  useEffect(() => {
    setUserSelectedTarget(false);
    setTarget(defaultTarget(phase, panes));
  }, [phase, taskId]);

  useEffect(() => {
    if (!userSelectedTarget || (target !== "planner" && !panes.some((pane) => pane.role === target))) setTarget(defaultTarget(phase, panes));
  }, [panes, phase, target, userSelectedTarget]);

  if (terminal) return null;
  const selectedPane = panes.find((pane) => pane.role === target);
  const canSubmit = !disabled && !submitting && Boolean(message.trim()) && (target !== "planner" || plannerAvailable);
  const submit = async (): Promise<void> => {
    const text = message.trim();
    if (!canSubmit || !text) return;
    setSubmitting(true);
    try {
      if (selectedPane) await readJson(`/api/tasks/${encodeURIComponent(taskId)}/pane/${encodeURIComponent(selectedPane.role)}/input`, { method: "POST", body: JSON.stringify({ text }) });
      else await onSubmit(text, crypto.randomUUID());
      setMessage("");
    } finally {
      setSubmitting(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.nativeEvent.isComposing || !canSubmit) return;
    event.preventDefault();
    void submit();
  };
  const onFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit();
  };
  return <form className="sticky bottom-0 space-y-2 border-t bg-background pt-2" data-task-chat-composer onSubmit={onFormSubmit}>
    <Select value={target} onValueChange={(value) => { if (value) { setTarget(value); setUserSelectedTarget(true); } }}>
      <SelectTrigger aria-label="Message target" size="sm"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="planner" disabled={!plannerAvailable}>Planner (plan note)</SelectItem>{panes.map((pane) => <SelectItem key={pane.role} value={pane.role}>{pane.role.slice(0, 1).toUpperCase() + pane.role.slice(1)} session</SelectItem>)}</SelectContent>
    </Select>
    <Textarea aria-label="Message" value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={onKeyDown} placeholder={selectedPane ? `Send to ${selectedPane.role}…` : "Add a plan note"} disabled={disabled || submitting} />
    <div className="flex items-center justify-between gap-3"><p className="text-[11px] text-muted-foreground">Cmd/Ctrl+Enter to send</p><Button size="sm" type="submit" disabled={!canSubmit}>{submitting ? "Forge sends" : "Send"}</Button></div>
  </form>;
}
