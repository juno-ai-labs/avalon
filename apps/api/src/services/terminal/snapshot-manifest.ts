export interface TerminalSnapshotProbe {
  id: "bash" | "python" | "javascript" | "typescript" | "sqlite" | "apt" | "dpkg" | "pip" | "uv" | "npm" | "pnpm" | "git" | "git-ca" | "gh" | "sudo";
  command: string;
}

/**
 * Executable contract for the pinned Daytona snapshot. Adding a runtime or
 * manager to the model prompt requires adding a functional probe here first.
 */
export const TERMINAL_SNAPSHOT_PROBES: readonly TerminalSnapshotProbe[] = [
  { id: "bash", command: "bash -c 'set -euo pipefail; test \"$(printf avalon)\" = avalon'" },
  { id: "python", command: "python3 -c 'import json; assert json.loads(\"{\\\"ok\\\": true}\")[\"ok\"]'" },
  { id: "javascript", command: "node -e 'const value = JSON.parse(\"{\\\"ok\\\":true}\"); if (!value.ok) process.exit(1)'" },
  { id: "typescript", command: "tsc --version && tsx --version" },
  { id: "sqlite", command: "test \"$(sqlite3 :memory: 'select 6 * 7;')\" = 42" },
  { id: "apt", command: "apt-get --version" },
  { id: "dpkg", command: "dpkg --version" },
  { id: "pip", command: "python3 -m pip --version" },
  { id: "uv", command: "uv --version" },
  { id: "npm", command: "npm --version" },
  { id: "pnpm", command: "pnpm --version" },
  { id: "git", command: "git --version" },
  { id: "git-ca", command: "test -n \"${CURL_CA_BUNDLE:-}\" && test -f \"$CURL_CA_BUNDLE\" && test -s \"$CURL_CA_BUNDLE\" && test -r \"$CURL_CA_BUNDLE\"" },
  { id: "gh", command: "gh --version" },
  { id: "sudo", command: "sudo -n true" },
] as const;

/**
 * Adapts Daytona's managed default snapshot to Avalon's smaller explicit
 * capability contract. Every step is idempotent so a managed image update can
 * add a tool without fighting the bootstrap, while the probes below still fail
 * closed on an incompatible update.
 */
export function terminalManagedSnapshotBootstrapCommand(): string {
  return [
    "set -euo pipefail",
    "sudo -n install -d -o \"$(id -u)\" -g \"$(id -g)\" -m 700 /workspace /workspace/.avalon /workspace/.avalon-output /workspace/.avalon/resources /workspace/.avalon/tmp",
    "system_packages=''",
    "installed_capabilities=''",
    "if ! command -v sqlite3 >/dev/null 2>&1; then system_packages=\"$system_packages sqlite3\"; installed_capabilities=\"$installed_capabilities,sqlite3\"; fi",
    "if ! command -v gh >/dev/null 2>&1; then system_packages=\"$system_packages gh\"; installed_capabilities=\"$installed_capabilities,gh\"; fi",
    "if [ -n \"$system_packages\" ]; then sudo -n apt-get update -qq && sudo -n apt-get install -y --no-install-recommends $system_packages >/dev/null; fi",
    "if ! command -v pnpm >/dev/null 2>&1; then npm install --global 'pnpm@11.13.0' >/dev/null; installed_capabilities=\"$installed_capabilities,pnpm\"; fi",
    "if ! command -v tsx >/dev/null 2>&1; then npm install --global 'tsx@4.20.6' >/dev/null; installed_capabilities=\"$installed_capabilities,tsx\"; fi",
    "printf 'AVALON_BOOTSTRAP_INSTALLED=%s\\n' \"${installed_capabilities#,}\"",
  ].join("\n");
}

export function terminalSnapshotProbeCommand(): string {
  return [
    "set -euo pipefail",
    "test -d /workspace/.avalon/tmp",
    "test -d /workspace/.avalon-output",
    ...TERMINAL_SNAPSHOT_PROBES.flatMap((probe) => [
      probe.command,
      `printf '%s\\n' '${probe.id}:ok'`,
    ]),
  ].join("\n");
}

/**
 * Live acceptance fixtures for the package-manager behavior advertised to the
 * model. These run only in the disposable provider probe sandbox, after
 * Trusted-only egress is applied; the pinned production snapshot is never
 * mutated by this source file.
 */
export function terminalPackageManagerAcceptanceCommand(): string {
  return [
    "set -euo pipefail",
    "probe=/tmp/avalon-package-probe",
    "rm -rf -- \"$probe\"",
    "mkdir -p -- \"$probe\"",
    "trap 'rm -rf -- \"$probe\"' EXIT",
    "cd -- \"$probe\"",
    "printf 'const value: number = 42; if (value !== 42) throw new Error();\n' > fixture.ts",
    "tsc fixture.ts --outDir typescript",
    "node typescript/fixture.js",
    "sudo -n apt-get update -qq",
    "mkdir -p -- \"$probe/apt\" && cd -- \"$probe/apt\"",
    "apt-get download dash >/dev/null && test -s dash_*.deb && dpkg-deb --info dash_*.deb >/dev/null",
    "python3 -m pip install --disable-pip-version-check --no-cache-dir --target \"$probe/pip\" 'six==1.17.0' >/dev/null",
    "PYTHONPATH=\"$probe/pip\" python3 -c 'import six; assert six.__version__ == \"1.17.0\"'",
    "uv pip install --no-cache --target \"$probe/uv\" 'idna==3.10' >/dev/null",
    "PYTHONPATH=\"$probe/uv\" python3 -c 'import idna; assert idna.__version__ == \"3.10\"'",
    "npm install --prefix \"$probe/npm\" --ignore-scripts --no-audit --no-fund --save-exact 'is-number@7.0.0' >/dev/null",
    "node -e \"if (!require('$probe/npm/node_modules/is-number')(42)) process.exit(1)\"",
    "mkdir -p -- \"$probe/pnpm\" && printf '{\"private\":true}\n' > \"$probe/pnpm/package.json\"",
    "pnpm add --dir \"$probe/pnpm\" --ignore-scripts --save-exact 'is-odd@3.0.1' >/dev/null",
    "node -e \"if (!require('$probe/pnpm/node_modules/is-odd')(3)) process.exit(1)\"",
  ].join("\n");
}

/** Proves every immutable Trusted-only host outside package download traffic. */
export function terminalBaselineHostAcceptanceCommand(): string {
  const urls = [
    "https://api.github.com/meta",
    "https://github.com/",
    "https://raw.githubusercontent.com/github/gitignore/main/README.md",
    "https://objects.githubusercontent.com/",
    "https://api.rallywith.ai/health",
    "https://eu.api.rallywith.ai/health",
    "https://astral.sh/",
    "https://get.pnpm.io/install.sh",
    "https://pypi.org/simple/six/",
    "https://files.pythonhosted.org/",
    "https://registry.npmjs.org/is-number",
  ];
  return [
    "set -euo pipefail",
    ...urls.map((url) => `curl --silent --show-error --location --max-redirs 3 --max-time 20 --output /dev/null '${url}'`),
    "GIT_SSL_CAINFO=\"$CURL_CA_BUNDLE\" git ls-remote https://github.com/github/gitignore.git HEAD >/dev/null",
  ].join("\n");
}
