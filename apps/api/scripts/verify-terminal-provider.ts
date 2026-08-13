/// <reference types="node" />

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";

import { parseTerminalRegionConfiguration } from "../src/services/terminal/contract";
import { createDaytonaTerminalProvider, isTerminalProviderNotFound } from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import {
  terminalBaselineHostAcceptanceCommand,
  terminalPackageManagerAcceptanceCommand,
  terminalSnapshotProbeCommand,
} from "../src/services/terminal/snapshot-manifest";

function requiredUrl(name: string): URL {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is required for the real Daytona provider acceptance probe`);
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${name} must be an HTTPS URL`);
  return url;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

const configuration = parseTerminalRegionConfiguration(process.env);
if (configuration.capability !== "supported" || configuration.emergencyDisabled) {
  throw new Error("Set a supported, enabled Terminal region configuration before running the provider probe");
}

const redirectUrl = requiredUrl("TERMINAL_PROBE_REDIRECT_URL");
const privateDnsUrl = requiredUrl("TERMINAL_PROBE_PRIVATE_DNS_URL");
const policy = compileTerminalNetworkPolicy("trusted_only", [redirectUrl.hostname, privateDnsUrl.hostname]);
const provider = createDaytonaTerminalProvider(configuration);
const stableName = `avalon-terminal-probe-${randomUUID()}`;
let sandboxId: string | null = null;

async function run(
  command: string,
  expectedExit: "zero" | "nonzero",
  task: string,
  timeoutMs = 120_000,
): Promise<void> {
  const result = await provider.runCommand(sandboxId!, {
    taskName: `${task}-${randomUUID()}`,
    command,
    cwd: "/workspace",
    timeoutMs,
  });
  const passed = expectedExit === "zero" ? result.exitCode === 0 : result.exitCode !== 0;
  if (!passed) {
    throw new Error(`${task} expected ${expectedExit} exit, received ${result.exitCode}: ${result.stderr.slice(0, 1_000)}`);
  }
}

function privateAddress(address: string): boolean {
  return /^(?:10\.|127\.|169\.254\.|192\.168\.)/u.test(address)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(address)
    || address === "::1"
    || /^f[cd][0-9a-f]{2}:/iu.test(address)
    || /^fe[89ab][0-9a-f]:/iu.test(address);
}

const redirectResponse = await fetch(redirectUrl, { redirect: "manual" });
const redirectLocation = redirectResponse.headers.get("location");
if (redirectResponse.status < 300 || redirectResponse.status >= 400 || !redirectLocation) {
  throw new Error("TERMINAL_PROBE_REDIRECT_URL must be a live HTTP redirect");
}
const redirectTarget = new URL(redirectLocation, redirectUrl);
if (redirectTarget.hostname === redirectUrl.hostname) {
  throw new Error("TERMINAL_PROBE_REDIRECT_URL must redirect to a different hostname");
}
const privateAddresses = await lookup(privateDnsUrl.hostname, { all: true });
if (privateAddresses.length === 0 || privateAddresses.some((entry) => !privateAddress(entry.address))) {
  throw new Error("TERMINAL_PROBE_PRIVATE_DNS_URL must resolve only to private or loopback addresses");
}

let probeError: unknown;
try {
  const created = await provider.createSandbox({
    stableName,
    workspaceId: "provider-acceptance",
    workstreamId: randomUUID(),
    generation: 1,
    // Establish that the public negative targets are healthy from this exact
    // Daytona location before using them to prove Trusted-only denial.
    domainAllowList: [],
    environment: { AVALON_RESOURCE_DIR: "/workspace/.avalon-output" },
  });
  sandboxId = created.id;
  if (created.domainAllowList.length !== 0) throw new Error("Daytona did not report Full-internet create state");

  await run(terminalSnapshotProbeCommand(), "zero", "snapshot");
  await run("curl --fail --silent --show-error --max-time 15 https://example.com/ >/dev/null", "zero", "full-internet-public-control");
  await run(`curl --fail --silent --show-error --location --max-redirs 3 --max-time 15 ${shellQuote(redirectUrl.href)} >/dev/null`, "zero", "full-internet-redirect-control");
  await run(`curl --fail --silent --show-error --max-time 15 ${shellQuote(privateDnsUrl.href)} >/dev/null`, "nonzero", "private-dns");

  await provider.stopSandbox(sandboxId);
  await provider.updateNetworkPolicy(sandboxId, policy.effectiveDomains);
  const trusted = await provider.getSandbox(sandboxId);
  if (trusted.domainAllowList.slice().sort().join("\n") !== policy.effectiveDomains.slice().sort().join("\n")) {
    throw new Error("Daytona did not report the requested Trusted-only domain allowlist");
  }
  await provider.startSandbox(sandboxId);
  await run(terminalBaselineHostAcceptanceCommand(), "zero", "baseline-hosts", 240_000);
  await run(terminalPackageManagerAcceptanceCommand(), "zero", "package-manager-installs", 600_000);
  await run("curl --fail --silent --show-error --max-time 15 https://example.com/ >/dev/null", "nonzero", "denied-domain");
  await run("curl --fail --silent --show-error --max-time 15 https://1.1.1.1/ >/dev/null", "nonzero", "direct-ip");
  await run(`curl --fail --silent --show-error --location --max-redirs 3 --max-time 15 ${shellQuote(redirectUrl.href)} >/dev/null`, "nonzero", "redirect-escape");
  await run("curl --fail --silent --show-error --max-time 5 http://169.254.169.254/latest/meta-data/ >/dev/null", "nonzero", "metadata-address");

  await provider.stopSandbox(sandboxId);
  await provider.startSandbox(sandboxId);
  await run("test -d /workspace", "zero", "restart");
  await provider.archiveSandbox(sandboxId);
  await provider.startSandbox(sandboxId);
  await run("test -d /workspace", "zero", "restore");
} catch (error) {
  probeError = error;
}

if (sandboxId) {
  const deletedId = sandboxId;
  await provider.deleteSandbox(deletedId);
  try {
    await provider.getSandbox(deletedId);
    throw new Error("Daytona still returned the sandbox after confirmed deletion");
  } catch (error) {
    if (!isTerminalProviderNotFound(error)) throw error;
  }
}
if (probeError) throw probeError;
process.stdout.write(`Automated Terminal provider probe passed for snapshot ${configuration.snapshot}\n`);
