/** Approved landing copy. */
export const accessCopy = {
  title: 'Shared chat between multiple humans and AI',
  headline: 'Two Humans and AI in a single cooperative chat',
  description: 'Rally is an AI platform that allows for multiple humans to work with an AI agent in shared chats. Open a Canvas with your coworkers and work together on research, documents, spreadsheets and sites, or share a Sidekick that does the recurring work.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
