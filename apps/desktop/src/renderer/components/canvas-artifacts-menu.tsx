import type { CanvasArtifact } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { resourceGlyph } from '@rally/ui/components/resource-icon';
import { TitleMenuItem, TitleMenuSeparator } from '@rally/ui/components/title-pill';
import { useId } from 'react';

import { formatRelative } from '../lib/format';

/** A site draws the page mark; a file or archive is classified by MIME and title. */
function artifactResource(artifact: CanvasArtifact): { resourceType: string; mimeType: string | null; title: string } {
  return {
    resourceType: artifact.kind === 'site' ? 'generated_site' : 'generated_file',
    mimeType: artifact.mimeType,
    title: artifact.title,
  };
}

/**
 * The Canvas menu's Artifacts section: one row per artifact the Canvas holds,
 * newest first as the detail lists them, with its kind's mark, its title and
 * when it last changed. A row opens that artifact in the right rail. Draws
 * nothing for a Canvas with no artifacts.
 */
export function CanvasArtifactsSection({ artifacts, onOpen }: {
  artifacts: readonly CanvasArtifact[];
  onOpen: (artifact: CanvasArtifact) => void;
}): React.JSX.Element | null {
  const labelId = useId();
  if (artifacts.length === 0) return null;
  return <>
    <TitleMenuSeparator />
    <DropdownMenu.Group aria-labelledby={labelId} className="canvas-artifacts">
      <DropdownMenu.Label className="menu-label workspace-menu-section" id={labelId}>Artifacts</DropdownMenu.Label>
      {artifacts.map((artifact) => {
        const Glyph = resourceGlyph(artifactResource(artifact));
        return <TitleMenuItem
            key={artifact.resourceId}
            icon={<Glyph aria-hidden="true" size={16} strokeWidth={1.8} />}
            onSelect={() => onOpen(artifact)}
          >
            <span className="title-menu-item-copy">{artifact.title}</span>
            <span className="title-menu-level-meta">{formatRelative(artifact.updatedAt)}</span>
          </TitleMenuItem>;
      })}
    </DropdownMenu.Group>
  </>;
}
