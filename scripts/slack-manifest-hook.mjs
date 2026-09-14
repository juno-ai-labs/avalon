import { configuredRegions, regions } from "./regions.mjs";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../config/provider-apps/slack.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

function httpsOrigin(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url.origin;
}

const apiUrls = configuredRegions.map((region) => httpsOrigin(`SLACK_MANIFEST_API_${regions[region].bindingPrefix}_BASE_URL`)).filter(Boolean);
const ingress = httpsOrigin("SLACK_MANIFEST_INGRESS_BASE_URL");
const displayName = process.env.SLACK_MANIFEST_NAME?.trim();

if (displayName) manifest.display_information.name = displayName;
if (apiUrls.length) {
  manifest.oauth_config.redirect_urls = apiUrls
    .filter(Boolean)
    .map((base) => `${base}/connections/slack/callback`);
}
if (ingress) {
  for (const command of manifest.features.slash_commands ?? []) {
    command.url = `${ingress}/slack/commands`;
  }
  manifest.settings.event_subscriptions.request_url = `${ingress}/slack/events`;
  manifest.settings.interactivity.request_url = `${ingress}/slack/interactivity`;
}
process.stdout.write(`${JSON.stringify(manifest)}\n`);
