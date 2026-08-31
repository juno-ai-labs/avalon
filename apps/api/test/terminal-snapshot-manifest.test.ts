import { describe, expect, it } from "vitest";

import {
  TERMINAL_SNAPSHOT_PROBES,
  terminalBaselineHostAcceptanceCommand,
  terminalManagedSnapshotBootstrapCommand,
  terminalPackageManagerAcceptanceCommand,
  terminalSnapshotImageBuildCommand,
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

  it("owns every directory it writes into, naming .rally itself rather than creating it as an intermediate", () => {
    // `install -d` creates missing intermediate components, but applies -o/-g
    // only to the operands it is given. If `/workspace/.rally` is reached only
    // through `/workspace/.rally/tmp`, it lands root-owned and the sandbox user
    // cannot create `session.env`, `publications/`, or `logs/` directly beneath
    // it — which is every repository bootstrap.
    const command = terminalManagedSnapshotBootstrapCommand();
    const install = command.split("\n").find((line) => line.includes("install -d"));
    expect(install).toBeDefined();
    const operands = install!.slice(install!.indexOf("/workspace")).split(" ");
    expect(operands).toContain("/workspace/.rally");
    expect(operands).toContain("/workspace/.rally-output");
    expect(operands).toContain("/workspace/.rally/resources");
    expect(operands).toContain("/workspace/.rally/tmp");
    expect(operands.some((operand) => operand.includes(".avalon"))).toBe(false);
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

  it("installs both Node capabilities in a single npm invocation", () => {
    // Two `npm install --global` calls each pay npm's start-up and registry
    // handshake before installing anything: 3.3s split against 1.5s combined,
    // on the critical path of the participant's first Terminal tool.
    const command = terminalManagedSnapshotBootstrapCommand();
    const invocations = command.split("\n").filter((line) => line.includes("npm install --global"));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("$node_packages");
    expect(command).toContain("node_packages=\"$node_packages pnpm@11.13.0\"");
    expect(command).toContain("node_packages=\"$node_packages tsx@4.20.6\"");
    // The whole block stays a no-op on a snapshot that already ships both.
    expect(command).toContain("if [ -n \"$node_packages\" ]");
  });

  it("runs every probe concurrently and fails closed naming all missing capabilities", () => {
    const command = terminalSnapshotProbeCommand();
    const backgrounded = command.split("\n").filter((line) => line.endsWith("&"));
    expect(backgrounded).toHaveLength(TERMINAL_SNAPSHOT_PROBES.length);
    expect(command).toContain("wait");
    for (const probe of TERMINAL_SNAPSHOT_PROBES) {
      expect(command).toContain(`>"$probe_results/${probe.id}"`);
      expect(command).toContain(probe.command);
    }
    // A probe that fails writes no marker; the sweep after `wait` is what makes
    // a missing capability non-zero rather than merely unreported.
    expect(command).toContain("AVALON_PROBE_MISSING=");
    expect(command).toContain("exit 1");
    expect(command).toContain("trap 'rm -rf -- \"$probe_results\"' EXIT");
  });

  it("bakes the bootstrap into one Dockerfile-safe line", () => {
    // Daytona rejected the first version of this with
    // `dockerfile parse error on line 3: unknown instruction: sudo`: the
    // bootstrap is multi-line, a Dockerfile instruction is not, and the parser
    // splits the RUN before any shell sees the quoting.
    const command = terminalSnapshotImageBuildCommand();
    expect(command).not.toContain("\n");
    expect(command).not.toContain("'");
    expect(command).not.toContain("\"");
    // Byte-identical to what the runtime would otherwise have run, so the image
    // and the runtime cannot disagree about what "prepared" means.
    const encoded = command.match(/^echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash -l$/u);
    expect(encoded).not.toBeNull();
    expect(Buffer.from(encoded![1]!, "base64").toString("utf8"))
      .toBe(terminalManagedSnapshotBootstrapCommand());
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
