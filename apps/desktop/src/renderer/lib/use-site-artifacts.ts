import { useAnnotationDraft } from '../components/artifact-annotations';
import { useMemo } from 'react';

import type { RallyApi } from './api';
import { useShellCapabilities } from './collaboration-session';
import { desktopBridge } from './platform';

/**
 * Everything the live-artifact detail needs, or `undefined`: one builder for
 * every surface that opens an artifact panel, a thread's and a Channel's.
 *
 * Always on: a Canvas is built on these surfaces, so there is no flag that
 * hides them. `undefined` means only that this surface cannot host them — no
 * API session to mint access, or no bridge to present through — and the rail
 * then renders a site as the ordinary resource card, which still lists,
 * versions, and removes it.
 */
/** The three reads a site surface needs: access, its data shape, and a table. */
export type SiteArtifactsApi = Pick<RallyApi, 'openArtifact' | 'describeArtifactData' | 'readArtifactTable'>;

export function useSiteArtifacts(api: SiteArtifactsApi | null) {
  const annotationDraft = useAnnotationDraft();
  const { host } = useShellCapabilities();
  const browserHost = host === 'browser';
  return useMemo(() => {
    if (!api) return undefined;
    const bridge = window.rally ?? (browserHost ? desktopBridge() : undefined);
    if (!bridge) return undefined;
    return {
      openArtifact: (resourceId: string) => api.openArtifact(resourceId),
      describeData: (resourceId: string) => api.describeArtifactData(resourceId),
      loadTable: (resourceId: string, table: string) => api.readArtifactTable(resourceId, table),
      surface: {
        present: bridge.presentArtifactPreview,
        setBounds: bridge.setArtifactPreviewBounds,
        snapshot: bridge.snapshotArtifactPreview,
        ready: bridge.artifactPreviewReady,
        pick: bridge.pickArtifactPreview,
        comments: bridge.showArtifactPreviewComments,
        stopPicking: bridge.stopPickingArtifactPreview,
        close: bridge.closeArtifactPreview,
        popOut: (request: Parameters<typeof bridge.popOutArtifact>[0]) => bridge.popOutArtifact({ ...request, ...(annotationDraft?.scopeKey ? { annotationScope: annotationDraft.scopeKey } : {}) }),
        copyText: bridge.copyText,
        openExternal: bridge.openExternal,
        // A browser has no main process to composite a view: it frames the
        // artifact instead. allow-same-origin keeps the artifact in its own
        // origin (not an opaque one), which its code redemption needs; the
        // frame still cannot navigate the app or open popups.
        ...(browserHost ? { framed: true as const } : {}),
      },
    };
  }, [browserHost, api, annotationDraft?.scopeKey]);
}
