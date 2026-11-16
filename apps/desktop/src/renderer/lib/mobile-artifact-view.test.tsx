import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ArtifactView } from '../../../../mobile/src/CanvasWebView';

// The native WebView cannot run in jsdom. Exercise the actual shell handlers
// at its callback boundary with the DOM harness's React instance.
vi.mock('../../../../mobile/node_modules/react', async () => import('react'));
vi.mock('../../../../mobile/node_modules/expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('../../../../mobile/node_modules/expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }) }));
vi.mock('../../../../mobile/src/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
vi.mock('../../../../mobile/src/diagnostics', () => ({ recordFailure: () => undefined }));
const native = vi.hoisted(() => ({
  openURL: vi.fn(),
  callbacks: null as null | {
    onShouldStartLoadWithRequest: (request: { url: string; isTopFrame?: boolean; navigationType: string }) => boolean;
    onHttpError: (event: { nativeEvent: { url: string; statusCode: number } }) => void;
  },
}));
vi.mock('../../../../mobile/node_modules/react-native', () => ({
  Linking: { openURL: native.openURL }, Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => <button onClick={onPress}>{children}</button>,
  ActivityIndicator: () => <span>Loading</span>,
}));
vi.mock('../../../../mobile/node_modules/react-native-webview', () => ({
  WebView: (props: NonNullable<typeof native.callbacks>) => { native.callbacks = props; return null; },
}));

it('cancels an expired-cookie handoff, renews once, and exposes failure if fresh access is refused', () => {
  const appUrl = 'https://app.rallywith.ai';
  const canonicalUrl = 'https://level-luminous-sequential-schrodinger-g.rallyusercontent.com/';
  const access = { canvasId: 'canvas', resourceId: 'resource', version: 1, canonicalUrl, openUrl: canonicalUrl };
  const handoff = { url: appUrl + '/app/sites/global/level-luminous-sequential-schrodinger/%2F', isTopFrame: true, navigationType: 'other' };
  const retry = vi.fn();
  const view = render(<ArtifactView access={access} appUrl={appUrl} background="#fff" topInset={64} onRetry={retry} />);
  act(() => {
    expect(native.callbacks!.onShouldStartLoadWithRequest(handoff)).toBe(false);
    expect(native.callbacks!.onShouldStartLoadWithRequest(handoff)).toBe(false);
    native.callbacks!.onHttpError({ nativeEvent: { url: canonicalUrl, statusCode: 401 } });
  });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(native.openURL).not.toHaveBeenCalled();
  view.unmount();
  const fresh = render(<ArtifactView access={{ ...access, openUrl: canonicalUrl + '__rally/open#fresh' }} appUrl={appUrl} background="#fff" topInset={64} onRetry={retry} />);
  act(() => { expect(native.callbacks!.onShouldStartLoadWithRequest(handoff)).toBe(false); });
  expect(fresh.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(retry).toHaveBeenCalledTimes(1);
  expect(native.openURL).not.toHaveBeenCalled();
  fresh.unmount();
});
