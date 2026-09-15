/// <reference types="node" />
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

const EndpointSchema = z.object({ id: z.string(), url: z.string(), disabled: z.boolean(), filterTypes: z.array(z.string()).nullish() });
const EVENTS = ["sandbox.created", "sandbox.state.updated"];

export function signedDaytonaHeaders(secret: string, body: string): Record<string, string> {
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/u, ""), "base64"))
    .update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

/** Endpoint UID makes retries converge, including after an uncertain create response. */
export async function provisionDaytonaWebhook(input: {
  apiKey: string; apiUrl: string; organizationId: string; webhookUrl: string;
  svixApiUrl?: string; fetcher?: typeof fetch;
  installSecrets: (secrets: Record<string, string>) => Promise<void>;
}): Promise<{ endpointId: string; secret: string }> {
  const fetcher = input.fetcher ?? fetch;
  const webhookUrl = new URL(input.webhookUrl);
  if (webhookUrl.protocol !== "https:" || webhookUrl.pathname !== "/ingest/daytona") {
    throw new Error("DAYTONA_WEBHOOK_URL must be an HTTPS /ingest/daytona endpoint");
  }
  async function request(base: string, token: string, path: string, method = "GET", body?: unknown) {
    const response = await fetcher(`${base.replace(/\/$/u, "")}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error",
    });
    if (!response.ok) throw new Error(`Webhook provisioning ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : await response.json() as unknown;
  }
  const orgPath = `/webhooks/organizations/${encodeURIComponent(input.organizationId)}`;
  const daytona = (path: string, method = "GET", body?: unknown) => request(input.apiUrl, input.apiKey, `${orgPath}${path}`, method, body);
  // Daytona's initialize operation is idempotent for an existing application.
  await daytona("/initialize", "POST");
  const portal = z.object({ token: z.string().min(1) }).parse(await daytona("/app-portal-access", "POST"));
  // Same token-region convention used by the official Svix SDK.
  const region = portal.token.split(".")[1];
  const svixApiUrl = input.svixApiUrl ?? (["us", "eu", "in", "ca", "au"].includes(region ?? "")
    ? `https://api.${region}.svix.com` : "https://api.svix.com");
  const uid = `rally-terminal-${createHash("sha256").update(input.webhookUrl).digest("hex").slice(0, 32)}`;
  const collectionPath = `/api/v1/app/${encodeURIComponent(input.organizationId)}/endpoint`;
  const matches: Array<z.infer<typeof EndpointSchema>> = [];
  let iterator: string | null = null;
  do {
    const page = z.object({ data: z.array(EndpointSchema), done: z.boolean(), iterator: z.string().nullable() }).parse(
      await request(svixApiUrl, portal.token, `${collectionPath}${iterator ? `?iterator=${encodeURIComponent(iterator)}` : ""}`),
    );
    matches.push(...page.data.filter((endpoint) => endpoint.url === input.webhookUrl));
    if (page.done) break;
    if (!page.iterator || page.iterator === iterator) throw new Error("Svix endpoint pagination did not advance");
    iterator = page.iterator;
  } while (true);
  if (matches.length > 1) throw new Error("Multiple Svix endpoints already target this URL; reconcile the duplicate registrations first");
  // Adopt a manually registered endpoint too, preserving its signing secret.
  const endpointPath = `${collectionPath}/${encodeURIComponent(matches[0]?.id ?? uid)}`;
  const svix = (suffix: string, method = "GET", body?: unknown) => request(svixApiUrl, portal.token, `${endpointPath}${suffix}`, method, body);
  const endpoint = EndpointSchema.parse(await svix("", "PUT", {
    url: input.webhookUrl, version: 1, disabled: true,
    description: "Rally Terminal provider state reconciliation", filterTypes: EVENTS,
  }));
  const { key: secret } = z.object({ key: z.string().startsWith("whsec_") }).parse(await svix("/secret"));
  await input.installSecrets({ DAYTONA_WEBHOOK_SECRET: secret, DAYTONA_ORGANIZATION_ID: input.organizationId });
  const probe = JSON.stringify({ event: "rally.receiver.probe", id: randomUUID(), organizationId: input.organizationId });
  const response = await fetcher(input.webhookUrl, { method: "POST", headers: signedDaytonaHeaders(secret, probe), body: probe, redirect: "error" });
  if (!response.ok || !z.object({ accepted: z.literal(true) }).safeParse(await response.json()).success) {
    throw new Error(`Daytona webhook receiver probe failed: HTTP ${response.status}; endpoint remains disabled`);
  }
  await svix("", "PATCH", { disabled: false });
  const verified = EndpointSchema.parse(await svix(""));
  if (verified.disabled || verified.url !== input.webhookUrl || EVENTS.some((event) => !verified.filterTypes?.includes(event))) {
    throw new Error("Daytona webhook endpoint readback did not match configuration");
  }
  await daytona("/refresh-endpoints", "POST");
  return { endpointId: endpoint.id, secret };
}
