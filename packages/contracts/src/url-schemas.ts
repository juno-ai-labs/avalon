import { z } from "zod";
import {
  DESKTOP_DEEP_LINK_PROTOCOLS,
} from "./desktop-deep-link";

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

const DESKTOP_PROTOCOLS = new Set(DESKTOP_DEEP_LINK_PROTOCOLS);
const HTTP_OR_DESKTOP_PROTOCOLS = new Set([...HTTP_PROTOCOLS, ...DESKTOP_PROTOCOLS]);

/** Absolute web URL. HTTP remains valid for loopback/local development. */
export const HttpUrlSchema = urlSchema(HTTP_PROTOCOLS, "Expected an absolute HTTP(S) URL");

/** Absolute provider URL whose transport must be encrypted. */
export const HttpsUrlSchema = urlSchema(HTTPS_PROTOCOL, "Expected an absolute HTTPS URL");

/** Desktop deep link, in the current scheme or the one it replaced. */
export const DesktopDeepLinkUrlSchema = urlSchema(
  DESKTOP_PROTOCOLS,
  "Expected a rallywithai: or avalon: deep link",
);

/** Browser handoff URL or its final desktop-deep-link target. */
export const HttpOrDesktopDeepLinkUrlSchema = urlSchema(
  HTTP_OR_DESKTOP_PROTOCOLS,
  "Expected an HTTP(S) URL or a rallywithai:/avalon: deep link",
);

export function httpUrlSchema(maxLength: number) {
  return urlSchema(HTTP_PROTOCOLS, "Expected an absolute HTTP(S) URL", maxLength);
}

export function httpsUrlSchema(maxLength: number) {
  return urlSchema(HTTPS_PROTOCOL, "Expected an absolute HTTPS URL", maxLength);
}
