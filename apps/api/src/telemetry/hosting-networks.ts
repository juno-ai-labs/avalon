/**
 * Autonomous systems whose addresses belong to cloud and VPS hosts, where a
 * person browsing is rare and a scripted browser is cheap. A starting list of
 * the large providers; which networks belong here is the team's call
 * (docs/site-traffic-classification.md, "Open decisions"). Residential and VPN
 * providers are deliberately absent.
 */
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  16509, 14618, 8987, // Amazon Web Services
  15169, 396982, // Google, Google Cloud
  8075, // Microsoft Azure
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  132203, // Tencent Cloud
  136907, // Huawei Cloud
  14061, // DigitalOcean
  63949, // Akamai Connected Cloud (Linode)
  20473, // Vultr
  16276, // OVHcloud
  24940, 213230, // Hetzner
  12876, // Scaleway
  51167, // Contabo
  60781, 30633, // Leaseweb
  9009, // M247
  47583, // Hostinger
  60068, 212238, // CDN77 / DataCamp
  40676, // Psychz
  8100, // QuadraNet
  36352, // ColoCrossing
  26496, // GoDaddy
  53667, // FranTech (BuyVM)
  19318, // Interserver
  54290, // Hostwinds
]);

/**
 * The networks iCloud Private Relay egresses through, labelled `private_relay`
 * as context. None is in `HOSTING_ASNS`, so a relay visitor (a person whose
 * address Apple has swapped) is never `datacenter`; keep it that way when the
 * hosting list grows. Cloudflare's network also carries WARP and Workers, so
 * a script running there is never `datacenter` either; that miss is accepted.
 */
export const PRIVATE_RELAY_ASNS: ReadonlySet<number> = new Set([
  36183, // Akamai, Private Relay
  13335, // Cloudflare
  54113, // Fastly
]);
