import type { CanvasArtifact } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { resourceGlyph } from '@rally/ui/components/resource-icon';
import { TitleMenuItem, TitleMenuSeparator } from '@rally/ui/components/title-pill';
import { useId } from 'react';

import { formatRelative } from '../lib/format';

/**
 * The resource shape `resourceGlyph` reads, from a Canvas artifact's kind: a
 * site under the wire's site type, so it draws the page mark whatever MIME it
 * carries; a file or an archive by its MIME and title, as a rail row is.
 */
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
export function CanvasArtifactsSection({ artifacts, disabled = false, onOpen }: {
  artifacts: readonly CanvasArtifact[];
  disabled?: boolean;
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
            disabled={disabled}
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
