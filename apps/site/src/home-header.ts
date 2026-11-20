/**
 * The pencil pages' header: the homepage, the audience pages, the marketplace
 * and the page about everything else. One renderer, so a link is added once.
 * Its section links are absolute (`/#who`), so the same markup works on the
 * homepage, where they scroll, and on every other page. Node only.
 */
import { arrow, githubLink } from './site-icons';

const APP_ORIGIN = 'https://app.rallywith.ai';

const links = [
  { id: 'who', href: '/#who', text: 'Who it’s for' },
  { id: 'marketplace', href: '/marketplace/', text: 'Marketplace' },
  { id: 'pricing', href: '/#pricing', text: 'Pricing' },
  { id: 'manual', href: '/help/', text: 'The manual' },
] as const;

export type HomeHeaderLink = (typeof links)[number]['id'];

/**
 * `current` marks one link: as the page itself (`page`), or as the section a
 * page sits in (`true`), when the page names itself in a breadcrumb.
 */
export function renderHomeHeader(current?: { link: HomeHeaderLink; as: 'page' | 'true' }): string {
  return '<header class="home-header" id="top"><a class="home-logo" href="/" aria-label="Rally home"><img src="/brand/rally-mark-ink.svg" width="32" height="32" alt="" />rally</a>'
    + `<nav class="home-nav" aria-label="Primary">${links.map(({ id, href, text }) =>
      `<a href="${href}"${current?.link === id ? ` aria-current="${current.as}"` : ''}>${text}</a>`).join('')}${githubLink()}</nav>`
    + `<a class="header-login" data-site-action="sign-in-header" href="${APP_ORIGIN}">Open Rally <span aria-hidden="true">${arrow}</span></a></header>`;
}
