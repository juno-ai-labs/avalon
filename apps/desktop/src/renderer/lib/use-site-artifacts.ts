import { useAnnotationDraft } from '../components/artifact-annotations';
import { useMemo } from 'react';

import type { RallyApi } from './api';
import { useShellCapabilities } from './collaboration-session';
import { desktopBridge } from './platform';
import { useClientFeatureFlags } from './use-client-feature-flags';

/**
 * Everything the live-artifact detail needs, or `undefined`: one builder for
 * every surface that opens an artifact panel, a thread's and a Channel's.
 *
 * `undefined` is how the feature is off — the rail then renders a site as the
 * ordinary resource card, which still lists, versions, and removes it. The
 * flag gates presentation only: an artifact's authorization is structural and
 * holds whether or not this is passed.
 */
export function useSiteArtifacts(api: RallyApi | null) {
  const annotationDraft = useAnnotationDraft();
  const { host } = useShellCapabilities();
  const featureFlags = useClientFeatureFlags(api);
  const browserHost = host === 'browser';
  return useMemo(() => {
    if (!api || featureFlags.data?.liveArtifactsEnabled !== true) return undefined;
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
  }, [browserHost, api, featureFlags.data?.liveArtifactsEnabled, annotationDraft?.scopeKey]);
}
