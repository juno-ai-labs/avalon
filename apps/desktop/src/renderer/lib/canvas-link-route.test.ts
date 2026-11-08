import { parseDesktopDeepLinkIntent } from '@rally/contracts/desktop-deep-link-intent';
import { canvasDeepLink } from '@rally/contracts/links';
import { describe, expect, it } from 'vitest';

import { canvasLinkRoute } from './canvases';

const WORKSPACE = '00000000-0000-7000-8000-000000000019';
const CANVAS = '00000000-0000-7000-8000-000000000021';
const TURN = '00000000-0000-7000-8000-000000000024';
const ARTIFACT = '00000000-0000-7000-8000-000000000023';

/** The route a Mac deep link opens, as the app session reads one. */
function routeOf(link: string): string {
  const intent = parseDesktopDeepLinkIntent(link);
  if (intent?.kind !== 'canvas') throw new Error(`not a Canvas link: ${link}`);
  return canvasLinkRoute(intent);
}

describe('the route a Canvas link opens', () => {
  it('opens at the message a push names, onto an artifact, or the Canvas itself', () => {
    const target = { region: 'global', workspaceId: WORKSPACE, canvasId: CANVAS };
    expect(routeOf(canvasDeepLink({ ...target, turnId: TURN, sequence: 12 })))
      .toBe(`/canvases/${CANVAS}?turn=${TURN}&sequence=12`);
    expect(routeOf(canvasDeepLink({ ...target, artifactId: ARTIFACT }))).toBe(`/canvases/${CANVAS}?artifact=${ARTIFACT}`);
    expect(routeOf(canvasDeepLink(target))).toBe(`/canvases/${CANVAS}`);
  });
});
