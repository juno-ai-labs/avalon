/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally: one place for you, your coworkers, and AI',
  headline: 'Stop copy-pasting\nbetween Claude and Slack.',
  description: 'Rally gives you, your (human) coworkers, and an AI agent a single place to get work done together.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
