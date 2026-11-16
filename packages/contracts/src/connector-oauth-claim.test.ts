import "../../../tests/isolated-region";
import { describe, expect, it } from 'vitest';

import { parseConnectorClaimLink } from './connector-oauth-claim';

const WORKSPACE_ID = '00000000-0000-7000-8000-000000000009';
const TICKET = 'T'.repeat(43);

describe('connector claim links', () => {
  it("reads the browser page's ticket from its fragment and the mobile link's from its query", () => {
    const claim = { provider: 'notion', ticket: TICKET, region: 'global', workspaceId: WORKSPACE_ID, attemptId: null };
    expect(parseConnectorClaimLink(
      `https://app.rallywith.ai/connections/complete?provider=notion&region=global&workspace=${WORKSPACE_ID}&status=authorized#ticket=${TICKET}`,
    )).toEqual(claim);
    expect(parseConnectorClaimLink(
      `rally-mobile://connections/complete?provider=notion&region=global&workspace=${WORKSPACE_ID}&status=authorized&ticket=${TICKET}`,
    )).toEqual(claim);
  });

  it.each([
    `https://app.rallywith.ai/connections/complete?provider=notion&region=global&workspace=${WORKSPACE_ID}&status=connected#ticket=${TICKET}`,
    `https://app.rallywith.ai/connections/complete?provider=notion&region=global&status=authorized#ticket=${TICKET}`,
    `https://app.rallywith.ai/connections/complete?provider=unknown&region=global&workspace=${WORKSPACE_ID}&status=authorized#ticket=${TICKET}`,
    `https://app.rallywith.ai/connections/complete?provider=notion&region=global&workspace=${WORKSPACE_ID}&status=authorized#ticket=short`,
  ])('carries no claim: %s', (raw) => {
    expect(parseConnectorClaimLink(raw)).toBeNull();
  });
});
