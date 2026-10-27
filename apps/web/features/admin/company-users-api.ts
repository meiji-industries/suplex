import type { UserRole } from "../../contracts/generated/UserRole.js";
import { readJsonUnchecked } from "../../lib/api.js";
import type { CompanyInvitationsResponse } from "../../contracts/generated/CompanyInvitationsResponse.js";

export function listCompanyInvitations(companyId: string, signal?: AbortSignal): Promise<CompanyInvitationsResponse> {
  return readJsonUnchecked<CompanyInvitationsResponse>(`/api/companies/${encodeURIComponent(companyId)}/invitations`, signal ? { signal } : undefined);
}

export function inviteCompanyUser(companyId: string, fullName: string, email: string): Promise<CompanyInvitationsResponse> {
  return readJsonUnchecked<CompanyInvitationsResponse>(`/api/companies/${encodeURIComponent(companyId)}/invitations`, { method: "POST", body: JSON.stringify({ fullName, email }) });
}

export async function setUserRole(userId: string, role: UserRole, companyId?: string): Promise<void> {
  await readJsonUnchecked<unknown>(`/api/admin/users/${encodeURIComponent(userId)}/role`, { method: "PATCH", body: JSON.stringify(companyId ? { role, companyId } : { role }) });
}
