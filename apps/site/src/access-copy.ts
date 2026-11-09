/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally: live documents, sheets and sites that keep themselves current',
  description: 'Rally makes live Canvases: documents, spreadsheets and sites built from your tools and kept current as things happen in them. Start on your own, then bring your team into the same Canvas.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
