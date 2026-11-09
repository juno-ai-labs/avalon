/**
 * Cloudflare's published inbound ceiling, checked 2026-11-09:
 * https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
 * Raw MIME includes attachment bodies; the legacy JSON-response bound does not.
 */
export const CLOUDFLARE_EMAIL_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Stable authored headers only: receiving-hop Received/ARC/authentication and
 * provider X-* headers change on SMTP retry. The MIME body remains exact bytes.
 */
const AUTHORED_HEADERS = new Set([
  "from", "to", "cc", "reply-to", "subject", "date", "message-id",
  "mime-version", "content-type", "content-transfer-encoding", "content-disposition", "content-id",
]);

export async function cloudflareEmailIdentity(message: { raw: ArrayBuffer; from: string; to: string; senderAuthenticated?: boolean | undefined }): Promise<string> {
  const bytes = new Uint8Array(message.raw);
  let headerEnd = bytes.length;
  let bodyStart = bytes.length;
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) {
      headerEnd = index; bodyStart = index + 2; break;
    }
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      headerEnd = index; bodyStart = index + 4; break;
    }
  }
  const headers = new TextDecoder().decode(bytes.subarray(0, headerEnd))
    .replace(/\r?\n[ \t]+/gu, " ").split(/\r?\n/u)
    .flatMap((line): Array<[string, string]> => {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim().toLowerCase();
      return colon > 0 && AUTHORED_HEADERS.has(name) ? [[name, line.slice(colon + 1).trim()]] : [];
    }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const bodyDigest = await sha256(bytes.subarray(bodyStart));
  // Recipient scopes every downstream identity too, including regional R2 and
  // resource rows: two Sidekicks must never overwrite each other's metadata.
  return `cf_${await sha256(new TextEncoder().encode(JSON.stringify([
    message.from.toLowerCase(), message.to.toLowerCase(), message.senderAuthenticated === true, headers, bodyDigest,
  ])))}`;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
