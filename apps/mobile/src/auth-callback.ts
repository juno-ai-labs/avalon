import { MobileAuthTicketSchema } from '@rally/contracts';
import { MOBILE_AUTH_CALLBACK } from './auth-contract';

export function readAuthCallback(value: string, attemptId: string) {
  const url = new URL(value);
  const callback = new URL(MOBILE_AUTH_CALLBACK);
  if (url.protocol !== callback.protocol || url.host !== callback.host || url.pathname !== callback.pathname
    || url.username || url.password || url.hash || url.searchParams.get('attemptId') !== attemptId
    || [...url.searchParams.keys()].some((key) => !['ticket', 'attemptId', 'region'].includes(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new Error('The sign-in response does not match this attempt.');
  }
  return MobileAuthTicketSchema.parse(Object.fromEntries(url.searchParams));
}
