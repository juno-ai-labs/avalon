/** A provider's stored lower-case name as prompts and notices write it: `slack` reads as `Slack`. */
export function providerDisplayName(provider: string): string {
  return provider.length === 0 ? provider : `${provider[0]!.toLocaleUpperCase()}${provider.slice(1)}`;
}
