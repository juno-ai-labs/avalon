import type { Env } from "../env";
import { numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { readBoundedRequestBytes } from "../lib/bounded-request-body";
import { ResendInboundEmailRoutingService } from "./resend-inbound-email-service";
import { requireWorkstreamIngress } from "./workstream-authority";

/** Platform-only ingress. SMTP recipients select routes, including Bcc mail. */
export async function receiveCloudflareEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  if (env.AVALON_REGION !== "global") {
    message.setReject("Email must be delivered to the Global Worker");
    return;
  }
  await requireWorkstreamIngress(env);
  const maxBytes = numericEnv(env, "INBOUND_EMAIL_MAX_BYTES", 2_000_000);
  if (message.rawSize > maxBytes) {
    message.setReject("Email exceeds the configured size limit");
    return;
  }
  // Enforce the byte limit on the stream too. The body is passed directly to
  // its owning region and is persisted only in that region's payload bucket.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBoundedRequestBytes(new Request("https://email.internal", {
      method: "POST", body: message.raw,
      // Node requires duplex for stream-backed Request bodies; workerd ignores it.
      ...{ duplex: "half" },
    }), maxBytes, "The received email exceeds the configured size limit");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 413) throw error;
    message.setReject("Email exceeds the configured size limit");
    return;
  }
  await new ResendInboundEmailRoutingService(env).ingestCloudflare({
    senderAuthenticated: cloudflareSenderAuthenticated(message.headers),
    raw: bytes.buffer,
    from: message.from,
    to: message.to,
  });
}

/** Trust only Cloudflare's first Authentication-Results verdict, never a sender's. */
export function cloudflareSenderAuthenticated(headers: Headers): boolean {
  const header = headers.get("authentication-results");
  if (!header) return false;
  let normalized = "";
  let commentDepth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of header) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && (commentDepth > 0 || quoted)) { escaped = true; continue; }
    if (commentDepth > 0) {
      if (character === "(") commentDepth += 1;
      else if (character === ")") commentDepth -= 1;
      continue;
    }
    if (character === '"') { quoted = !quoted; normalized += " "; continue; }
    if (quoted) continue;
    if (character === "(") { commentDepth = 1; normalized += " "; continue; }
    // Headers.get joins duplicate fields with a comma. Later verdicts may
    // have been supplied by the sender and cannot authenticate this message.
    if (character === ",") break;
    normalized += character;
  }
  if (commentDepth !== 0 || quoted || escaped) return false;
  const [service, ...results] = normalized.toLowerCase().split(";");
  if (service?.trim() !== "mx.cloudflare.net") return false;
  return results.some((result) => /^\s*dmarc\s*=\s*pass(?:\s|$)/u.test(result));
}
