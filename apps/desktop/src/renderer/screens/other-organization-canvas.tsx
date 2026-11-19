import { ConfiguredRegionSchema } from '@rally/contracts/regions';
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';

import { PaneState } from '../components/pane-state';
import { Button, EmptyState } from '../components/primitives';
import { OrganizationScope, useOrganizationSession, type OrganizationTarget } from '../lib/organization-scope';
import { CanvasScreen } from './canvas';
import { ConversationOpeningSkeleton } from './conversation-surface';

/**
 * `/organizations/:region/:workspaceId/canvases/:id`: a Canvas shared with
 * this person in another of their Organizations, opened in place. The
 * Organization in front stays in front; the Canvas screen inside runs on the
 * other Organization's own client (`OrganizationScope`), with whatever that
 * Organization lets this person do there.
 */
export function OtherOrganizationCanvasScreen(): React.JSX.Element {
  const { region, workspaceId } = useParams();
  const parsedRegion = ConfiguredRegionSchema.safeParse(region);
  const target = useMemo<OrganizationTarget | null>(
    () => parsedRegion.success && workspaceId ? { region: parsedRegion.data, workspaceId } : null,
    [parsedRegion.success, parsedRegion.data, workspaceId],
  );
  const organization = useOrganizationSession(target);
  if (!target) return <EmptyState description="This link names no Organization this build can open." title="Canvas" />;
  if (organization.error) {
    return <PaneState
      action={<Button onClick={() => void organization.refetch()}>Try again</Button>}
      description={organization.error instanceof Error ? organization.error.message : 'Rally could not reach it.'}
      title="This Canvas’s Organization could not be opened"
    />;
  }
  if (!organization.data) return <ConversationOpeningSkeleton label="Opening Canvas…" parentKind="canvas" />;
  // Keyed by Organization, so moving between two of them never shares a cache.
  return <OrganizationScope key={`${target.region}:${target.workspaceId}`} organization={organization.data}>
    <CanvasScreen />
  </OrganizationScope>;
}
