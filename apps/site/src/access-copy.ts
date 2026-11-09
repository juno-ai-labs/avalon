/** Approved landing copy. */
export const accessCopy = {
  title: 'Rally: AI for you, then your whole team',
  description: 'Start a Canvas with Rally on your own, and bring your team into the same chat when the work needs them. Rally makes the document, spreadsheet or site; Sidekicks take the work that repeats.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
