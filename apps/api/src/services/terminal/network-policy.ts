import { parse as parseDomain } from "tldts";

export const TERMINAL_NETWORK_MAX_TARGETS = 20;
export const TERMINAL_NETWORK_MANIFEST_VERSION = "terminal-network-v1";

export const TERMINAL_NETWORK_BASELINE = [
  {
    id: "github_avalon",
    label: "GitHub and Rally",
    domains: [
      "api.github.com",
      // The canonical API hosts only. A sandbox reaches Avalon at whatever
      // `PUBLIC_API_BASE_URL` names, and that is Rally in both regions — so the
      // superseded hosts would be two unreachable entries that each cost a
      // workspace one of its `TERMINAL_NETWORK_MAX_TARGETS` slots.
      "api.rallywith.ai",
      "eu.api.rallywith.ai",
      "github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
    ],
  },
  {
    id: "system_packages",
    label: "System packages",
    domains: ["deb.debian.org", "security.debian.org"],
  },
  {
    id: "python_packages",
    label: "Python packages",
    domains: ["astral.sh", "files.pythonhosted.org", "pypi.org"],
  },
  {
    id: "javascript_packages",
    label: "JavaScript packages",
    domains: ["get.pnpm.io", "registry.npmjs.org"],
  },
] as const;

export type TerminalNetworkMode = "trusted_only" | "full_internet";

export interface CompiledTerminalNetworkPolicy {
  mode: TerminalNetworkMode;
  manifestVersion: string;
  customDomains: string[];
  effectiveDomains: string[];
  reservedSlots: number;
  remainingCustomSlots: number;
}

export class TerminalNetworkPolicyError extends Error {
  readonly code = "invalid_network_domain";

  constructor(message: string) {
    super(message);
    this.name = "TerminalNetworkPolicyError";
  }
}

function canonicalAsciiHostname(value: string): string {
  try {
    return new URL(`https://${value}`).hostname.replace(/\.$/u, "").toLowerCase();
  } catch {
    throw new TerminalNetworkPolicyError("Enter a domain without a scheme, port, path, query, or credentials");
  }
}

function canonicalDomain(rawValue: string): string {
  const value = rawValue.trim();
  if (!value || /[\s/@:?#]/u.test(value) || value.includes("/")) {
    throw new TerminalNetworkPolicyError("Enter a domain without a scheme, port, path, query, or credentials");
  }
  const wildcard = value.startsWith("*.");
  if (value.includes("*") && !wildcard) {
    throw new TerminalNetworkPolicyError("A wildcard must appear exactly once as the leading *. label");
  }
  const candidate = wildcard ? value.slice(2) : value;
  if (!candidate || candidate.includes("*")) {
    throw new TerminalNetworkPolicyError("A wildcard must appear exactly once as the leading *. label");
  }
  const hostname = canonicalAsciiHostname(candidate);
  if (
    hostname.length > 253
    || !hostname.includes(".")
    || hostname.split(".").some((label) => (
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    ))
  ) {
    throw new TerminalNetworkPolicyError("Enter a valid registrable domain name");
  }
  const parsed = parseDomain(hostname, { allowPrivateDomains: false });
  if (parsed.isIp || !parsed.domain || !parsed.publicSuffix) {
    throw new TerminalNetworkPolicyError("IP addresses and public suffixes are not allowed");
  }
  if (wildcard && hostname === parsed.publicSuffix) {
    throw new TerminalNetworkPolicyError("A wildcard cannot cover a public suffix");
  }
  return `${wildcard ? "*." : ""}${hostname}`;
}

export function compileTerminalNetworkPolicy(
  mode: TerminalNetworkMode,
  additions: readonly string[],
): CompiledTerminalNetworkPolicy {
  const baseline = [...new Set(TERMINAL_NETWORK_BASELINE.flatMap((group) => [...group.domains]))].sort();
  const baselineSet = new Set<string>(baseline);
  const customDomains = [...new Set(additions.map(canonicalDomain))]
    .filter((domain) => !baselineSet.has(domain))
    .sort();
  const trustedEffective = [...baseline, ...customDomains].sort();
  if (trustedEffective.length > TERMINAL_NETWORK_MAX_TARGETS) {
    throw new TerminalNetworkPolicyError(
      `Daytona allows ${TERMINAL_NETWORK_MAX_TARGETS} effective domains; remove ${trustedEffective.length - TERMINAL_NETWORK_MAX_TARGETS} workspace domain(s)`,
    );
  }
  return {
    mode,
    manifestVersion: TERMINAL_NETWORK_MANIFEST_VERSION,
    customDomains,
    effectiveDomains: mode === "trusted_only" ? trustedEffective : [],
    reservedSlots: baseline.length,
    remainingCustomSlots: TERMINAL_NETWORK_MAX_TARGETS - trustedEffective.length,
  };
}
