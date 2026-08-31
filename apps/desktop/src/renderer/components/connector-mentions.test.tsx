import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ConnectorConnectionsProvider,
  ConnectorEmbedCard,
  ConnectorMentionChip,
} from './connector-mentions';

describe('connector connection resolution', () => {
  it('makes no status claim while the connections query is unresolved', () => {
    render(
      <ConnectorConnectionsProvider connections={undefined}>
        <ConnectorMentionChip connectorType="google" label="@Gmail" />
        <ConnectorEmbedCard connectorType="google" label="Google Drive" />
      </ConnectorConnectionsProvider>,
    );

    const chip = screen.getByText('Gmail').closest('.mention-chip');
    const card = screen.getByText('Google Drive').closest('.citation-connector-card');
    expect(chip).not.toHaveAttribute('data-connector-status');
    expect(chip?.querySelector('.mention-chip-status')).not.toBeInTheDocument();
    expect(card?.querySelector('.citation-connector-card-meta')).not.toBeInTheDocument();
    expect(card?.querySelector('.citation-connector-card-scopes')).not.toBeInTheDocument();
  });

  it('shows missing only after an empty connections result resolves', () => {
    render(
      <ConnectorConnectionsProvider connections={[]}>
        <ConnectorMentionChip connectorType="google" label="@Gmail" />
      </ConnectorConnectionsProvider>,
    );

    const chip = screen.getByText('Gmail').closest('.mention-chip');
    expect(chip).toHaveAttribute('data-connector-status', 'missing');
    expect(chip?.querySelector('.mention-chip-status')).toHaveTextContent('Not connected');
  });
});
