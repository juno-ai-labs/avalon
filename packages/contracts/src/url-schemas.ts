import { z } from "zod";

function urlSchema(
  protocols: ReadonlySet<string>,
  description: string,
  maxLength?: number,
) {
  const text = maxLength === undefined ? z.string() : z.string().max(maxLength);
  return text.url().refine((value) => {
    try {
      return protocols.has(new URL(value).protocol);
    } catch {
      return false;
    }
  }, description);
}

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const HTTPS_PROTOCOL = new Set(["https:"]);
const AVALON_PROTOCOL = new Set(["avalon:"]);
const HTTP_OR_AVALON_PROTOCOLS = new Set(["http:", "https:", "avalon:"]);

/** Absolute web URL. HTTP remains valid for loopback/local development. */
export const HttpUrlSchema = urlSchema(HTTP_PROTOCOLS, "Expected an absolute HTTP(S) URL");

/** Absolute provider URL whose transport must be encrypted. */
export const HttpsUrlSchema = urlSchema(HTTPS_PROTOCOL, "Expected an absolute HTTPS URL");

/** Avalon desktop deep link. */
export const AvalonUrlSchema = urlSchema(AVALON_PROTOCOL, "Expected an avalon: deep link");

/** Browser handoff URL or its final Avalon desktop target. */
export const HttpOrAvalonUrlSchema = urlSchema(
  HTTP_OR_AVALON_PROTOCOLS,
  "Expected an HTTP(S) URL or avalon: deep link",
);

export function httpUrlSchema(maxLength: number) {
  return urlSchema(HTTP_PROTOCOLS, "Expected an absolute HTTP(S) URL", maxLength);
}

export function httpsUrlSchema(maxLength: number) {
  return urlSchema(HTTPS_PROTOCOL, "Expected an absolute HTTPS URL", maxLength);
}
