import { describe, expect, it } from 'vitest';
import { axOutline } from './ax-outline';

describe('page outline', () => {
  it('keeps named nodes, lifts unnamed wrappers, and skips ignored nodes and text boxes', () => {
    const tree = { nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Chat' }, childIds: ['2', '6'] },
      { nodeId: '2', parentId: '1', role: { value: 'generic' }, name: { value: '' }, childIds: ['3', '4'] },
      { nodeId: '3', parentId: '2', role: { value: 'heading' }, name: { value: 'Garden  plan' }, childIds: [] },
      { nodeId: '4', parentId: '2', role: { value: 'StaticText' }, name: { value: 'Water twice a week' }, childIds: ['5'] },
      { nodeId: '5', parentId: '4', role: { value: 'InlineTextBox' }, name: { value: 'Water twice a week' } },
      { nodeId: '6', parentId: '1', ignored: true, role: { value: 'button' }, name: { value: 'Hidden' }, childIds: ['7'] },
      { nodeId: '7', parentId: '6', role: { value: 'button' }, name: { value: 'Copy' } },
    ] };
    expect(axOutline(tree)).toBe([
      'RootWebArea "Chat"',
      '  heading "Garden plan"',
      '  StaticText "Water twice a week"',
      '  button "Copy"',
    ].join('\n'));
    expect(axOutline(null)).toBe('');
  });
});
