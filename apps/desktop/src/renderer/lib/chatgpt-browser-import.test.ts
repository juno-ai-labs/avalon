import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserTab } from '../../common/embedded-browser';
import { chatGptBrowserConversation, readChatGptBrowserConversation } from './chatgpt-browser-import';

const tab = (id: string, title: string, url: string): EmbeddedBrowserTab => ({
  id, title, url, loading: false, canGoBack: false, canGoForward: false,
});

describe('ChatGPT browser import', () => {
  it('offers only private ChatGPT conversation tabs and reads the exact selection', async () => {
    const selected = tab('00000000-0000-7000-8000-000000000002', 'Selected chat', 'https://chatgpt.com/c/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0');
    const other = tab('00000000-0000-7000-8000-000000000001', 'Other chat', 'https://chatgpt.com/c/6ab29fab-bb30-83e8-adcb-94f600c79a08');
    expect(chatGptBrowserConversation(tab('x', 'Share', 'https://chatgpt.com/share/6ab43c03-6b2c-83e8-9eba-f1c51fa1e7a0'))).toBeNull();
    const commandEmbeddedBrowser = vi.fn().mockResolvedValue({ kind: 'value', value: '{"title":"Selected chat"}' });
    const bridge = { getEmbeddedBrowserState: vi.fn().mockResolvedValue({ activeTabId: other.id, tabs: [other, selected] }), commandEmbeddedBrowser };
    await expect(readChatGptBrowserConversation(bridge, selected.url)).resolves.toBe('{"title":"Selected chat"}');
    expect(commandEmbeddedBrowser).toHaveBeenCalledWith(expect.objectContaining({ action: 'evaluate', tabId: selected.id }));
    await expect(readChatGptBrowserConversation(bridge, 'https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))
      .rejects.toThrow('Open this conversation');
    expect(commandEmbeddedBrowser).toHaveBeenCalledTimes(1);
  });
});
