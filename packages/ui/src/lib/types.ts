import type { PersonalPresentation, WorkstreamAppearance } from '@rally/contracts';
export interface WorkspaceMember {
  incarnation?: string;
  revision?: number;
  presentation?: PersonalPresentation | null;
  id: string;
  name: string;
  /**
   * Absent on a person read from the guest's roster (`GET /workspace/roster`),
   * which carries no address or zone. Every member surface reads the full
   * roster and has both.
   */
  email?: string;
  avatarUrl?: string;
  timezone?: string;
  role?: string | null;
  accessClass?: "member" | "guest";
  /**
   * Present only on people read from the workspace roster, which is the one
   * place a membership that is not yet active can appear. Participants and
   * viewers are members by construction and carry no status.
   */
  status?: 'active' | 'invited' | 'suspended';
}

export type HarnessStatus = 'scheduled' | 'running' | 'needs_input' | 'completed' | 'failed' | 'stopped';
export type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
export interface ConversationPresentation {
  id: string; title: string; titleStatus: 'naming' | 'automatic' | 'settled'; createdAt?: string;
  appearance?: WorkstreamAppearance; scope: 'personal' | 'workspace'; harnessStatus: HarnessStatus;
  participants: WorkspaceMember[]; emailAddress?: string | null;
}
export interface SidebarPresentation {
  id: string; title: string; appearance?: WorkstreamAppearance;
  needsAttention?: boolean;
  scope?: 'personal' | 'workspace';
  participants: WorkspaceMember[];
  resources: { id: string; title: string; resourceType: string; mimeType?: string | null; direction: string; currentVersion: number }[];
  privateChildren?: { substreamId: string; title: string; appearance?: WorkstreamAppearance; scope?: 'personal' | 'workspace'; needsAttention?: boolean; status?: string; createdByUserId?: string; createdAt?: string; updatedAt?: string; participantUserIds?: string[] }[];
}
