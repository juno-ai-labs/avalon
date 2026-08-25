#!/usr/bin/env node
// Calls GET /health on the regional APIs and fails unless every required check
// passes in every requested region. Runbook step 7 of an ordinary release, and
// the gate that blocks desktop distribution for a failing region.
//
// Usage:
//   node scripts/check-regional-health.mjs            # both regions
//   node scripts/check-regional-health.mjs eu         # one region
//   AVALON_GLOBAL_API_URL=... node scripts/check-regional-health.mjs global

import { isEntryPoint } from "./entry-point.mjs";

const DEFAULT_BASE_URLS = {
  global: "https://api.rallywith.ai",
  eu: "https://eu.api.rallywith.ai",
};

const ATTEMPTS = Number(process.env.AVALON_HEALTH_ATTEMPTS ?? "5");
const RETRY_BASE_MS = Number(process.env.AVALON_HEALTH_RETRY_BASE_MS ?? "10000");
const REQUEST_TIMEOUT_MS = Number(process.env.AVALON_HEALTH_TIMEOUT_MS ?? "30000");

export function baseUrlForRegion(region) {
  const override = region === "eu" ? process.env.AVALON_EU_API_URL : process.env.AVALON_GLOBAL_API_URL;
  return (override ?? DEFAULT_BASE_URLS[region]).replace(/\/+$/u, "");
}

export function parseRegions(argv) {
  const requested = argv.filter((value) => value.length > 0);
  const regions = requested.length > 0 ? requested : ["eu", "global"];
  const unknown = regions.filter((region) => !(region in DEFAULT_BASE_URLS));
  if (unknown.length > 0) {
    throw new Error(`Unknown region(s): ${unknown.join(", ")}. Expected one or more of: eu, global.`);
  }
  return regions;
}

export function failedCheckNames(body) {
  const checks = body && typeof body.checks === "object" && body.checks !== null ? body.checks : {};
  return Object.entries(checks)
    .filter(([, check]) => check && check.ok === false)
    .map(([name, check]) => `${name} (${check.message})`);
}

// The Worker answers 200 with ok:true only when every required check passes, so
// both must hold: a 200 carrying ok:false, or any other status, is unhealthy.
export function isHealthy(status, body) {
  return status === 200 && body?.ok === true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHealth(url, fetchHealth) {
  const response = await fetchHealth(url, {
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

export async function checkRegion(region, {
  fetchHealth = globalThis.fetch,
  wait = sleep,
  attempts = ATTEMPTS,
  log = console.log,
  warn = console.warn,
  error = console.error,
} = {}) {
  const url = `${baseUrlForRegion(region)}/health`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { status, body } = await readHealth(url, fetchHealth);
      if (isHealthy(status, body)) {
        log(`${region}: healthy (${url})`);
        const reported = failedCheckNames(body);
        if (reported.length > 0) log(`${region}: non-blocking checks not configured: ${reported.join(", ")}`);
        return true;
      }
      warn(
        `${region}: attempt ${attempt}/${attempts} unhealthy (HTTP ${status}); failing checks: ${
          failedCheckNames(body).join(", ") || "none reported"
        }`,
      );
    } catch (caught) {
      warn(`${region}: attempt ${attempt}/${attempts} failed: ${caught instanceof Error ? caught.message : caught}`);
    }
    if (attempt < attempts) await wait(RETRY_BASE_MS * attempt);
  }
  error(`${region}: health check failed after ${attempts} attempts (${url})`);
  return false;
}

export async function checkRegions(regions, options = {}) {
  let allHealthy = true;
  // Sequential so the log reads as an ordered release record.
  for (const region of regions) {
    const healthy = await checkRegion(region, options);
    allHealthy = allHealthy && healthy;
  }
  return allHealthy;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const regions = parseRegions(process.argv.slice(2));
    process.exit((await checkRegions(regions)) ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Regional health check failed");
    process.exit(2);
  }
}
