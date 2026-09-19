import "../../../tests/isolated-region";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TERMINAL_SNAPSHOT_PROBES,
  TERMINAL_SNAPSHOT_RESOURCES,
  terminalBaselineHostAcceptanceCommand,
  terminalManagedSnapshotBootstrapCommand,
  terminalPackageManagerAcceptanceCommand,
  terminalProbeRunnerCommand,
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

  it("probes every promised runtime from the pinned command text and emits no secrets", () => {
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

  it("executes the probe runner and fails closed naming every missing capability", () => {
    // The sweep after `wait` is what makes a failing probe fatal, and a string
    // match on "exit 1" survives the sweep being broken. Run the generated
    // script with probes that pass and fail, against a temporary workspace root.
    const root = mkdtempSync(join(tmpdir(), "avalon-probe-root-"));
    try {
      mkdirSync(join(root, ".rally", "tmp"), { recursive: true });
      mkdirSync(join(root, ".rally-output"), { recursive: true });
      const run = (probes: readonly { id: string; command: string }[]): { status: number; stdout: string } => {
        const result = spawnSync("bash", ["-c", terminalProbeRunnerCommand(probes, root)], { encoding: "utf8" });
        return { status: result.status ?? -1, stdout: result.stdout };
      };

      const failing = run([
        { id: "alpha", command: "true" },
        { id: "beta", command: "false" },
        { id: "gamma", command: "command -v definitely-not-installed-xyz" },
      ]);
      expect(failing.status).toBe(1);
      expect(failing.stdout).toContain("AVALON_PROBE_MISSING=beta gamma");

      const passing = run([{ id: "alpha", command: "true" }, { id: "beta", command: "true" }]);
      expect(passing.status).toBe(0);
      expect(passing.stdout).toContain("alpha:ok");
      expect(passing.stdout).toContain("beta:ok");
      // The EXIT trap removes the marker directory on both paths.
      expect(readdirSync(join(root, ".rally", "tmp"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the Git CA only for a sandbox created with a domain allow list", () => {
    // A Trusted-only sandbox is intercepted and Daytona advertises the CA to it;
    // one that lacks the bundle would pass the optional probe and fail at its
    // first Git operation. The full-internet probes keep the optional form.
    const optional = TERMINAL_SNAPSHOT_PROBES.find((entry) => entry.id === "git-ca")!.command;
    expect(terminalSnapshotProbeCommand()).toContain(optional);
    expect(terminalSnapshotProbeCommand({ requireGitCa: false })).toContain(optional);
    const required = terminalSnapshotProbeCommand({ requireGitCa: true });
    expect(required).not.toContain(optional);
    expect(required).toContain('test -n "${CURL_CA_BUNDLE:-}" && test -f "$CURL_CA_BUNDLE"');
    expect(required.split("\n").filter((line) => line.includes("git-ca:ok"))).toHaveLength(1);
  });

  it("accepts an absent Git CA and still rejects a broken one", () => {
    // Daytona advertises its proxy CA only for sandboxes created with a domain
    // allow list, so a full-internet sandbox legitimately has none. Requiring it
    // failed those sandboxes on every snapshot, the managed one included, and
    // blocked Terminal entirely for any workspace on full-internet networking.
    const probe = TERMINAL_SNAPSHOT_PROBES.find((entry) => entry.id === "git-ca")!;
    const run = (env: NodeJS.ProcessEnv): number => {
      try {
        execFileSync("bash", ["-c", `set -euo pipefail\n${probe.command}`], { env, stdio: "ignore" });
        return 0;
      } catch {
        return 1;
      }
    };
    const directory = mkdtempSync(join(tmpdir(), "avalon-git-ca-"));
    try {
      const populated = join(directory, "bundle.pem");
      const empty = join(directory, "empty.pem");
      writeFileSync(populated, "test certificate bundle");
      writeFileSync(empty, "");

      // Not advertised: nothing to verify, nothing to fail.
      expect(run({ PATH: process.env.PATH })).toBe(0);
      // Advertised and usable.
      expect(run({ PATH: process.env.PATH, CURL_CA_BUNDLE: populated })).toBe(0);
      // Advertised but a lie — still fails closed, which is the point of the probe.
      expect(run({ PATH: process.env.PATH, CURL_CA_BUNDLE: empty })).toBe(1);
      expect(run({ PATH: process.env.PATH, CURL_CA_BUNDLE: join(directory, "absent.pem") })).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      "enterprise.api.with-avalon.com",
      "astral.sh",
      "get.pnpm.io",
      "pypi.org",
      "files.pythonhosted.org",
      "registry.npmjs.org",
    ]) expect(command).toContain(host);
    expect(command).toContain('GIT_SSL_CAINFO="$CURL_CA_BUNDLE" git ls-remote');
  });

  it("builds every sandbox at the size the team set", () => {
    // Pinned as a literal rather than read from the constant: this is the team's
    // number, and the only thing that should be able to change it is a diff a
    // reviewer sees. Everything else in this file derives its expectations from
    // the constant, so a manifest edited to 2 / 4 / 7 would otherwise go green.
    expect(TERMINAL_SNAPSHOT_RESOURCES).toEqual({ cpu: 2, memory: 4, disk: 8 });
  });
});
