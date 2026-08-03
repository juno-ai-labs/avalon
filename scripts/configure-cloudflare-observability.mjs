import { createHash } from "node:crypto";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
}

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };

async function cloudflare(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const messages = (payload.errors ?? []).map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(`Cloudflare request failed (${response.status})${messages ? `: ${messages}` : ""}`);
  }
  return payload.result;
}

const permissionGroups = await cloudflare("/tokens/permission_groups");
const bucketWrite = permissionGroups.find((group) =>
  group.name === "Workers R2 Storage Bucket Item Write" && group.scopes?.includes("com.cloudflare.edge.r2.bucket"));
if (!bucketWrite) throw new Error("Workers R2 Storage Bucket Item Write permission is unavailable");

const configurations = [
  {
    region: "global",
    jurisdiction: "default",
    bucket: "avalon-global-observability",
    script: "avalon-api-global",
  },
  {
    region: "eu",
    jurisdiction: "eu",
    bucket: "avalon-eu-observability",
    script: "avalon-api-eu",
  },
];

const jobs = await cloudflare("/logpush/jobs?dataset=workers_trace_events");
const tokens = await cloudflare("/tokens");

for (const configuration of configurations) {
  const jobName = `avalon-${configuration.region}-workers-trace-r2`;
  if (jobs.some((job) => job.name === jobName)) {
    console.info(`${jobName}: already configured`);
    continue;
  }

  const tokenName = `${jobName}-writer`;
  for (const token of tokens.filter((candidate) => candidate.name === tokenName)) {
    await cloudflare(`/tokens/${token.id}`, { method: "DELETE" });
  }

  const resource = `com.cloudflare.edge.r2.bucket.${accountId}_${configuration.jurisdiction}_${configuration.bucket}`;
  const writer = await cloudflare("/tokens", {
    method: "POST",
    body: JSON.stringify({
      name: tokenName,
      policies: [{
        effect: "allow",
        resources: { [resource]: "*" },
        permission_groups: [{ id: bucketWrite.id, name: bucketWrite.name }],
      }],
    }),
  });

  try {
    const secretAccessKey = createHash("sha256").update(writer.value).digest("hex");
    // Newly minted R2 account tokens are eventually visible to the S3 gateway.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const query = new URLSearchParams({
      region: "auto",
      "access-key-id": writer.id,
      "secret-access-key": secretAccessKey,
      endpoint: configuration.jurisdiction === "eu"
        ? `${accountId}.eu.r2.cloudflarestorage.com`
        : `${accountId}.r2.cloudflarestorage.com`,
    });
    await cloudflare("/logpush/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: jobName,
        dataset: "workers_trace_events",
        destination_conf: `s3://${configuration.bucket}/workers-trace/{DATE}?${query}`,
        enabled: true,
        filter: JSON.stringify({ where: { key: "ScriptName", operator: "eq", value: configuration.script } }),
        output_options: {
          field_names: [
            "CPUTimeMs",
            "Entrypoint",
            "Event",
            "EventTimestampMs",
            "EventType",
            "Exceptions",
            "Logs",
            "Outcome",
            "ScriptName",
            "ScriptVersion",
            "WallTimeMs",
          ],
          sample_rate: 1,
          timestamp_format: "rfc3339",
        },
      }),
    });
    console.info(`${jobName}: configured`);
  } catch (error) {
    await cloudflare(`/tokens/${writer.id}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}
