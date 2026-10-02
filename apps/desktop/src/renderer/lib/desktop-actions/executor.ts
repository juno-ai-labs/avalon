import {
  DesktopActionSchema,
  type DesktopAction,
  type DesktopActionFailureCode,
  type DesktopActionOutcome,
  type StoredRef,
} from '@rally/contracts/desktop-actions';
import { describeZodIssues } from '@rally/contracts/zod-diagnostics';

import type { RallyDesktopBridge } from '../../../common/desktop';
import type { EmbeddedBrowserCommand } from '../../../common/embedded-browser';
import { loadThroughTab } from '../browser-conversation';
import { axOutline } from './ax-outline';
import { pageScript, PageScriptOutcomeSchema } from './page-script';
import { MAX_STORED_FILE_BYTES, type DesktopActionStore } from './store';

type ExecutorBridge = Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>;

/** Actions that are not the browser's: the work's own, answered by its owner. */
export type DesktopActionHandlers = {
  [K in Exclude<DesktopAction['kind'], `browser.${string}`>]?: (
    action: Extract<DesktopAction, { kind: K }>,
  ) => Promise<DesktopActionOutcome>;
};

export interface DesktopActionExecutorOptions {
  bridge: ExecutorBridge;
  /** The one tab this work drives. No action reaches any other. */
  tabId: string;
  /** Whether the tab may be on, navigate to, or load from this URL. */
  siteAllows: (url: string) => boolean;
  store: DesktopActionStore;
  handlers?: DesktopActionHandlers;
}

const failed = (code: DesktopActionFailureCode, message: string): DesktopActionOutcome => ({ ok: false, code, message });

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '') || 'file';
  } catch {
    return 'file';
  }
}

/**
 * Execute desktop actions on one pinned browser tab.
 *
 * The API's agent asks; this decides. Every action is parsed before it runs,
 * goes only to the pinned tab through the same main-process browser command
 * path the person's own controls use, and is refused when it would take the
 * tab off the sites this work allows. The tab's page is checked after every
 * action too, because page script and clicks can navigate. Opening, closing
 * or switching tabs and raw DevTools commands are not actions at all.
 */
export function createDesktopActionExecutor(options: DesktopActionExecutorOptions) {
  const { bridge, tabId, siteAllows, store } = options;

  const command = (input: EmbeddedBrowserCommand) => bridge.commandEmbeddedBrowser(input);

  const page = async (): Promise<{ url: string; title: string } | null> => {
    const state = await bridge.getEmbeddedBrowserState();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    return tab ? { url: tab.url, title: tab.title } : null;
  };

  /** The page after an action, or the failure that the page's state is. */
  const settled = async (): Promise<{ url: string; title: string } | DesktopActionOutcome> => {
    const current = await page();
    if (!current) return failed('tab_closed', 'The tab this work uses was closed.');
    if (!siteAllows(current.url)) return failed('origin_not_allowed', `The tab is on ${current.url}, which this work may not use.`);
    return current;
  };

  const keep = (stored: { handle: string; kind: 'file' | 'json'; name: string; mimeType: string; size: number; data: string }): StoredRef => {
    const ref: StoredRef = { handle: stored.handle, kind: stored.kind, name: stored.name, mimeType: stored.mimeType, size: stored.size };
    store.add({ ref, data: stored.data });
    return ref;
  };

  const browser = async (action: Extract<DesktopAction, { kind: `browser.${string}` }>): Promise<DesktopActionOutcome> => {
    const before = await settled();
    // Only navigation may start from a site this work may not use: it is how
    // the agent brings the tab back.
    if ('ok' in before && !(action.kind === 'browser.navigate' && !before.ok && before.code === 'origin_not_allowed')) return before;
    if (action.kind === 'browser.evaluate') {
      let raw: unknown;
      try {
        const result = await command({ action: 'evaluate', tabId, expression: pageScript(action.script) });
        raw = result.kind === 'value' ? result.value : null;
      } catch {
        return failed('script_error', 'The script could not run. Check its syntax: it is the body of an async function.');
      }
      if (!raw || typeof raw !== 'object') return failed('script_error', 'The script did not answer.');
      const shaped = PageScriptOutcomeSchema.safeParse(raw);
      if (!shaped.success) return failed('script_error', `The page changed the script's answer: ${describeZodIssues(shaped.error)}.`);
      const answered = shaped.data;
      if (!answered.ok) return failed(answered.code, answered.message);
      const stored = answered.stored.map(keep);
      const after = await settled();
      if ('ok' in after) return after;
      return { ok: true, result: { ...after, value: answered.value, stored } };
    }
    if (action.kind === 'browser.snapshot') {
      const result = await command({ action: 'snapshot', tabId });
      if (result.kind !== 'snapshot') return failed('browser_command_failed', 'The page outline could not be read.');
      return { ok: true, result: { url: result.url, title: result.title, outline: axOutline(result.tree) } };
    }
    if (action.kind === 'browser.screenshot') {
      const result = await command({ action: 'screenshot', tabId });
      if (result.kind !== 'screenshot') return failed('browser_command_failed', 'The page could not be captured.');
      const current = await settled();
      if ('ok' in current) return current;
      return { ok: true, result: { ...current, mimeType: result.mimeType, data: result.data, width: result.width, height: result.height } };
    }
    if (action.kind === 'browser.load') {
      if (!siteAllows(action.url)) return failed('origin_not_allowed', `${action.url} is not a site this work may load from.`);
      const loaded = await loadThroughTab(bridge, tabId, action.url, MAX_STORED_FILE_BYTES);
      if (loaded === 'too_large') return failed('file_too_large', `The file is larger than the ${MAX_STORED_FILE_BYTES}-byte file limit.`);
      if (!loaded) return failed('browser_command_failed', `${action.url} could not be loaded.`);
      const size = Math.floor(loaded.data.length * 3 / 4) - (loaded.data.endsWith('==') ? 2 : loaded.data.endsWith('=') ? 1 : 0);
      const stored = keep({
        handle: `l${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        kind: 'file',
        name: action.name ?? fileName(action.url),
        mimeType: action.mimeType ?? loaded.contentType?.split(';')[0]?.trim() ?? 'application/octet-stream',
        size,
        data: loaded.data,
      });
      return { ok: true, result: { stored } };
    }
    if (action.kind === 'browser.network_list') {
      const result = await command({ action: 'network', tabId });
      if (result.kind !== 'network') return failed('browser_command_failed', 'The page\'s network responses could not be read.');
      const responses = result.responses.filter((response) =>
        (!action.urlContains || response.url.includes(action.urlContains))
        && (!action.resourceType || response.resourceType.toLowerCase() === action.resourceType.toLowerCase()));
      return { ok: true, result: { responses } };
    }
    if (action.kind === 'browser.network_read') {
      let body: { body: string; base64Encoded: boolean };
      let mimeType: string;
      try {
        const listed = await command({ action: 'network', tabId });
        mimeType = listed.kind === 'network' ? listed.responses.find((response) => response.requestId === action.requestId)?.mimeType ?? '' : '';
        const result = await command({ action: 'response_body', tabId, requestId: action.requestId });
        if (result.kind !== 'response_body') throw new Error('The response body could not be read.');
        body = result;
      } catch (error) {
        return failed('browser_command_failed', error instanceof Error ? error.message : 'The response body could not be read.');
      }
      const textual = !body.base64Encoded || /^(text\/|application\/(json|xml|javascript)|[^;]*\+json)/u.test(mimeType);
      const text = body.base64Encoded && textual
        ? new TextDecoder().decode(Uint8Array.from(atob(body.body), (character) => character.charCodeAt(0)))
        : body.body;
      let parsed: unknown;
      let json = false;
      if (textual) {
        try { parsed = JSON.parse(text); json = true; } catch { parsed = undefined; }
      }
      const variable = `window.__rallyNetwork[${JSON.stringify(action.requestId)}]`;
      // The page received this body itself; handing it back to the page exposes nothing new.
      const value = json ? text : JSON.stringify(textual ? text : body.body);
      try {
        await command({ action: 'evaluate', tabId, expression: `(() => { window.__rallyNetwork ??= {}; ${variable} = ${value}; return true; })()` });
      } catch {
        return failed('browser_command_failed', 'The response body could not be placed in the page.');
      }
      const size = textual ? text.length : Math.floor(body.body.length * 3 / 4);
      const shape = json && parsed !== null && typeof parsed === 'object'
        ? Array.isArray(parsed) ? { length: parsed.length } : { keys: Object.keys(parsed).slice(0, 50) }
        : {};
      const offset = action.offset ?? 0;
      return {
        ok: true,
        result: {
          variable, mimeType: mimeType || (json ? 'application/json' : ''), size, json, ...shape,
          ...(action.length !== undefined ? { text: (textual ? text : body.body).slice(offset, offset + action.length) } : {}),
        },
      };
    }
    if (action.kind === 'browser.navigate' && !siteAllows(action.url)) {
      return failed('origin_not_allowed', `${action.url} is not a site this work may open.`);
    }
    try {
      if (action.kind === 'browser.navigate') await command({ action: 'navigate', tabId, url: action.url });
      else if (action.kind === 'browser.click') await command({ action: 'click', tabId, x: action.x, y: action.y });
      else if (action.kind === 'browser.scroll') {
        await command({ action: 'scroll', tabId, x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY });
      } else if (action.kind === 'browser.type') await command({ action: 'type', tabId, text: action.text });
      else await command({ action: 'key', tabId, key: action.key });
    } catch (error) {
      return failed('browser_command_failed', error instanceof Error ? error.message : 'The browser command failed.');
    }
    const after = await settled();
    return 'ok' in after ? after : { ok: true, result: after };
  };

  return {
    /** Run one requested action; never throws, so every request gets an answer. */
    async execute(raw: unknown): Promise<DesktopActionOutcome> {
      const parsed = DesktopActionSchema.safeParse(raw);
      if (!parsed.success) return failed('invalid_action', `This desktop does not run that action: ${describeZodIssues(parsed.error)}.`);
      const action = parsed.data;
      try {
        if (action.kind.startsWith('browser.')) {
          return await browser(action as Extract<DesktopAction, { kind: `browser.${string}` }>);
        }
        const handler = options.handlers?.[action.kind as keyof DesktopActionHandlers] as
          ((input: DesktopAction) => Promise<DesktopActionOutcome>) | undefined;
        return handler ? await handler(action) : failed('invalid_action', `This desktop does not run ${action.kind}.`);
      } catch (error) {
        return failed('browser_command_failed', error instanceof Error ? error.message : 'The action failed.');
      }
    },
  };
}
