/// <reference types="node" />
import { spawn } from "node:child_process";
import { Daytona } from "@daytona/sdk";
import { provisionDaytonaWebhook, signedDaytonaHeaders } from "./daytona-webhook-provisioning";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}
const configIndex = process.argv.indexOf("--config");
const config = configIndex === -1 ? undefined : process.argv[configIndex + 1];
if (!config) throw new Error("Pass --config <regional API wrangler config>; deploy the receiver before provisioning");
const apiKey = required("DAYTONA_API_KEY");
const apiUrl = required("DAYTONA_API_URL");
const organizationId = required("DAYTONA_ORGANIZATION_ID");
const webhookUrl = required("DAYTONA_WEBHOOK_URL");
const result = await provisionDaytonaWebhook({
  apiKey, apiUrl, organizationId, webhookUrl,
  ...(process.env.SVIX_API_URL ? { svixApiUrl: process.env.SVIX_API_URL } : {}),
  installSecrets: (secrets) => new Promise<void>((resolve, reject) => {
    // Pipe secrets directly; never place them in argv, logs, or a file.
    const child = spawn("pnpm", ["exec", "wrangler", "secret", "bulk", "--config", config], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Wrangler secret installation failed (${code})`)));
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(secrets));
  }),
});
// Wake pre-existing retained sandboxes through the same signed readback path.
// The SDK iterator follows every page, including stopped and archived sandboxes.
const daytona = new Daytona({ apiKey, apiUrl });
let refreshed = 0;
for await (const sandbox of daytona.list()) {
  if (!sandbox.labels?.["rally.workspace"] || !sandbox.labels["rally.workstream"]) continue;
  const body = JSON.stringify({ event: "sandbox.state.updated", id: sandbox.id, organizationId });
  const response = await fetch(webhookUrl, { method: "POST", headers: signedDaytonaHeaders(result.secret, body), body, redirect: "error" });
  if (!response.ok) throw new Error(`Initial sandbox reconciliation failed: HTTP ${response.status}`);
  refreshed += 1;
}
console.log(`Daytona endpoint ${result.endpointId} verified; ${refreshed} sandbox refresh requests accepted.`);
