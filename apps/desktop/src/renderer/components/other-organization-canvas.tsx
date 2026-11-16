import type { TileBadge } from '@rally/ui/components/identity-tile';
import { Tip } from '@rally/ui/components/primitives';

import { ConfiguredRegionSchema } from '@rally/contracts/regions';

import { useOptionalAppSession } from '../lib/app-session';
import { formatSidebarActivityTime } from '../lib/format';
import type { OtherOrganizationCanvas } from '../lib/shared-canvases';
import { CanvasMark } from './canvas-mark';
import { RowLayout } from './navigation-rows';
import { RelativeTime } from './relative-time';

/** What the Organization badge says on hover, and the row or card says to a screen reader. */
export function sharedFromLabel(organization: OtherOrganizationCanvas['organization']): string {
  return `Shared from ${organization.name}`;
}

function organizationInitial(name: string): string {
  return name.slice(0, 1).toLocaleUpperCase();
}

/** The Organization's mark, its initial as the account menu draws it, on a tile's upper right. */
export function organizationTileBadge(organization: OtherOrganizationCanvas['organization']): TileBadge {
  return {
    key: 'organization',
    corner: 'top-right',
    shape: 'squircle',
    label: sharedFromLabel(organization),
    content: <span className="organization-badge-initial">{organizationInitial(organization.name)}</span>,
  };
}

/** The same mark on a card's upper right, with its own tooltip. */
export function OrganizationCardBadge({ id, organization }: {
  id: string;
  organization: OtherOrganizationCanvas['organization'];
}): React.JSX.Element {
  const label = sharedFromLabel(organization);
  return <Tip disableHoverableContent label={label}>
    <span className="canvas-card-organization">
      <span aria-hidden="true" className="organization-badge-initial">{organizationInitial(organization.name)}</span>
      <span className="sr-only" id={id}>{label}</span>
    </span>
  </Tip>;
}

/** Opens a Canvas in its own Organization, switching to it first. */
export function useOpenOtherOrganizationCanvas(): (item: OtherOrganizationCanvas) => void {
  const app = useOptionalAppSession();
  return (item) => {
    // The server names a configured region; one this build does not know cannot be opened from it.
    const region = ConfiguredRegionSchema.safeParse(item.organization.region);
    if (region.success) app?.openWorkspaceCanvas({ region: region.data, workspaceId: item.organization.id, canvasId: item.canvas.id });
  };
}

/**
 * A sidebar row for a Canvas from another Organization: drawn as any Canvas
 * row is, with the Organization's mark on its tile's upper right and its name
 * on the second line. Its inbox copy carries no read state, so it is never
 * drawn unread. It has no
 * menu and no drag, since pinning, renaming and sharing are its own
 * Organization's; choosing it opens it there.
 */
export function OtherOrganizationCanvasRow({ item }: { item: OtherOrganizationCanvas }): React.JSX.Element {
  const open = useOpenOtherOrganizationCanvas();
  const { canvas, organization } = item;
  return <button
    className="navigation-row navigation-canvas-row navigation-other-organization-row"
    data-motion-key={`canvas:${organization.region}:${organization.id}:${canvas.id}`}
    onClick={() => open(item)}
    type="button"
  >
    <RowLayout
      detail={sharedFromLabel(organization)}
      tile={<CanvasMark appearance={canvas.appearance} badges={[organizationTileBadge(organization)]} id={canvas.id} />}
      time={<RelativeTime className="navigation-row-time" format={formatSidebarActivityTime} value={canvas.updatedAt} />}
      title={canvas.title || 'Untitled canvas'}
      unread={false}
    />
  </button>;
}
