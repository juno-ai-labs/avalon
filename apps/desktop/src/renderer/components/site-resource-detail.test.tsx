import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { TitlePill } from '@rally/ui/components/title-pill';
import { Toast } from '@rally/ui/components/toast';
import { describe, expect, it, vi } from 'vitest';

import { AnnotationDraftProvider, useAnnotationDraft } from './artifact-annotations';
import { DetailActionMenu, DetailHeaderActionsHost, type DetailHeaderAction } from './detail-header-actions';
import { IconGroup } from '@rally/ui/components/icon-group';
import {
  formatCell,
  SiteResourceDetail,
  type SiteArtifactAccess,
  type SiteResourceDetailProps,
} from './site-resource-detail';

const ARTIFACT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const RESOURCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const OTHER_RESOURCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const OPEN_URL = `https://${ARTIFACT}-g.rallyusercontent.test/__rally/open#code`;
const CANONICAL = `https://${ARTIFACT}-g.rallyusercontent.test`;

function surface(overrides: Partial<SiteResourceDetailProps['surface']> = {}) {
  return {
    present: vi.fn(async () => true),
    setBounds: vi.fn(async () => undefined),
    snapshot: vi.fn(async (): Promise<string | null> => 'data:image/jpeg;base64,c3RpbGw='),
    close: vi.fn(async () => undefined),
    popOut: vi.fn(async () => true),
    copyText: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    ...overrides,
  };
}

/**
 * Every mint returns a *different* code, because the real one is single-use.
 * A surface that reused an earlier code would be indistinguishable from a
 * correct one against a constant fixture — and that is the single-use URL bug
 * these navigation tests pin, so the fixture must tell them apart.
 */
function mintingAccess() {
  let minted = 0;
  return vi.fn(async (): Promise<SiteArtifactAccess> => {
    minted += 1;
    return {
      openUrl: `https://${ARTIFACT}-g.rallyusercontent.test/__rally/open#code-${minted}`,
      canonicalUrl: CANONICAL,
      artifactId: ARTIFACT,
      mode: 'active',
      stateful: true,
    };
  });
}

function setup(overrides: Partial<SiteResourceDetailProps> = {}, options: { strict?: boolean } = {}) {
  const props: SiteResourceDetailProps = {
    resourceId: RESOURCE,
    version: 4,
    title: 'Offsite RSVP',
    openArtifact: mintingAccess(),
    describeData: vi.fn(async () => ({
      tables: [{
        name: 'rsvps',
        columns: [{ name: 'name', type: 'TEXT' }, { name: 'answer', type: 'TEXT' }],
        rowCount: 2,
      }],
    })),
    loadTable: vi.fn(async () => ({
      rows: [{ name: 'Ada', answer: 'yes' }, { name: 'Grace', answer: null }],
      csv: '"name","answer"\r\n"Ada","yes"\r\n"Grace",""',
    })),
    surface: surface(),
    ...overrides,
  };
  const detail = <AnnotationDraftProvider><Harness props={props} /></AnnotationDraftProvider>;
  return {
    props,
    ...render(options.strict ? <React.StrictMode>{detail}</React.StrictMode> : detail),
  };
}

/**
 * The detail as its host mounts it: a header `IconGroup` drawing the actions it
 * declares, and the tooltip provider the application keeps at its root.
 */
/** Open the same lazy menu section that an artifact host renders. */
function storedDataToggle(): HTMLElement {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Artifact data menu' }), { button: 0, ctrlKey: false });
  return screen.getByRole('menuitem', { name: 'Stored data' });
}

function SitePins(): React.JSX.Element { const draft=useAnnotationDraft();return <output data-testid="site-pins">{JSON.stringify(draft?.selections.map((pin)=>pin.annotation))}</output>; }

function Harness({ props }: { props: SiteResourceDetailProps }): React.JSX.Element {
  const [actions, setActions] = React.useState<readonly DetailHeaderAction[]>([]);
  return (
    <Tooltip.Provider>
      <div data-testid="host-header"><IconGroup actions={actions.filter((action) => action.menu === undefined)} /><TitlePill level={{key: props.resourceId, title: props.title, icon: null, label: 'Artifact data menu', menu: <DetailActionMenu actions={actions} />}} /></div>
      <DetailHeaderActionsHost onActions={setActions}>
        <SiteResourceDetail {...props} /><SitePins />
      </DetailHeaderActionsHost>
    </Tooltip.Provider>
  );
}

describe('showing a live artifact in the rail', () => {
  it('keeps a toast above the native preview and restores the page after dismissal', async () => {
    // Geometry and the native surface are absent in jsdom. Exercise the real
    // Toast and detail against a measured pane; Electron verifies composition.
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    const { props } = setup();
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 500, height: 320 }), { timeout: 5_000 });
    const toast = render(<Toast open>Copied</Toast>);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }), { timeout: 5_000 });
    expect(screen.getByTestId('site-preview-pane').querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,c3RpbGw=');
    toast.rerender(<Toast open={false}>Copied</Toast>);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 500, height: 320 }), { timeout: 5_000 });
    geometry.mockRestore();
  });

  describe('a browser host\u2019s framed site', () => {
    const PIN = {css:'main > button:nth-of-type(1)',html:'<button>RSVP</button>',visibleText:'RSVP',pagePath:'/',replace:false,box:{x:0,y:0,w:0.5,h:0.1},point:{x:40,y:30}};
    /** A message as the frame's document would post it, or as something else would. */
    function fromFrame(frame: HTMLIFrameElement, data: unknown, overrides: { source?: Window | null; origin?: string } = {}): void {
      fireEvent(window, new MessageEvent('message', { data, source: overrides.source === undefined ? frame.contentWindow : overrides.source, origin: overrides.origin ?? CANONICAL }));
    }
    async function framedSite() {
      const result = setup({surface:surface({framed:true})});
      const frame = await screen.findByTitle('Offsite RSVP') as HTMLIFrameElement;
      const posted = vi.spyOn(frame.contentWindow!, 'postMessage');
      return { ...result, frame, posted };
    }

    it('offers Comment mode once the page announces the annotation script, and tells it to pick', async () => {
      const { frame, posted } = await framedSite();
      fireEvent.load(frame);
      const button = screen.getByRole('button', { name: 'Comment mode' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fromFrame(frame, { type: 'rally-annotation-ready', pagePath: '/' });
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(posted).toHaveBeenCalledWith({ type: 'rally-annotation-picking', on: true }, CANONICAL);
    });

    it('keeps the control disabled on a page without the script, such as a refusal', async () => {
      const { frame } = await framedSite();
      fireEvent.load(frame);
      const button = screen.getByRole('button', { name: 'Comment mode' });
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    it('adds a pin the frame reports while picking and opens its comment editor', async () => {
      const { frame } = await framedSite();
      fromFrame(frame, { type: 'rally-annotation-ready', pagePath: '/' });
      fireEvent.load(frame);
      const button = screen.getByRole('button', { name: 'Comment mode' });
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      fireEvent.click(button);
      const viewport = { width: 416, height: 500, scrollX: 0, scrollY: 40, devicePixelRatio: 2, colorScheme: 'light' };
      fromFrame(frame, { type: 'rally-artifact-pin', pin: { ...PIN, viewport } });
      const editor = await screen.findByRole('textbox', { name: 'Comment on site selection' });
      expect(editor).toBeVisible();
      expect(screen.getByTestId('site-pins')).toHaveTextContent('<button>RSVP</button>');
      // The window the person saw travels with the pin, for an agent with no screenshot.
      expect(JSON.parse(screen.getByTestId('site-pins').textContent ?? '[]')[0].target.locator.viewport).toEqual(viewport);
      // Escape inside the page ends picking the same way as in the app: the
      // unfinished pin and its editor go with it.
      fromFrame(frame, { type: 'rally-artifact-pin', pin: null });
      await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
      expect(screen.queryByRole('textbox', { name: 'Comment on site selection' })).toBeNull();
      expect(screen.getByTestId('site-pins')).toHaveTextContent('[]');
    });

    it('keeps the editor beside its element as the page scrolls and tells the page which selection is open', async () => {
      const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 200, y: 60, width: 460, height: 800 }));
      const { frame, posted } = await framedSite();
      fromFrame(frame, { type: 'rally-annotation-ready', pagePath: '/' });
      fireEvent.load(frame);
      const button = screen.getByRole('button', { name: 'Comment mode' });
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      fireEvent.click(button);
      fromFrame(frame, { type: 'rally-artifact-pin', pin: { ...PIN, rect: { x: 20, y: 100, width: 80, height: 30 } } });
      const editor = await screen.findByRole('dialog', { name: 'Comment on site selection' });
      expect(editor.style.top).toBe('160px');
      await waitFor(() => expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'rally-annotation-comments', selected: PIN.css }), CANONICAL));
      fromFrame(frame, { type: 'rally-annotation-anchor', rect: { x: 20, y: 300, width: 80, height: 30 } });
      await waitFor(() => expect(editor.style.top).toBe('360px'));
      geometry.mockRestore();
    });

    it('ignores pins from another window, another origin, with Comment mode off, or carrying image bytes', async () => {
      const { frame } = await framedSite();
      fromFrame(frame, { type: 'rally-annotation-ready', pagePath: '/' });
      fireEvent.load(frame);
      const button = screen.getByRole('button', { name: 'Comment mode' });
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
      fromFrame(frame, { type: 'rally-artifact-pin', pin: PIN });
      fireEvent.click(button);
      fromFrame(frame, { type: 'rally-artifact-pin', pin: PIN }, { source: window });
      fromFrame(frame, { type: 'rally-artifact-pin', pin: PIN }, { origin: 'https://other-g.rallyusercontent.test' });
      fromFrame(frame, { type: 'rally-artifact-pin', pin: { ...PIN, screenshot: 'data:image/png;base64,AAAA' } });
      await Promise.resolve();
      expect(screen.queryByRole('textbox', { name: 'Comment on site selection' })).toBeNull();
      expect(screen.getByTestId('site-pins')).toHaveTextContent('[]');
    });
  });
  it('discards an unfinished native-site comment through the capture-phase Escape handler', async () => {
    const pick=vi.fn<NonNullable<SiteResourceDetailProps['surface']['pick']>>()
      .mockResolvedValueOnce({css:'p',html:'<p>RSVP</p>',visibleText:'RSVP',pagePath:'/',replace:false,box:{x:0,y:0,w:1,h:1}})
      .mockImplementation(()=>new Promise(()=>{}));
    setup({surface:surface({pick})});
    const button=await screen.findByRole('button',{name:'Comment mode'});
    await waitFor(()=>expect(button).not.toBeDisabled());
    fireEvent.click(button);
    const editor=await screen.findByRole('textbox',{name:'Comment on site selection'});
    fireEvent.change(editor,{target:{value:'Unfinished native comment'}});
    expect(screen.getByTestId('site-pins')).toHaveTextContent('Unfinished native comment');
    fireEvent.keyDown(editor,{key:'Escape'});
    expect(screen.getByTestId('site-pins')).toHaveTextContent('[]');
    expect(screen.queryByRole('dialog',{name:'Comment on site selection'})).toBeNull();
  });
  it.each(['dialog', 'alertdialog', 'menu', 'tooltip'])('keeps the native preview below a %s and restores it when it closes', async (role) => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    const { props } = setup();
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalledWith({ x: 20, y: 40, width: 500, height: 320 }));
    const overlay = document.createElement('div');
    overlay.setAttribute('role', role);
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }));
    overlay.remove();
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 500, height: 320 }));
    geometry.mockRestore();
  });

  it('leaves the live preview running for a tooltip outside its pane', async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 200, y: 100, width: 500, height: 320 }),
    );
    const { props } = setup();
    const bounds = { x: 200, y: 100, width: 500, height: 320 };
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalledWith(bounds));
    const tooltip = document.createElement('div');
    tooltip.setAttribute('role', 'tooltip');
    tooltip.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 150, height: 50 });
    await act(async () => { document.body.append(tooltip); });
    expect(props.surface.snapshot).not.toHaveBeenCalled();
    expect(props.surface.setBounds).toHaveBeenLastCalledWith(bounds);
    tooltip.remove();
    geometry.mockRestore();
  });

  it('rechecks a tooltip after Radix positions it and measures its visible wrapper', async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 200, y: 100, width: 500, height: 320 }),
    );
    const { props } = setup();
    const bounds = { x: 200, y: 100, width: 500, height: 320 };
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalledWith(bounds));
    // Radix can put role=tooltip on a hidden accessible label inside the
    // visible content. Only the popper wrapper describes what covers the site.
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    wrapper.style.transform = 'translate(0px, -200px)';
    wrapper.getBoundingClientRect = () => DOMRect.fromRect({
      x: 150, y: wrapper.style.transform === 'translate(0px, -200px)' ? -200 : 80, width: 100, height: 60,
    });
    const content = document.createElement('div');
    content.setAttribute('data-state', 'instant-open');
    const tooltip = document.createElement('span');
    tooltip.setAttribute('role', 'tooltip');
    tooltip.getBoundingClientRect = () => DOMRect.fromRect({ x: 150, y: 80, width: 1, height: 1 });
    content.append(tooltip);
    wrapper.append(content);
    await act(async () => { document.body.append(wrapper); });
    expect(props.surface.snapshot).not.toHaveBeenCalled();
    wrapper.style.transform = 'translate(150px, 80px)';
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }));
    // A closing tooltip may remain mounted for its exit animation.
    content.setAttribute('data-state', 'closed');
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith(bounds));
    wrapper.remove();
    geometry.mockRestore();
  });

  it('keeps the page in view under a nested dialog by showing a still taken before the view hides', async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    // What the pane held at the moment each hide was sent: the still has to be
    // on screen by then, or the pane shows empty until React catches up.
    const stillAtHide: (string | null)[] = [];
    const { props } = setup({
      surface: surface({
        setBounds: vi.fn(async (bounds: { x: number; y: number; width: number; height: number }) => {
          if (bounds.width === 0) {
            stillAtHide.push(document.querySelector('[data-testid="site-preview-pane"] img')?.getAttribute('src') ?? null);
          }
        }),
      }),
    });
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalledWith({ x: 20, y: 40, width: 500, height: 320 }));
    const pane = screen.getByTestId('site-preview-pane');
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'menu');
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }));
    expect(stillAtHide).toEqual(['data:image/jpeg;base64,c3RpbGw=']);
    // Taken while the view was still showing.
    const snapshot = vi.mocked(props.surface.snapshot);
    const hide = vi.mocked(props.surface.setBounds).mock.calls.findIndex(([bounds]) => bounds.width === 0);
    expect(snapshot.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(props.surface.setBounds).mock.invocationCallOrder[hide]!);
    overlay.remove();
    await waitFor(() => expect(pane.querySelector('img')).toBeNull());
    expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 500, height: 320 });
    geometry.mockRestore();
  });

  it('holds the hide for the still, and keeps the still until the view is back', async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    let finishCapture: (image: string | null) => void = () => undefined;
    let finishRestore: () => void = () => undefined;
    const sent: { width: number }[] = [];
    const { props } = setup({
      surface: surface({
        snapshot: vi.fn(async () => await new Promise<string | null>((resolve) => { finishCapture = resolve; })),
        setBounds: vi.fn(async (bounds: { x: number; y: number; width: number; height: number }) => {
          sent.push(bounds);
          // Only the restore after the overlay is held, so the test can look
          // at the pane while the view is not back yet.
          if (bounds.width > 0 && sent.some((earlier) => earlier.width === 0)) {
            await new Promise<void>((resolve) => { finishRestore = resolve; });
          }
        }),
      }),
    });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.snapshot).toHaveBeenCalledOnce());
    // More mutations while the still is being taken must neither collapse the
    // view early nor start a second capture.
    overlay.setAttribute('data-state', 'open');
    window.dispatchEvent(new Event('resize'));
    await act(async () => { await Promise.resolve(); });
    expect(sent.filter((bounds) => bounds.width === 0)).toHaveLength(0);
    expect(props.surface.snapshot).toHaveBeenCalledOnce();

    await act(async () => { finishCapture('data:image/jpeg;base64,c3RpbGw='); });
    await waitFor(() => expect(sent.at(-1)).toEqual({ x: 0, y: 0, width: 0, height: 0 }));
    const still = screen.getByTestId('site-preview-pane').querySelector('img');
    expect(still?.style.width).toBe('500px');
    expect(still?.style.height).toBe('320px');

    overlay.remove();
    await waitFor(() => expect(sent.at(-1)).toEqual({ x: 20, y: 40, width: 500, height: 320 }));
    expect(screen.getByTestId('site-preview-pane').querySelector('img')).not.toBeNull();
    await act(async () => { finishRestore(); });
    await waitFor(() => expect(screen.getByTestId('site-preview-pane').querySelector('img')).toBeNull());
    geometry.mockRestore();
  });

  it('hides the view without a still when the capture does not come back', async () => {
    // A hung capture must not keep the menu under the view: past the wait the
    // hide goes out anyway, and the pane is blank as it was before stills.
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    const { props } = setup({
      surface: surface({ snapshot: vi.fn(async () => await new Promise<string | null>(() => undefined)) }),
    });
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalled());
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'menu');
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }));
    expect(screen.getByTestId('site-preview-pane').querySelector('img')).toBeNull();
    overlay.remove();
    geometry.mockRestore();
  });

  it('leaves the view up when the overlay closes before the still is taken', async () => {
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 40, width: 500, height: 320 }),
    );
    let finishCapture: (image: string | null) => void = () => undefined;
    const { props } = setup({
      surface: surface({
        snapshot: vi.fn(async () => await new Promise<string | null>((resolve) => { finishCapture = resolve; })),
      }),
    });
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenCalled());
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'menu');
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.snapshot).toHaveBeenCalledOnce());
    overlay.remove();
    await act(async () => { finishCapture('data:image/jpeg;base64,c3RpbGw='); });
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 500, height: 320 }));
    expect(props.surface.setBounds).not.toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    expect(screen.getByTestId('site-preview-pane').querySelector('img')).toBeNull();
    geometry.mockRestore();
  });

  it('hands the pane to the main process rather than embedding anything', async () => {
    // The renderer measures a rectangle and gets out of the way; it never
    // embeds artifact content itself.
    const { props } = setup({}, { strict: true });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(props.surface.present).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT,
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    }));
    expect(props.openArtifact).toHaveBeenCalledOnce();
  });

  it('frames the artifact in a browser host instead of asking a main process to composite it', async () => {
    const { props } = setup({ surface: surface({ framed: true }) }, { strict: true });
    const frame = await screen.findByTitle('Offsite RSVP');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    expect(frame.getAttribute('src')).toMatch(/__rally\/open#code-\d+$/u);
    expect(props.surface.present).not.toHaveBeenCalled();
    expect(screen.queryByText('Preview unavailable here')).toBeNull();
  });

  it('keeps its own “Opening…” until the composited page is ready, not just the access', async () => {
    // The main process holds the view hidden over the redeem bootstrap and
    // answers once the site is ready; the pane must not go blank meanwhile.
    let showPage!: (shown: boolean) => void;
    const present = vi.fn(async () => await new Promise<boolean>((resolve) => { showPage = resolve; }));
    setup({ surface: surface({ present }) });
    await waitFor(() => expect(present).toHaveBeenCalled());
    expect(screen.getByText('Opening…')).toBeInTheDocument();
    await act(async () => { showPage(true); });
    expect(screen.queryByText('Opening…')).toBeNull();
  });

  it('reports a dialog opened while the page is still loading, before the view is revealed', async () => {
    // The main process reveals the view at the last bounds it was sent, so a
    // dialog that opened during the load must have collapsed them already.
    const present = vi.fn(async () => await new Promise<boolean>(() => undefined));
    const { props } = setup({ surface: surface({ present }) });
    await waitFor(() => expect(present).toHaveBeenCalled());
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    document.body.append(overlay);
    await waitFor(() => expect(props.surface.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }));
    overlay.remove();
  });

  it('hides a browser host’s frame behind “Opening…” until the frame loads', async () => {
    // The frame first holds the bootstrap, which has an "Opening…" of its own.
    // Its `load` is the site's: the bootstrap is replaced before it fires one.
    setup({ surface: surface({ framed: true }) });
    const frame = await screen.findByTitle('Offsite RSVP');
    expect(frame).toHaveAttribute('data-loading');
    expect(screen.getByText('Opening…')).toBeInTheDocument();
    fireEvent.load(frame);
    expect(frame).not.toHaveAttribute('data-loading');
    expect(screen.queryByText('Opening…')).toBeNull();
  });

  it('remints and replaces the native preview when a new version is published', async () => {
    const openArtifact = mintingAccess();
    const { props, rerender } = setup({ openArtifact, version: 4 });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalledTimes(1));
    const firstUrl = vi.mocked(props.surface.present).mock.calls[0]?.[0]?.url;

    rerender(<Harness props={{ ...props, version: 5 }} />);

    await waitFor(() => expect(props.surface.present).toHaveBeenCalledTimes(2));
    expect(props.surface.close).toHaveBeenCalled();
    expect(vi.mocked(props.surface.present).mock.calls[1]?.[0]?.url).not.toBe(firstUrl);
  });

  it('gives every navigating surface its own code, because redemption spends it', async () => {
    // Redemption clears the code in the same statement that reads it, so a
    // second surface handed the first one redeems nothing and lands on the
    // neutral page. Open in a new window and Open in browser were both dead this way.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const presented = vi.mocked(props.surface.present).mock.calls[0]?.[0]?.url;

    fireEvent.click(screen.getByRole('button', { name: 'Open in a new window' }));
    await waitFor(() => expect(props.surface.popOut).toHaveBeenCalled());
    const poppedOut = vi.mocked(props.surface.popOut).mock.calls[0]?.[0]?.url;

    fireEvent.click(screen.getByRole('button', { name: /open in browser/i }));
    await waitFor(() => expect(props.surface.openExternal).toHaveBeenCalled());
    const external = vi.mocked(props.surface.openExternal).mock.calls[0]?.[0];

    expect(presented).toBeDefined();
    expect(new Set([presented, poppedOut, external]).size).toBe(3);
  });

  it('pairs the initial navigation URL with the artifact identity returned alongside it', async () => {
    // The URL origin and artifact id enforce different halves of the native
    // viewer's isolation. They must come from one access response rather than
    // combining a fresh URL with identity retained from an earlier response.
    const navigationArtifact = '3f2504e0-4f89-41d3-9a0c-0305e82c3399';
    const openArtifact = vi.fn().mockResolvedValue({
      openUrl: `https://${navigationArtifact}-g.rallyusercontent.test/__rally/open#fresh-code`,
      canonicalUrl: `https://${navigationArtifact}-g.rallyusercontent.test`,
      artifactId: navigationArtifact,
      mode: 'active' as const,
      stateful: true,
    });
    const { props } = setup({ openArtifact });

    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(props.surface.present).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: navigationArtifact,
      url: expect.stringContaining(navigationArtifact),
    }));
    expect(openArtifact).toHaveBeenCalledOnce();
  });

  it('opens a resource switched into the mounted detail only once', async () => {
    const switchedArtifact = '3f2504e0-4f89-41d3-9a0c-0305e82c3398';
    const switchedOpen = vi.fn(async (): Promise<SiteArtifactAccess> => ({
      openUrl: `https://${switchedArtifact}-g.rallyusercontent.test/__rally/open#switched-code`,
      canonicalUrl: `https://${switchedArtifact}-g.rallyusercontent.test`,
      artifactId: switchedArtifact,
      mode: 'active',
      stateful: false,
    }));
    const { props, rerender } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalledOnce());

    rerender(<Harness props={{ ...props, resourceId: OTHER_RESOURCE, openArtifact: switchedOpen }} />);

    await waitFor(() => expect(props.surface.present).toHaveBeenCalledTimes(2));
    expect(switchedOpen).toHaveBeenCalledOnce();
    expect(props.surface.present).toHaveBeenLastCalledWith(expect.objectContaining({
      artifactId: switchedArtifact,
      url: expect.stringContaining('#switched-code'),
    }));
  });

  it('shows the unavailable state when the preview cannot be presented at all', async () => {
    // A rejected mint or a main process that cannot composite leaves the
    // tri-state at `null` unless this path sets it — an empty bordered box
    // with no message and no way out.
    const { props } = setup({
      surface: surface({ present: vi.fn(async () => { throw new Error('no view'); }) }),
    });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(await screen.findByText(/preview unavailable here/i)).toBeTruthy();
  });

  it('renders nothing into the pane while a view is composited over it', async () => {
    // The view covers the rectangle, so anything drawn here would be either
    // invisible or peeking out from behind model-authored content.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('site-preview-pane').textContent).toBe(''));
  });

  it('never flashes its unavailable state on a preview that is about to work', async () => {
    // The gap between access arriving and the main process answering is not a
    // failure, and a boolean could not tell the two apart — which is why the
    // component tracks "not attempted" separately from "refused".
    let answer: ((shown: boolean) => void) | null = null;
    const pending = new Promise<boolean>((resolve) => { answer = resolve; });
    setup({ surface: surface({ present: vi.fn(() => pending) }) });
    await waitFor(() => expect(answer).not.toBeNull());
    expect(screen.queryByText('Preview unavailable here')).not.toBeInTheDocument();
    answer!(true);
    await waitFor(() => expect(screen.getByTestId('site-preview-pane').textContent).toBe(''));
  });

  it('falls back to a legible state where nothing can be composited', async () => {
    // The browser build, or a URL the main process refused.
    setup({ surface: surface({ present: vi.fn(async () => false) }) });
    expect(await screen.findByText('Preview unavailable here')).toBeInTheDocument();
    expect(screen.getByText(/Open it in your browser/u)).toBeInTheDocument();
  });

  it('does not say the artifact\u2019s name again under the header that carries it', async () => {
    // The rail and the lightbox both draw the resource title in their header.
    // A second copy here made the lightbox open on the same words twice.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    expect(within(document.querySelector('.site-detail')!).queryByText('Offsite RSVP')).not.toBeInTheDocument();
  });

  it('says so plainly when the artifact could not be opened', async () => {
    setup({ openArtifact: vi.fn(async () => { throw new Error('You can no longer see this channel.'); }) });
    expect(await screen.findByText('This site could not be opened')).toBeInTheDocument();
    expect(screen.getByText('You can no longer see this channel.')).toBeInTheDocument();
  });

  it('tears the preview down when it goes away', async () => {
    const { props, unmount } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    unmount();
    expect(props.surface.close).toHaveBeenCalled();
  });

  it('does not present after it goes away while opening the artifact', async () => {
    // Switching Channels unmounts this detail. If its initial open finishes
    // afterwards, presenting then would resurrect the old native view after
    // the cleanup has already tried to close it.
    let finishMint: ((access: SiteArtifactAccess) => void) | undefined;
    const openArtifact = vi.fn(() => new Promise<SiteArtifactAccess>((resolve) => {
      finishMint = resolve;
    }));
    const previewSurface = surface();
    const { unmount } = setup({ openArtifact, surface: previewSurface });
    await waitFor(() => expect(openArtifact).toHaveBeenCalledOnce());

    unmount();
    await act(async () => finishMint?.({
      openUrl: `${OPEN_URL}-late`,
      canonicalUrl: CANONICAL,
      artifactId: ARTIFACT,
      mode: 'active',
      stateful: true,
    }));

    // No surface existed to close, and the late continuation must not create
    // one after the detail has gone away.
    expect(previewSurface.close).not.toHaveBeenCalled();
    expect(previewSurface.present).not.toHaveBeenCalled();
  });
});

describe('the actions the host draws in its header', () => {
  it('puts them in the header slot rather than over the page', async () => {
    // Drawn in the body they read as part of the artifact being previewed,
    // which is the reason the host offers a slot at all.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const header = within(screen.getByTestId('host-header'));
    for (const name of [/Open in a new window/u, /Copy public link/u, /Open in browser/u]) {
      const action = header.getByRole('button', { name });
      expect(action).toBeInTheDocument();
      // Every one of them is an icon alone, so every one of them owes a
      // tooltip: `data-state` is the trigger Radix wraps it in, and a button
      // that opted out of its tooltip carries no such attribute.
      expect(action).toHaveAttribute('data-state');
    }
  });

  it('labels and copies the canonical public link, which carries no access code', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Copy public link/u }));
    expect(props.surface.copyText).toHaveBeenCalledWith(CANONICAL);
    expect(props.surface.copyText).not.toHaveBeenCalledWith(expect.stringContaining('#'));
  });

  it('pops out the artifact with its own access url', async () => {
    // Named for what it always claimed and did not do: this asserted the URL
    // the preview had already spent, which is why Open in a new window landed on the
    // neutral page rather than the site.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const presented = vi.mocked(props.surface.present).mock.calls[0]?.[0]?.url;
    fireEvent.click(screen.getByRole('button', { name: 'Open in a new window' }));
    await waitFor(() => expect(props.surface.popOut).toHaveBeenCalled());
    expect(props.surface.popOut).toHaveBeenCalledWith({
      kind: 'site', editable: false,
      resourceId: RESOURCE,
      version: 4,
      artifactId: ARTIFACT,
      url: expect.stringContaining('/__rally/open#'),
      canonicalUrl: CANONICAL,
      mode: 'active',
      stateful: true,
      title: 'Offsite RSVP',
    });
    expect(vi.mocked(props.surface.popOut).mock.calls[0]?.[0]?.url).not.toBe(presented);
  });

  it('keeps every action disabled until access exists', () => {
    setup({ openArtifact: vi.fn(() => new Promise<SiteArtifactAccess>(() => undefined)) });
    for (const name of [/Open in a new window/u, /Copy public link/u, /Open in browser/u]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('the data a stateful site collected', () => {
  it('retains keyboard focus while stored data loads and when its controls arrive', async () => {
    let resolve!: (value: { tables: [] }) => void;
    const pending = new Promise<{ tables: [] }>((done) => { resolve = done; });
    const { props } = setup({ describeData: () => pending });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const row = storedDataToggle();
    row.focus();
    fireEvent.click(row);
    const section = await screen.findByRole('region', { name: 'Stored data' });
    expect(section).toHaveFocus();
    expect(screen.getByText('Reading…')).toBeVisible();
    await act(async () => { resolve({ tables: [] }); });
    expect(section).toHaveFocus();
    expect(screen.getByText('No data yet')).toBeVisible();
  });

  it('loads tables only when the data pop-out opens and retains the preview pane', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    const closes = vi.mocked(props.surface.close).mock.calls.length;
    expect(props.describeData).not.toHaveBeenCalled();
    fireEvent.click(storedDataToggle());
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.getByTestId('site-preview-pane')).toBeInTheDocument();
    expect(props.surface.close).toHaveBeenCalledTimes(closes);
  });

  it('dismisses stored data back to the original preview without minting access again', async () => {
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(storedDataToggle());
    await screen.findByText('Ada');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Ada')).toBeNull());
    expect(screen.getByTestId('site-preview-pane')).toBeInTheDocument();
    expect(props.openArtifact).toHaveBeenCalledOnce();
    expect(props.surface.present).toHaveBeenCalledOnce();
  });

  it('leaves the data view behind when the detail moves to another artifact', async () => {
    // This element is not keyed on the resource, so a switch reconciles the
    // same instance. Carried into an artifact that keeps no data, the data
    // view would render with its toggle gone: the page would be unreachable
    // until the detail unmounted entirely.
    const stateless = vi.fn(async () => ({
      openUrl: OPEN_URL, canonicalUrl: CANONICAL, artifactId: ARTIFACT,
      mode: 'static' as const, stateful: false,
    }));
    const { props, rerender } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(storedDataToggle());
    await screen.findByText('Ada');

    rerender(<Harness props={{ ...props, resourceId: OTHER_RESOURCE, openArtifact: stateless }} />);

    expect(await screen.findByTestId('site-preview-pane')).toBeInTheDocument();
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
  });

  it('offers no data toggle for a site that keeps none', async () => {
    const { props } = setup({
      openArtifact: vi.fn(async () => ({
        openUrl: OPEN_URL, canonicalUrl: CANONICAL, artifactId: ARTIFACT,
        mode: 'static' as const, stateful: false,
      })),
    });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Artifact data menu' }), { button: 0, ctrlKey: false });
    expect(screen.queryByRole('menuitem', { name: /stored data/iu })).not.toBeInTheDocument();
  });

  it('loads the table a person picks, not only the one it opened on', async () => {
    // Every other fixture here describes a single table, so the picker's
    // `onChange` never reaches `loadTable` in CI: the second table is the only
    // thing that exercises the wiring at all.
    const { props } = setup({
      describeData: vi.fn(async () => ({
        tables: [
          { name: 'rsvps', columns: [{ name: 'name', type: 'TEXT' }], rowCount: 2 },
          { name: 'comments', columns: [{ name: 'body', type: 'TEXT' }], rowCount: 1 },
        ],
      })),
      loadTable: vi.fn(async (_resourceId: string, table: string) => ({
        rows: table === 'comments' ? [{ body: 'Looks good' }] : [{ name: 'Ada' }],
        csv: table,
      })),
    });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(storedDataToggle());
    await screen.findByText('Ada');

    fireEvent.click(screen.getByRole('radio', { name: 'comments' }));

    expect(await screen.findByText('Looks good')).toBeInTheDocument();
    expect(props.loadTable).toHaveBeenCalledWith(RESOURCE, 'comments');
  });

  it('shows an empty stored table as such rather than as a broken panel', async () => {
    const { props } = setup({ describeData: vi.fn(async () => ({ tables: [] })) });
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(storedDataToggle());
    expect(await screen.findByText('No data yet')).toBeInTheDocument();
  });

  it('copies the CSV the server rendered rather than rebuilding it', async () => {
    // One read, one CSV: a renderer that re-derived it could disagree with the
    // export a person got from anywhere else.
    const { props } = setup();
    await waitFor(() => expect(props.surface.present).toHaveBeenCalled());
    fireEvent.click(storedDataToggle());
    await screen.findByText('Ada');
    fireEvent.click(screen.getByRole('button', { name: /Copy as CSV/u }));
    await waitFor(() => expect(props.surface.copyText)
      .toHaveBeenCalledWith('"name","answer"\r\n"Ada","yes"\r\n"Grace",""'));
  });
});

describe('rendering one stored value', () => {
  it('distinguishes an absent value from an empty one', () => {
    // React renders null as nothing, which reads as an empty string rather
    // than as a value that was never there.
    expect(formatCell(null)).toBe('—');
    expect(formatCell(undefined)).toBe('—');
    expect(formatCell('')).toBe('');
  });

  it('renders numbers and booleans rather than dropping false and zero', () => {
    expect(formatCell(0)).toBe('0');
    expect(formatCell(false)).toBe('false');
  });

  it('never renders an object as [object Object]', () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});
