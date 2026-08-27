import { useState, type ReactElement } from "react";

import type { AttentionCard } from "../../../recovery/convergence.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.js";
import { Textarea } from "../ui/textarea.js";

export function TaskAttentionCard({ card, onAction, busy = false }: { card: AttentionCard; onAction: (command: string, note?: string) => void | Promise<void>; busy?: boolean }): ReactElement {
  const [choice, setChoice] = useState(card.decision?.recommendedChoiceId ?? "");
  const [freeText, setFreeText] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [confirm, setConfirm] = useState<AttentionCard["primaryAction"] | AttentionCard["secondaryAction"]>();
  const submit = (action: AttentionCard["primaryAction"], note?: string): void => { void onAction(action.command, note); };
  const request = (action: AttentionCard["primaryAction"]): void => {
    if (action.destructive) setConfirm(action);
    else if (action.requiresNote && !card.decision) setNoteOpen(true);
    else if (card.decision) {
      const selected = card.decision.choices.find((entry) => entry.id === choice) ?? card.decision.choices[0];
      submit(action, selected ? `${selected.label}: ${selected.description}\n${freeText}` : freeText);
    } else submit(action);
  };
  return <section className="space-y-2 border-l-2 border-amber-500/70 pl-3" data-task-attention-card>
    <div className="space-y-0.5"><h3 className="text-xs font-semibold">{card.title}</h3><p className="text-[13px] text-muted-foreground">{card.explanation}</p></div>
    <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">{card.evidence.map((evidence) => evidence.kind === "url" ? <a className="hover:underline" href={evidence.ref} key={evidence.ref}>{evidence.label || evidence.ref}</a> : <span key={evidence.ref}>{evidence.label || evidence.ref}</span>)}</div>
    {card.decision ? <div className="space-y-2"><RadioGroup value={choice} onValueChange={setChoice} aria-label={card.title}>{card.decision.choices.map((entry) => <label className="flex items-start gap-1.5 text-xs" key={entry.id}><RadioGroupItem value={entry.id} /><span>{entry.label}<span className="block text-[11px] text-muted-foreground">{entry.description}</span></span></label>)}</RadioGroup><Textarea aria-label={`${card.title} note`} value={freeText} onChange={(event) => setFreeText(event.target.value)} placeholder={card.decision.freeTextPrompt} /></div> : null}
    <div className="flex flex-wrap gap-1.5"><Button size="sm" variant={card.primaryAction.destructive ? "destructive" : "outline"} onClick={() => request(card.primaryAction)} disabled={busy}>{card.primaryAction.label}</Button>{card.secondaryAction ? <Button size="sm" variant={card.secondaryAction.destructive ? "destructive" : "ghost"} onClick={() => request(card.secondaryAction!)} disabled={busy}>{card.secondaryAction.label}</Button> : null}</div>
    <Dialog open={noteOpen} onOpenChange={setNoteOpen}><DialogContent><DialogHeader><DialogTitle>{card.primaryAction.label}</DialogTitle></DialogHeader><Textarea aria-label={`${card.primaryAction.label} note`} value={freeText} onChange={(event) => setFreeText(event.target.value)} placeholder="Add a concise note" /><DialogFooter><DialogClose render={<Button type="button" variant="ghost" />}>Keep issue</DialogClose><Button disabled={busy || !freeText.trim()} onClick={() => { setNoteOpen(false); submit(card.primaryAction, freeText); }}>{card.primaryAction.label}</Button></DialogFooter></DialogContent></Dialog>
    <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(undefined); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm?.label}?</AlertDialogTitle><AlertDialogDescription>This action may discard recoverable local state.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep issue</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={() => { if (confirm) { submit(confirm); setConfirm(undefined); } }}>{confirm?.label}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
