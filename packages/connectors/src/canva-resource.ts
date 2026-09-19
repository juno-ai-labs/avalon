import { z } from 'zod';
import { ConnectorError } from './types';

const DesignId = z.string().regex(/^[A-Za-z0-9_-]+$/u);
/** Retain the full validated provider URL only in the protected access field. */
export function parseCanvaDesignReference(value: string): { designId: string; canonicalUrl: string; accessUrl?: string } {
  let designId: string;
  let accessUrl: string | undefined;
  if (value.startsWith('https://')) {
    const url = new URL(value);
    const match = /^\/design\/([A-Za-z0-9_-]+)(?:\/|$)/u.exec(url.pathname);
    if (url.hostname !== 'www.canva.com' || url.port || url.username || url.password || !match?.[1]) {
      throw new ConnectorError('invalid_configuration', 'Use a Canva design link.');
    }
    designId = match[1];
    accessUrl = url.toString();
  } else designId = DesignId.parse(value);
  return { designId, canonicalUrl: `https://www.canva.com/design/${designId}/view`, ...(accessUrl ? { accessUrl } : {}) };
}
