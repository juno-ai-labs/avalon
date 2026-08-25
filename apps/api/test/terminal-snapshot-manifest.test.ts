import { describe, expect, it } from "vitest";

import {
  TERMINAL_SNAPSHOT_PROBES,
  terminalBaselineHostAcceptanceCommand,
  terminalManagedSnapshotBootstrapCommand,
  terminalPackageManagerAcceptanceCommand,
  terminalSnapshotProbeCommand,
} from "../src/services/terminal/snapshot-manifest";

describe("Terminal snapshot manifest", () => {
  it("pins every language and package manager promised by the Terminal prompt", () => {
    expect(TERMINAL_SNAPSHOT_PROBES.map((probe) => probe.id)).toEqual([
      "bash",
      "python",
      "javascript",
      "typescript",
      "sqlite",
      "apt",
      "dpkg",
      "pip",
      "uv",
      "npm",
      "pnpm",
      "git",
      "git-ca",
      "gh",
      "sudo",
    ]);
    expect(TERMINAL_SNAPSHOT_PROBES.every((probe) => probe.command.length > 0)).toBe(true);
  });

  it("fails the provider probe on the first missing runtime and emits no secrets", () => {
    const command = terminalSnapshotProbeCommand();
    expect(command).toContain("set -euo pipefail");
    expect(command).toContain("python3 -c");
    expect(command).toContain("node -e");
    expect(command).toContain("sqlite3 :memory:");
    expect(command).toContain("test -d /workspace/.rally/tmp");
    expect(command).toContain("test -d /workspace/.rally-output");
    expect(command).not.toMatch(/token|secret|credential/iu);
  });

  it("idempotently adapts Daytona's managed default snapshot and reports installed gaps", () => {
    const command = terminalManagedSnapshotBootstrapCommand();
    expect(command).toContain("sudo -n install");
    expect(command).toContain("command -v sqlite3");
    expect(command).toContain("command -v gh");
    expect(command).toContain("pnpm@11.13.0");
    expect(command).toContain("tsx@4.20.6");
    expect(command).toContain("AVALON_BOOTSTRAP_INSTALLED=");
    expect(command).not.toContain("python3 -c");
    expect(command).not.toContain("gh --version");
  });

  it("functionally exercises every supported installer in Trusted only", () => {
    const command = terminalPackageManagerAcceptanceCommand();
    expect(command).toContain("sudo -n apt-get update");
    expect(command).toContain("apt-get download");
    expect(command).toContain("dpkg-deb --info");
    expect(command).toContain("python3 -m pip install");
    expect(command).toContain("uv pip install");
    expect(command).toContain("npm install");
    expect(command).toContain("pnpm add");
    expect(command).toContain("tsc fixture.ts");
    expect(command).not.toMatch(/token|secret|credential/iu);
  });

  it("probes every non-package immutable host group", () => {
    const command = terminalBaselineHostAcceptanceCommand();
    for (const host of [
      "api.github.com",
      "github.com",
      "raw.githubusercontent.com",
      "objects.githubusercontent.com",
      "api.rallywith.ai",
      "eu.api.rallywith.ai",
      "astral.sh",
      "get.pnpm.io",
      "pypi.org",
      "files.pythonhosted.org",
      "registry.npmjs.org",
    ]) expect(command).toContain(host);
    expect(command).toContain('GIT_SSL_CAINFO="$CURL_CA_BUNDLE" git ls-remote');
  });
});
