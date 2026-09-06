export function assertSafePublicUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password) ||
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    host.endsWith(".lan") || host.endsWith(".localhost") || host.endsWith(".home.arpa") ||
    host === "metadata.google.internal" || host === "0.0.0.0" || host === "::1" || host === "::" ||
    /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host) ||
    /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)
  ) throw new Error("Private and local network URLs are not allowed");
}
