/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally · One place for you, your coworkers, and AI',
  headline: 'One place for you, your coworkers, and AI.',
  description: 'Rally is shared AI for teams. Open a Canvas and make a document, a spreadsheet or a site with Rally and your coworkers in one conversation. Share a Sidekick to run the recurring work for all of you.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
