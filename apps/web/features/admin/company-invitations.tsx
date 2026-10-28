import { useState } from "react";
import type { CompanyInvitation } from "../../contracts/generated/CompanyInvitation.js";
import type { UserRole } from "../../contracts/generated/UserRole.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Badge } from "../../components/ui/badge.js";
import { SettingRow, SettingsSection } from "../settings/settings-layout.js";
import { inviteCompanyUser } from "./company-users-api.js";

const ROLES = [{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }] satisfies { value: UserRole; label: string }[];

export function CompanyInvitations({ companyId, invitations, open, onOpenChange, onSaved }: { companyId: string; invitations: CompanyInvitation[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError("");
    try { await inviteCompanyUser(companyId, fullName.trim(), email.trim(), role); await onSaved(); setFullName(""); setEmail(""); setRole("member"); onOpenChange(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Suplex could not send the invitation."); }
    finally { setBusy(false); }
  };
  return <>
    {invitations.length ? <SettingsSection title="Invitations">{invitations.map(invitation => <SettingRow key={invitation.id} label={invitation.fullName} description={invitation.email}><div className="flex items-center gap-2"><Badge variant="outline">{invitation.revokedAt ? "Revoked" : invitation.acceptedAt ? "Accepted" : Date.parse(invitation.expiresAt) <= Date.now() ? "Expired" : invitation.sentAt ? "Sent" : "Not sent"}</Badge>{!invitation.revokedAt && !invitation.acceptedAt && (!invitation.sentAt || Date.parse(invitation.expiresAt) <= Date.now()) ? <Button variant="outline" size="sm" onClick={() => { setFullName(invitation.fullName); setEmail(invitation.email); setRole(invitation.role); setError(""); onOpenChange(true); }}>{invitation.sentAt ? "Send again" : "Retry"}</Button> : null}</div></SettingRow>)}</SettingsSection> : null}
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Invite User</DialogTitle></DialogHeader><form onSubmit={event => { event.preventDefault(); void submit(); }}><FieldGroup>
      <Field><FieldLabel htmlFor="invite-full-name">Full name</FieldLabel><Input id="invite-full-name" required maxLength={120} autoComplete="name" value={fullName} onChange={event => setFullName(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="invite-email">Email</FieldLabel><Input id="invite-email" type="email" required maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="invite-role">Role</FieldLabel><Select items={ROLES} value={role} onValueChange={next => { if (next) setRole(next); }}><SelectTrigger id="invite-role"><SelectValue /></SelectTrigger><SelectContent>{ROLES.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !fullName.trim() || !email.trim()}>Send invitation</Button></DialogFooter>
    </FieldGroup></form></DialogContent></Dialog>
  </>;
}
