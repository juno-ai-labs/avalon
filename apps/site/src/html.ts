/** Small string helpers shared by the pages rendered at build time. Node only. */

/** A `YYYY-MM-DD` day as "October 1, 2026", read in UTC so the day never shifts. */
export const longDate = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
