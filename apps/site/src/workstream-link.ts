import {
  parseWorkstreamLinkPath,
  workstreamDeepLink,
} from '@rally/contracts/workstream-links';
import { reportDesktopHandoff } from './telemetry';

export {};

/**
 * The canonical work-stream link, `/app/workstreams/<uuid>`, is served by a
 * rewrite in `public/_redirects`: every id under that prefix renders this one
 * page, and the id stays in `window.location.pathname` for this script to read.
 * Nothing about the work stream is fetched or rendered here — the page only
 * hands off to the desktop app, which applies the viewer's own permissions.
 */
function initializeWorkstreamHandoff(): void {
  const button = document.querySelector<HTMLAnchorElement>('#open-avalon');
  const title = document.querySelector<HTMLElement>('#workstream-title');
  const status = document.querySelector<HTMLElement>('#workstream-status');
  const help = document.querySelector<HTMLElement>('#workstream-help');
  const error = document.querySelector<HTMLElement>('#workstream-error');
  if (!button) return;

  const workstreamId = parseWorkstreamLinkPath(window.location.pathname);
  if (!workstreamId) {
    reportDesktopHandoff('workstream', 'presented', 'invalid');
    button.setAttribute('hidden', '');
    help?.setAttribute('hidden', '');
    error?.removeAttribute('hidden');
    if (title) title.textContent = 'This link did not lead to a work stream';
    if (status) status.textContent = 'Ask the sender for the link again.';
    return;
  }

  reportDesktopHandoff('workstream', 'presented', 'valid');

  const target = workstreamDeepLink(workstreamId);
  button.href = target;
  button.setAttribute('aria-disabled', 'false');

  let attempted = false;
  const openOnce = (): void => {
    if (attempted) return;
    attempted = true;
    reportDesktopHandoff('workstream', 'automatic', 'valid');
    window.location.assign(target);
  };

  button.addEventListener('click', () => {
    attempted = true;
    reportDesktopHandoff('workstream', 'manual', 'valid');
  });
  window.setTimeout(openOnce, 120);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initializeWorkstreamHandoff();
}
