/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally · Docs that update as work happens',
  /** The hero headline, in two parts: the claim, then its italic turn. Both home pages use them. */
  headline: 'Docs that update',
  headlineTurn: 'as work happens.',
  description: 'Rally makes documents, spreadsheets, dashboards and sites that keep themselves current. When something happens in Linear, Slack, Gmail or your other tools, Rally publishes a new version. Share a Canvas, and your whole team works from the same reactive page.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
