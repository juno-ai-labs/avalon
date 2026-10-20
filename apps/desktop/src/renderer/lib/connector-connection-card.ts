import {
  ConnectorConnectionCardInputSchema,
  ConnectorConnectionCardScopes,
  connectorConnectionCardInputFromToolEvent,
  isConnectorConnectionCardWireName,
} from '@rally/contracts';
import { z } from 'zod';

type CardToolEvent = Parameters<typeof connectorConnectionCardInputFromToolEvent>[0];

// Display compatibility does not authorize an unknown connector.
const connectionCardEnvelopeSchema = z.strictObject({
  connectorId: z.string().min(1),
  scope: z.enum(ConnectorConnectionCardScopes),
});

export function connectorConnectionCardDisplayInputFromToolEvent(event: CardToolEvent): z.infer<typeof connectionCardEnvelopeSchema> | null {
  const known = connectorConnectionCardInputFromToolEvent(event);
  if (known) return known;
  if (!isConnectorConnectionCardWireName(event?.name) || event?.status !== 'completed') return null;
  // Known summary recovery stays with the shared formatter. Unknown cards need
  // structured input/output, which terminal transcript facts normally retain.
  for (const candidate of [event.input, event.output]) {
    const parsed = connectionCardEnvelopeSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function isUnrecognizedConnectorConnectionCard(message: { toolEvent?: CardToolEvent }): boolean {
  const request = connectorConnectionCardDisplayInputFromToolEvent(message.toolEvent);
  return request !== null && !ConnectorConnectionCardInputSchema.safeParse(request).success;
}
