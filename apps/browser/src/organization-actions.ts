import { z } from 'zod';
import { IDENTITY_REGION } from '@rally/contracts/regions';
import { BrowserInvitationsSchema, BrowserWorkspaceCreatedSchema } from '@rally/contracts/browser-session';
import { browserRequest } from './transport';

/**
 * Joining or creating an organization over the browser cookie, shared by the
 * entry and the shell, and so by the Expo app, which shows both. Each runs on
 * Global, which owns identity and creates organizations, and answers only
 * where the organization is; the caller opens it there.
 */
export type OrganizationDestination = z.infer<typeof BrowserWorkspaceCreatedSchema>;
export type PendingInvitation = z.infer<typeof BrowserInvitationsSchema>['invitations'][number];

export async function listInvitations(): Promise<PendingInvitation[]> {
  return (await browserRequest(IDENTITY_REGION, '/invitations', BrowserInvitationsSchema)).invitations;
}

/** `operationId` makes a retry return the same membership. */
export function acceptInvitation(region: string, invitationId: string, operationId: string): Promise<OrganizationDestination> {
  return browserRequest(IDENTITY_REGION, `/invitations/${encodeURIComponent(invitationId)}/accept`,
    BrowserWorkspaceCreatedSchema, { region, operationId });
}

export async function declineInvitation(region: string, invitationId: string): Promise<void> {
  await browserRequest(IDENTITY_REGION, `/invitations/${encodeURIComponent(invitationId)}/decline`, z.undefined(), { region });
}

/** `operationId` makes a retry of the same name return the same organization rather than a second. */
export function createOrganization(name: string, operationId: string): Promise<OrganizationDestination> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return Promise.reject(new Error('Enter an organization name with at least two characters.'));
  return browserRequest(IDENTITY_REGION, '/workspace/create', BrowserWorkspaceCreatedSchema, { name: trimmed, operationId });
}

/** The address the shell opens an organization at, as switching Organization does. */
export function organizationPath(destination: OrganizationDestination): string {
  return `/app/workspaces/${destination.region}/${destination.workspaceId}`;
}
