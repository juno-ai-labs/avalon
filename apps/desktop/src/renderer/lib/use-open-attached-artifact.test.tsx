import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useOpenAttachedArtifact } from './use-open-attached-artifact';

type Resources = Parameters<typeof useOpenAttachedArtifact>[1];
const first = { id: 'first', direction: 'artifact' as const };
const second = { id: 'second', direction: 'artifact' as const };
const upload = { id: 'upload', direction: 'source' as const };

// Panel behavior is client-owned: render the hook with changing socket slices
// and a real dismissible panel, without a server or provider double.
function Conversation({ resources, conversation = 'canvas:0', visible = true }: {
  resources: Resources;
  conversation?: string;
  visible?: boolean;
}): React.JSX.Element {
  const [panel, open] = useState<string | null>(null);
  useOpenAttachedArtifact(conversation, resources, visible, open);
  return <>{panel && <aside aria-label="Artifact">{panel}<button onClick={() => open(null)}>Close</button></aside>}</>;
}

describe('newly attached artifacts', () => {
  it('opens the first arrival and reopens for another artifact after dismissal', () => {
    const { rerender } = render(<Conversation resources={[]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    rerender(<Conversation resources={[first]} />);
    expect(screen.getByRole('complementary')).toHaveTextContent('first');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    rerender(<Conversation resources={[{ ...first }]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    rerender(<Conversation resources={[second, first]} />);
    expect(screen.getByRole('complementary')).toHaveTextContent('second');
  });

  it('leaves initial artifacts and ordinary file attachments to their existing behavior', () => {
    const { rerender } = render(<Conversation resources={undefined} />);
    rerender(<Conversation resources={[first]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    rerender(<Conversation resources={[upload, first]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('selects the newest addition and leaves a refreshed existing artifact alone', () => {
    const { rerender } = render(<Conversation resources={[]} />);
    rerender(<Conversation resources={[second, first]} />);
    expect(screen.getByRole('complementary')).toHaveTextContent('second');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    rerender(<Conversation resources={[{ ...first }, { ...second }]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('keeps its baseline through reconnects and resets it when changing conversations', () => {
    const { rerender } = render(<Conversation resources={[]} />);
    rerender(<Conversation resources={undefined} />);
    rerender(<Conversation resources={[first]} />);
    expect(screen.getByRole('complementary')).toHaveTextContent('first');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    rerender(<Conversation conversation="other:0" resources={undefined} />);
    rerender(<Conversation conversation="other:0" resources={[second]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('does not open the rail for a hidden conversation', () => {
    const { rerender } = render(<Conversation resources={[]} />);
    rerender(<Conversation resources={[first]} visible={false} />);
    rerender(<Conversation resources={[first]} />);
    expect(screen.queryByRole('complementary')).toBeNull();
    rerender(<Conversation resources={[second, first]} />);
    expect(screen.getByRole('complementary')).toHaveTextContent('second');
  });
});
