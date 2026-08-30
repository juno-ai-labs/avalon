import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CitationTarget } from '@rally/contracts/citations';
import type { Message } from './types';
import { useUiStore } from './ui-store';
import {
  EMBEDDED_RESOURCE_AUTOPEN_LOOKBACK,
  latestEmbeddedResource,
  useAutoOpenLatestEmbeddedResource,
} from './use-auto-open-embedded-resource';

const text = (
  id: string,
  body: string,
  extras: Partial<Pick<Message, 'messageType'>> = {},
): Pick<Message, 'id' | 'messageType' | 'text'> => ({
  id,
  messageType: extras.messageType ?? 'text',
  text: body,
});

const DECK = { id: 'board-deck' };
const MEMO = { id: 'pricing-memo' };
const resolve = (resourceId: string): { id: string } | undefined => {
  if (resourceId === 'board-deck' || resourceId === 'amber-crisp-lucid-lantern') return DECK;
  if (resourceId === 'pricing-memo') return MEMO;
  return undefined;
};

describe('latestEmbeddedResource', () => {
  it('names the lookback the product request named', () => {
    expect(EMBEDDED_RESOURCE_AUTOPEN_LOOKBACK).toBe(2);
  });

  it('returns the embed in the last text turn', () => {
    expect(latestEmbeddedResource([
      text('user', 'Write the memo.'),
      text('rally', 'Here it is.\n\n![Pricing memo](resource://pricing-memo)'),
    ], resolve)).toEqual({ messageId: 'rally', resourceId: 'pricing-memo' });
  });

  it('still finds an embed in the previous text turn when the latest has none', () => {
    expect(latestEmbeddedResource([
      text('rally', '![Pricing memo](resource://pricing-memo)'),
      text('user', 'Make the second page shorter.'),
    ], resolve)).toEqual({ messageId: 'rally', resourceId: 'pricing-memo' });
  });

  it('does not reach a document three text turns back', () => {
    expect(latestEmbeddedResource([
      text('rally', '![Pricing memo](resource://pricing-memo)'),
      text('user', 'Thanks.'),
      text('follow-up', 'And the appendix?'),
    ], resolve)).toBeNull();
  });

  it('skips plugin and thought rows when counting the last two messages', () => {
    expect(latestEmbeddedResource([
      text('rally', '![Pricing memo](resource://pricing-memo)'),
      text('thought', 'Planning the rewrite.', { messageType: 'thought' }),
      text('plugin', '', { messageType: 'plugin_activity' }),
    ], resolve)).toEqual({ messageId: 'rally', resourceId: 'pricing-memo' });
  });

  it('prefers the later turn when both of the last two announce a document', () => {
    expect(latestEmbeddedResource([
      text('first', '![Memo](resource://pricing-memo)'),
      text('second', '![Deck](resource://board-deck)'),
    ], resolve)).toEqual({ messageId: 'second', resourceId: 'board-deck' });
  });

  it('prefers the later card when one turn announces two documents', () => {
    expect(latestEmbeddedResource([
      text('rally', '![Deck](resource://board-deck)\n\n![Memo](resource://pricing-memo)'),
    ], resolve)).toEqual({ messageId: 'rally', resourceId: 'pricing-memo' });
  });

  it('resolves the alias the model wrote to the resource id the rail keys on', () => {
    expect(latestEmbeddedResource([
      text('rally', '![Deck](resource://amber-crisp-lucid-lantern)'),
    ], resolve)).toEqual({ messageId: 'rally', resourceId: 'board-deck' });
  });

  it('ignores a chip, an unresolved id, and a sample inside a fence', () => {
    expect(latestEmbeddedResource([
      text('rally', 'See [the deck](resource://board-deck).'),
    ], resolve)).toBeNull();
    expect(latestEmbeddedResource([
      text('rally', '![Gone](resource://removed)'),
    ], resolve)).toBeNull();
    expect(latestEmbeddedResource([
      text('rally', '```md\n![Title](resource://pricing-memo)\n```'),
    ], resolve)).toBeNull();
  });
});

describe('useAutoOpenLatestEmbeddedResource', () => {
  const open = vi.fn((target: CitationTarget) => {
    if (target.scheme !== 'resource') return;
    useUiStore.getState().openRail('context');
    useUiStore.getState().inspect({ type: 'resource', id: target.resourceId });
  });

  beforeEach(() => {
    open.mockClear();
    useUiStore.setState({ inspector: null, railOpen: false, railVariant: 'context' });
  });

  it('opens the context rail onto the announced document', () => {
    renderHook(() => useAutoOpenLatestEmbeddedResource({
      enabled: true,
      open,
      resolve,
      transcript: [text('rally', '![Memo](resource://pricing-memo)')],
      workstreamId: 'workstream-one',
    }));

    expect(open).toHaveBeenCalledExactlyOnceWith({ scheme: 'resource', resourceId: 'pricing-memo' });
    expect(useUiStore.getState()).toMatchObject({
      railOpen: true,
      railVariant: 'context',
      inspector: { type: 'resource', id: 'pricing-memo' },
    });
  });

  it('opens once the embed finishes streaming into a turn that had none', () => {
    const { rerender } = renderHook(
      ({ transcript }) => useAutoOpenLatestEmbeddedResource({
        enabled: true,
        open,
        resolve,
        transcript,
        workstreamId: 'workstream-one',
      }),
      { initialProps: { transcript: [text('rally', 'Working on the memo.')] } },
    );

    expect(open).not.toHaveBeenCalled();

    rerender({ transcript: [text('rally', 'Working on the memo.\n\n![Memo](resource://pricing-memo)')] });

    expect(open).toHaveBeenCalledExactlyOnceWith({ scheme: 'resource', resourceId: 'pricing-memo' });
  });

  it('does not reopen the same announcement after the reader closes the rail', () => {
    const { rerender } = renderHook(() => useAutoOpenLatestEmbeddedResource({
      enabled: true,
      open,
      resolve,
      transcript: [text('rally', '![Memo](resource://pricing-memo)')],
      workstreamId: 'workstream-one',
    }));

    act(() => { useUiStore.getState().closeRail(); });
    rerender();

    expect(open).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('opens a later announcement in a new turn', () => {
    const { rerender } = renderHook(
      ({ transcript }) => useAutoOpenLatestEmbeddedResource({
        enabled: true,
        open,
        resolve,
        transcript,
        workstreamId: 'workstream-one',
      }),
      { initialProps: { transcript: [text('rally', '![Memo](resource://pricing-memo)')] } },
    );

    rerender({
      transcript: [
        text('rally', '![Memo](resource://pricing-memo)'),
        text('next', '![Deck](resource://board-deck)'),
      ],
    });

    expect(open).toHaveBeenNthCalledWith(2, { scheme: 'resource', resourceId: 'board-deck' });
  });

  it('waits until the work stream carries the resource, then opens', () => {
    const unresolved = (_resourceId: string): { id: string } | undefined => undefined;
    const { rerender } = renderHook(
      ({ resolve: nextResolve }) => useAutoOpenLatestEmbeddedResource({
        enabled: true,
        open,
        resolve: nextResolve,
        transcript: [text('rally', '![Memo](resource://pricing-memo)')],
        workstreamId: 'workstream-one',
      }),
      { initialProps: { resolve: unresolved } },
    );

    expect(open).not.toHaveBeenCalled();

    rerender({ resolve });

    expect(open).toHaveBeenCalledExactlyOnceWith({ scheme: 'resource', resourceId: 'pricing-memo' });
  });

  it('opens again when the same work stream is visited after leaving', () => {
    const { rerender } = renderHook(
      ({ transcript, workstreamId }) => useAutoOpenLatestEmbeddedResource({
        enabled: true,
        open,
        resolve,
        transcript,
        workstreamId,
      }),
      {
        initialProps: {
          transcript: [text('rally', '![Memo](resource://pricing-memo)')],
          workstreamId: 'workstream-one',
        },
      },
    );

    // WorkstreamScreen closes the rail when the route's id changes. Without
    // that close, coming back would see the inspector still on this document
    // and skip `open` to avoid flashing the list — which is right while still
    // visiting, and would hide a visit-key leak if the rail stayed open.
    rerender({ transcript: [text('other', 'No document here.')], workstreamId: 'workstream-two' });
    act(() => { useUiStore.getState().closeRail(); });
    rerender({
      transcript: [text('rally', '![Memo](resource://pricing-memo)')],
      workstreamId: 'workstream-one',
    });

    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the feed still belongs to another work stream', () => {
    renderHook(() => useAutoOpenLatestEmbeddedResource({
      enabled: false,
      open,
      resolve,
      transcript: [text('rally', '![Memo](resource://pricing-memo)')],
      workstreamId: 'workstream-one',
    }));

    expect(open).not.toHaveBeenCalled();
    expect(useUiStore.getState().railOpen).toBe(false);
  });

  it('does not flash the list when the rail is already showing that document', () => {
    useUiStore.setState({
      railOpen: true,
      railVariant: 'context',
      inspector: { type: 'resource', id: 'pricing-memo' },
    });
    const guarded = vi.fn();

    renderHook(() => useAutoOpenLatestEmbeddedResource({
      enabled: true,
      open: guarded,
      resolve,
      transcript: [text('rally', '![Memo](resource://pricing-memo)')],
      workstreamId: 'workstream-one',
    }));

    expect(guarded).not.toHaveBeenCalled();
    expect(useUiStore.getState().inspector).toEqual({ type: 'resource', id: 'pricing-memo' });
  });
});
