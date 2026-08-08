#!/usr/bin/env node
// Calls GET /health on the regional APIs and fails unless every required check
// passes in every requested region. Runbook step 7 of an ordinary release, and
// the gate that blocks desktop distribution for a failing region.
//
// Usage:
//   node scripts/check-regional-health.mjs            # both regions
//   node scripts/check-regional-health.mjs eu         # one region
//   AVALON_GLOBAL_API_URL=... node scripts/check-regional-health.mjs global

const DEFAULT_BASE_URLS = {
  global: "https://api.with-avalon.com",
  eu: "https://eu.api.with-avalon.com",
};

const ATTEMPTS = Number(process.env.AVALON_HEALTH_ATTEMPTS ?? "5");
const RETRY_BASE_MS = Number(process.env.AVALON_HEALTH_RETRY_BASE_MS ?? "10000");
const REQUEST_TIMEOUT_MS = Number(process.env.AVALON_HEALTH_TIMEOUT_MS ?? "30000");

function baseUrlForRegion(region) {
  const override = region === "eu" ? process.env.AVALON_EU_API_URL : process.env.AVALON_GLOBAL_API_URL;
  return (override ?? DEFAULT_BASE_URLS[region]).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHealth(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status} returned a non-JSON body: ${text.slice(0, 300)}`);
  }
  return { status: response.status, body };
}

function failedCheckNames(body) {
  const checks = body && typeof body.checks === "object" ? body.checks : {};
  return Object.entries(checks)
    .filter(([, check]) => check && check.ok === false)
    .map(([name, check]) => `${name} (${check.message})`);
}

async function checkRegion(region) {
  const url = `${baseUrlForRegion(region)}/health`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const { status, body } = await readHealth(url);
      if (body.ok === true && status === 200) {
        console.log(`${region}: healthy (${url})`);
        const reported = failedCheckNames(body);
        if (reported.length > 0) console.log(`${region}: non-blocking checks not configured: ${reported.join(", ")}`);
        return true;
      }
      console.warn(
        `${region}: attempt ${attempt}/${ATTEMPTS} unhealthy (HTTP ${status}); failing checks: ${
          failedCheckNames(body).join(", ") || "none reported"
        }`,
      );
    } catch (error) {
      console.warn(`${region}: attempt ${attempt}/${ATTEMPTS} failed: ${error instanceof Error ? error.message : error}`);
    }
    if (attempt < ATTEMPTS) await sleep(RETRY_BASE_MS * attempt);
  }
  console.error(`${region}: health check failed after ${ATTEMPTS} attempts (${url})`);
  return false;
}

const requested = process.argv.slice(2).filter((value) => value.length > 0);
const regions = requested.length > 0 ? requested : ["eu", "global"];
const unknown = regions.filter((region) => !(region in DEFAULT_BASE_URLS));
if (unknown.length > 0) {
  console.error(`Unknown region(s): ${unknown.join(", ")}. Expected one or more of: eu, global.`);
  process.exit(2);
}

// Sequential so the log reads as an ordered release record.
let allHealthy = true;
for (const region of regions) {
  const healthy = await checkRegion(region);
  allHealthy = allHealthy && healthy;
}
process.exit(allHealthy ? 0 : 1);
