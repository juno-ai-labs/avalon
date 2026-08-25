/// <reference types="node" />

import { randomUUID } from "node:crypto";

import { parseTerminalRegionConfiguration } from "../src/services/terminal/contract";
import {
  createDaytonaTerminalProvider,
  isTerminalProviderNotFound,
  type TerminalProviderOperationMeasurement,
} from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { terminalSnapshotProbeCommand } from "../src/services/terminal/snapshot-manifest";
import { verifyTerminalRestartAndRestore } from "./terminal-provider-lifecycle";

const configuration = parseTerminalRegionConfiguration(process.env);
if (configuration.capability !== "supported" || configuration.emergencyDisabled) {
  throw new Error("Set a supported, enabled Terminal region configuration before running the provider interface probe");
}

const measurements: TerminalProviderOperationMeasurement[] = [];
const provider = createDaytonaTerminalProvider(configuration, undefined, {
  observe: (measurement) => measurements.push(measurement),
});
const stableName = `avalon-terminal-interface-probe-${randomUUID()}`;
const policy = compileTerminalNetworkPolicy("trusted_only", []);
let sandboxId: string | null = null;
let probeError: unknown;

async function run(command: string, task: string, timeoutMs = 120_000): Promise<void> {
  const result = await provider.runCommand(sandboxId!, {
    taskName: `${task}-${randomUUID()}`,
    command,
    cwd: "/workspace",
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${task} exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 1_000)}`);
  }
}

try {
  const created = await provider.createSandbox({
    stableName,
    workspaceId: "provider-interface-probe",
    workstreamId: randomUUID(),
    generation: 1,
    domainAllowList: [],
    environment: { AVALON_RESOURCE_DIR: "/workspace/.rally-output" },
  });
  sandboxId = created.id;
  if (created.domainAllowList.length !== 0) throw new Error("Daytona did not report Full-internet create state");
  await provider.prepareSandbox?.(sandboxId, []);
  await run("printf 'session-ok\\n'", "command-session");

  const path = "/workspace/.rally/tmp/provider-interface-round-trip.bin";
  const source = new Uint8Array([0, 1, 2, 10, 13, 127, 128, 254, 255]);
  await provider.writeFile(sandboxId, path, source, new AbortController().signal);
  const downloaded = await provider.readFile(sandboxId, path);
  if (downloaded.length !== source.length || downloaded.some((value, index) => value !== source[index])) {
    throw new Error("Daytona filesystem upload/download changed the provider probe bytes");
  }
  await run(
    `expected=${JSON.stringify(path)}; if [ ! -f "$expected" ]; then find /workspace -name provider-interface-round-trip.bin -print >&2; exit 44; fi; actual=$(stat -c %s "$expected"); if [ "$actual" -ne ${source.byteLength} ]; then printf 'size=%s\\n' "$actual" >&2; exit 45; fi`,
    "filesystem-round-trip",
  );
  await run(terminalSnapshotProbeCommand(), "snapshot");

  await verifyTerminalRestartAndRestore(provider, sandboxId, async (phase) => {
    await run(`test -f '${path}'`, phase);
  });

  await provider.stopSandbox(sandboxId);
  await provider.updateNetworkPolicy(sandboxId, policy.effectiveDomains);
  const trusted = await provider.getSandbox(sandboxId);
  if (trusted.domainAllowList.slice().sort().join("\n") !== policy.effectiveDomains.slice().sort().join("\n")) {
    throw new Error("Daytona did not report the requested Trusted-only domain allowlist");
  }
  await provider.startSandbox(sandboxId);
  await run(`test -f '${path}'`, "policy-restart");
} catch (error) {
  probeError = error;
}

if (sandboxId) {
  const deletedId = sandboxId;
  try {
    await provider.deleteSandbox(deletedId);
    try {
      await provider.getSandbox(deletedId);
      throw new Error("Daytona still returned the sandbox after confirmed deletion");
    } catch (error) {
      if (!isTerminalProviderNotFound(error)) throw error;
    }
  } catch (cleanupError) {
    probeError = probeError
      ? new AggregateError([probeError, cleanupError], "Provider interface probe and cleanup both failed")
      : cleanupError;
  }
}

for (const measurement of measurements) {
  process.stdout.write(
    `Daytona timing ${measurement.operation} ${measurement.outcome}: total=${measurement.durationMs}ms create=${measurement.providerCreateMs}ms readback=${measurement.policyReadbackMs}ms install=${measurement.installMs}ms verify=${measurement.verifyMs}ms source=${measurement.sourceState} installed=${measurement.installedCapabilities.join(",") || "none"}\n`,
  );
}
if (probeError) throw probeError;
process.stdout.write(`Daytona provider interface probe passed for snapshot ${configuration.snapshot}\n`);
