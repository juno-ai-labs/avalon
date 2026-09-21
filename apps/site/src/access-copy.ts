/** Approved early-access copy. Change these values without changing the form or API. */
export const accessCopy = {
  title: 'Rally — Work together',
  headline: 'Stop copy-pasting between Claude and Slack.',
  description: 'Rally gives you, your (human) coworkers, and AI a single place to get work done together.',
  capabilities: 'Collaborative Chat. Team Skills. Ready Out of the Box.',
  emailLabel: 'Work email',
  button: 'Get early access',
  availability: 'We’re bringing on teams as fast as we can!',
  pending: 'Sending…',
  success: 'You’re on the list. We’ll be in touch when your invitation is ready.',
  savedFailure: 'Your request was saved, but the confirmation email could not be sent. Please try again.',
  reviewRequired: 'Your request was saved. We need to check the confirmation email before sending it again.',
  rejected: 'Your request was saved, but we couldn’t deliver your confirmation email. Check that you entered the right address.',
  failure: 'We couldn’t complete your request. Please try again.',
  verification: 'Please complete the verification shown above the email field.',
};

export function renderAccessCopy(html: string): string {
  return html.replace(/\{\{access\.(\w+)\}\}/gu, (_match, key: string) => {
    if (!(key in accessCopy)) throw new Error(`Unknown access copy key: ${key}`);
    return accessCopy[key as keyof typeof accessCopy].replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
  });
}
