import { reportSiteAction } from './telemetry';

const header = document.querySelector<HTMLElement>('.rally-header');
const revealItems = document.querySelectorAll<HTMLElement>('.reveal');

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  revealItems.forEach((item) => item.classList.add('is-visible'));
} else {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -7%', threshold: 0.1 });
  revealItems.forEach((item) => revealObserver.observe(item));
}

const updateHeader = (): void => {
  header?.classList.toggle('is-scrolled', window.scrollY > 16);
};
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

function actionPlacement(element: Element): 'header' | 'hero' | 'body' | 'footer' | 'unknown' {
  if (element.closest('.rally-header')) return 'header';
  if (element.closest('.rally-hero')) return 'hero';
  if (element.closest('footer')) return 'footer';
  if (element.closest('main')) return 'body';
  return 'unknown';
}

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  const placement = actionPlacement(link);
  if (href === '#download' || /\.dmg(?:$|[?#])/iu.test(href)) {
    reportSiteAction('download', placement);
  } else if (href.startsWith('/support')) {
    reportSiteAction('support_contact', placement);
  } else if (link.classList.contains('button-primary')) {
    reportSiteAction('primary_cta', placement);
  }
});
