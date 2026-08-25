/// <reference types="node" />

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";

import { parseTerminalRegionConfiguration } from "../src/services/terminal/contract";
import {
  createDaytonaTerminalProvider,
  isTerminalProviderNotFound,
  type TerminalProviderOperationMeasurement,
} from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import {
  terminalBaselineHostAcceptanceCommand,
  terminalPackageManagerAcceptanceCommand,
  terminalSnapshotProbeCommand,
} from "../src/services/terminal/snapshot-manifest";
import { verifyTerminalRestartAndRestore } from "./terminal-provider-lifecycle";

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
const measurements: TerminalProviderOperationMeasurement[] = [];
const provider = createDaytonaTerminalProvider(configuration, undefined, {
  observe: (measurement) => measurements.push(measurement),
});
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
    environment: { AVALON_RESOURCE_DIR: "/workspace/.rally-output" },
  });
  sandboxId = created.id;
  if (created.domainAllowList.length !== 0) throw new Error("Daytona did not report Full-internet create state");
  await provider.prepareSandbox?.(sandboxId, []);
  await run("printf 'session-ok\\n'", "zero", "command-session");

  const roundTripPath = "/workspace/.rally/tmp/provider-interface-round-trip.bin";
  const roundTripBytes = new Uint8Array([0, 1, 2, 10, 13, 127, 128, 254, 255]);
  await provider.writeFile(sandboxId, roundTripPath, roundTripBytes, new AbortController().signal);
  const downloadedBytes = await provider.readFile(sandboxId, roundTripPath);
  if (downloadedBytes.length !== roundTripBytes.length
    || downloadedBytes.some((value, index) => value !== roundTripBytes[index])) {
    throw new Error("Daytona filesystem upload/download changed the provider probe bytes");
  }
  await run(
    `expected=${shellQuote(roundTripPath)}; if [ ! -f "$expected" ]; then find /workspace -name provider-interface-round-trip.bin -print >&2; exit 44; fi; actual=$(stat -c %s "$expected"); if [ "$actual" -ne ${roundTripBytes.byteLength} ]; then printf 'size=%s\\n' "$actual" >&2; exit 45; fi`,
    "zero",
    "filesystem-round-trip",
  );

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

  await verifyTerminalRestartAndRestore(provider, sandboxId, async (phase) => {
    await run("test -d /workspace", "zero", phase);
  });
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
for (const measurement of measurements) {
  process.stdout.write(
    `Daytona timing ${measurement.operation} ${measurement.outcome}: total=${measurement.durationMs}ms create=${measurement.providerCreateMs}ms readback=${measurement.policyReadbackMs}ms install=${measurement.installMs}ms verify=${measurement.verifyMs}ms source=${measurement.sourceState} installed=${measurement.installedCapabilities.join(",") || "none"}\n`,
  );
}
if (probeError) throw probeError;
process.stdout.write(`Automated Terminal provider probe passed for snapshot ${configuration.snapshot}\n`);
