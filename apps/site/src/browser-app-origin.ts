/** The web app, which opens every addressed path the site hands off; the local one when the site is served locally. */
export function browserAppOrigin(): string {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:8794'
    : 'https://app.rallywith.ai';
}
