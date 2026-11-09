/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally: make it together, with AI',
  description: 'Rally puts your team and AI in one Canvas: one chat everyone shares, and the document, spreadsheet or site it makes. Sidekicks take the work that repeats.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
