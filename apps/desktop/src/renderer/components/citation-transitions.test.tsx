import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownBody } from './workstream-blocks';

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText: vi.fn(), openExternal: vi.fn() }),
  desktopServicesAvailable: () => true,
}));

/**
 * A link, a mention, and an image each changing what they *are* between two
 * renders of one mounted body — which is what a person editing a message, or a
 * streamed reply settling, actually produces.
 *
 * The registry's cells do not all use the same number of hooks: a resource chip
 * resolves its resource, an external link uses none. That is only safe because
 * `renderCitation` renders the cell as an *element* rather than calling it, so
 * the two are separate component types and React mounts one in place of the
 * other. Called inline, their hooks would run in the caller's slots and a
 * scheme change at the same position would change one instance's hook count.
 */
describe('a link that changes kind between renders', () => {
  it('renders an external link, then a chip, then a link again, with no React error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, container } = render(
      <MarkdownBody>{'See [Doc](https://example.com/aa) here.'}</MarkdownBody>,
    );
    expect(container.querySelector('a')).not.toBeNull();
    // Identical text length and identical child shape, so React reconciles the
    // anchor by the same index rather than remounting it.
    rerender(<MarkdownBody>{'See [Doc](resource://aaaaaaaaa) here.'}</MarkdownBody>);
    expect(container.querySelector('.citation-chip')).not.toBeNull();
    rerender(<MarkdownBody>{'See [Doc](https://example.com/aa) here.'}</MarkdownBody>);
    expect(container.querySelector('a')).not.toBeNull();
    const messages = errors.mock.calls.map((call) => String(call[0]));
    errors.mockRestore();
    expect(messages.filter((message) => /hook|Hook/u.test(message))).toEqual([]);
  });

  it('renders a mention fallback, then a chip, then the fallback again, cleanly', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, container } = render(
      <MarkdownBody>{'Ask [@X](person:nope) now.'}</MarkdownBody>,
    );
    rerender(<MarkdownBody>{'Ask [@X](resource://r1) now.'}</MarkdownBody>);
    expect(container.querySelector('.citation-chip')).not.toBeNull();
    rerender(<MarkdownBody>{'Ask [@X](person:nope) now.'}</MarkdownBody>);
    const messages = errors.mock.calls.map((call) => String(call[0]));
    errors.mockRestore();
    expect(messages.filter((message) => /hook|Hook/u.test(message))).toEqual([]);
  });

  it('renders a real image, then an embed card, cleanly', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, container } = render(
      <MarkdownBody>{'![Doc](https://example.com/a.png)'}</MarkdownBody>,
    );
    expect(container.querySelector('img')).not.toBeNull();
    rerender(<MarkdownBody>{'![Doc](resource://r1)'}</MarkdownBody>);
    expect(container.querySelector('.citation-card')).not.toBeNull();
    const messages = errors.mock.calls.map((call) => String(call[0]));
    errors.mockRestore();
    expect(messages.filter((message) => /hook|Hook/u.test(message))).toEqual([]);
  });
});
