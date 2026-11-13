import { digestStringAsync, CryptoDigestAlgorithm, CryptoEncoding, getRandomBytesAsync } from 'expo-crypto';
import { openAuthSessionAsync } from 'expo-web-browser';
import { MOBILE_AUTH_CALLBACK, MOBILE_SIGN_IN_PATH, type MobileAuthExchange } from './auth-contract';
import { readAuthCallback } from './auth-callback';

async function randomProof(): Promise<string> {
  const bytes = await getRandomBytesAsync(32);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** In-flight proof lives only in this invocation, never storage or a URL. */
export async function systemSignIn(appUrl: string): Promise<MobileAuthExchange | null> {
  const attemptId = await randomProof();
  const codeVerifier = await randomProof();
  const challenge = (await digestStringAsync(CryptoDigestAlgorithm.SHA256, codeVerifier, { encoding: CryptoEncoding.BASE64 }))
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  const url = new URL(`${MOBILE_SIGN_IN_PATH}/${attemptId}/${challenge}`, appUrl);
  const result = await openAuthSessionAsync(url.href, MOBILE_AUTH_CALLBACK);
  if (result.type !== 'success') return null;
  return { ...readAuthCallback(result.url, attemptId), codeVerifier };
}
