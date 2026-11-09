/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally · One place for you, your coworkers, and AI',
  headline: 'One place for you, your coworkers, and AI.',
  description: 'Rally is AI that starts with you and grows with your team. Open a Canvas on your own and make a document, a spreadsheet or a site. Share it, and your coworkers join the same conversation with the same Rally. Sidekicks do the recurring work, for you or for everyone.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
