import { useEffect, useState, type ReactElement } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Spinner } from "../../components/ui/spinner.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { MoveRunResponse } from "../../contracts/generated/MoveRunResponse.js";
import { listPullRequestSources, type PullRequestSource } from "../tasks/lib/task-api.js";
import { startMove } from "./lib/move-api.js";

type PullRequests = { available: boolean; sources: PullRequestSource[] } | null;

/** A move with no inputs and no pull request choice starts without a form. */
export const asksForInputs = (move: MoveResponse): boolean => move.inputs.length > 0 || move.runner === "pull_request_tasks";

export function StartMoveDialog({ move, prefill, open, onOpenChange, onStarted }: {
  move: MoveResponse;
  prefill: MoveRunResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (run: MoveRunResponse) => void;
}): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<number[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequests>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setValues(Object.fromEntries(move.inputs.map(input => [input.name, prefill?.inputs[input.name] ?? input.options[0] ?? ""])));
    setExcluded(prefill?.excludedPullRequests ?? []);
    setIdempotencyKey(crypto.randomUUID());
    setError("");
    setPullRequests(null);
    if (move.runner !== "pull_request_tasks") return;
    let current = true;
    listPullRequestSources(move.projectId)
      .then(result => { if (current) setPullRequests(result); })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : "GitHub did not return the open pull requests."); });
    return () => { current = false; };
  }, [open, move, prefill]);
  const start = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const run = await startMove(move.id, { inputs: values, excludedPullRequests: excluded, idempotencyKey });
      setConfirming(false);
      onStarted(run);
    } catch (cause) {
      setConfirming(false);
      setError(cause instanceof Error ? cause.message : "Suplex could not start the move.");
    } finally { setBusy(false); }
  };
  const toggle = (number: number, included: boolean): void => setExcluded(current => included ? current.filter(value => value !== number) : [...current, number]);
  const loadingPullRequests = move.runner === "pull_request_tasks" && !pullRequests && !error;
  const noPullRequests = move.runner === "pull_request_tasks" && (!pullRequests?.available || !pullRequests.sources.length);
  return <>
    <Dialog open={open && asksForInputs(move)} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{move.name}</DialogTitle></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); if (move.confirm) setConfirming(true); else void start(); }}>
          <FieldGroup>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {move.inputs.map(input => {
              const id = `move-input-${input.name}`;
              const value = values[input.name] ?? "";
              const set = (next: string): void => setValues(current => ({ ...current, [input.name]: next }));
              if (!input.options.length) return <Field key={input.name}><FieldLabel htmlFor={id}>{input.name}</FieldLabel><Input id={id} disabled={busy} value={value} onChange={event => set(event.target.value)} /></Field>;
              if (input.options.length > 6) return <Field key={input.name}><FieldLabel htmlFor={id}>{input.name}</FieldLabel><Select disabled={busy} value={value} onValueChange={next => { if (next) set(next); }}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent>{input.options.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></Field>;
              return <FieldSet key={input.name} disabled={busy}>
                <FieldLegend variant="label">{input.name}</FieldLegend>
                <RadioGroup value={value} onValueChange={next => set(String(next))}>
                  {input.options.map(option => <Field key={option} orientation="horizontal"><RadioGroupItem id={`${id}-${option}`} value={option} /><FieldLabel htmlFor={`${id}-${option}`}>{option}</FieldLabel></Field>)}
                </RadioGroup>
              </FieldSet>;
            })}
            {move.runner === "pull_request_tasks" ? <FieldSet disabled={busy}>
              <FieldLegend variant="label">Pull requests</FieldLegend>
              {loadingPullRequests ? <Spinner /> : null}
              {pullRequests && !pullRequests.available ? <Alert><AlertDescription>GitHub did not return the open pull requests.</AlertDescription></Alert> : null}
              {pullRequests?.available && !pullRequests.sources.length ? <p className="text-sm text-muted-foreground">No open pull requests</p> : null}
              <div className="max-h-72 overflow-y-auto">
                {pullRequests?.sources.map(source => {
                  const id = `move-pull-request-${source.number}`;
                  const owned = Boolean(source.usedBy);
                  return <Field key={source.number} orientation="horizontal" data-disabled={owned || undefined}>
                    <Checkbox id={id} disabled={busy || owned} checked={!owned && !excluded.includes(source.number)} onCheckedChange={checked => toggle(source.number, checked === true)} />
                    <FieldLabel htmlFor={id}><span className="text-muted-foreground">#{source.number}</span><span className="truncate">{source.title}</span></FieldLabel>
                  </Field>;
                })}
              </div>
            </FieldSet> : null}
            <DialogFooter>
              <DialogClose disabled={busy} render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" size="sm" disabled={busy || noPullRequests}>Start</Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={asksForInputs(move) ? confirming : open} onOpenChange={next => { if (busy) return; if (asksForInputs(move)) setConfirming(next); else if (!next) onOpenChange(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Start {move.name}?</AlertDialogTitle></AlertDialogHeader>
        {error && !asksForInputs(move) ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void start(); }}>Start</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
