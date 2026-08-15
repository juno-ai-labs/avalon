import { reportSiteAction } from './telemetry';

const themes = ["runway", "valley", "proof", "afterlight"] as const;
type Theme = (typeof themes)[number];

const root = document.documentElement;
const header = document.querySelector<HTMLElement>(".site-header");
const panels = document.querySelectorAll<HTMLElement>("[data-theme-panel]");
const themeButtons = document.querySelectorAll<HTMLButtonElement>("[data-theme-select]");

function isTheme(value: string | null | undefined): value is Theme {
  return themes.some((theme) => theme === value);
}

function setTheme(theme: Theme): void {
  root.dataset.theme = theme;

  panels.forEach((panel) => {
    const isActive = panel.dataset.themePanel === theme;
    panel.toggleAttribute("data-active", isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
  });

  themeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeSelect === theme));
  });
}

function randomTheme(except?: Theme): Theme {
  const available = except ? themes.filter((theme) => theme !== except) : themes;
  const fallback = available[0] ?? "runway";
  return available[Math.floor(Math.random() * available.length)] ?? fallback;
}

const initialTheme = root.dataset.theme;
setTheme(isTheme(initialTheme) ? initialTheme : randomTheme());
root.dataset.themeReady = "";

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const theme = button.dataset.themeSelect;
    if (isTheme(theme)) setTheme(theme);
  });
});

document.querySelector<HTMLButtonElement>("[data-shuffle-theme]")?.addEventListener("click", () => {
  const selectedTheme = root.dataset.theme;
  const current = isTheme(selectedTheme) ? selectedTheme : undefined;
  setTheme(randomTheme(current));
});

const revealItems = document.querySelectorAll<HTMLElement>(".reveal");

if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.12 });

  revealItems.forEach((item) => revealObserver.observe(item));
}

function updateHeader(): void {
  header?.classList.toggle("is-scrolled", window.scrollY > 24);
}

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const faqItems = document.querySelectorAll<HTMLDetailsElement>(".faq-list details");
faqItems.forEach((item) => {
  item.addEventListener("toggle", () => {
    if (!item.open) return;
    reportSiteAction('faq_opened', 'faq');
    faqItems.forEach((other) => {
      if (other !== item) other.open = false;
    });
  });
});

function actionPlacement(element: Element): 'header' | 'hero' | 'body' | 'footer' | 'connector' | 'unknown' {
  if (element.closest('.site-header')) return 'header';
  if (element.closest('.hero')) return 'hero';
  if (element.closest('#integrations')) return 'connector';
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
  } else if (href.startsWith('/support/#granola')) {
    reportSiteAction('connector_setup', 'connector');
  } else if (href.startsWith('/support')) {
    reportSiteAction('support_contact', placement);
  } else if (link.classList.contains('button-primary')) {
    reportSiteAction('primary_cta', placement);
  } else if (link.classList.contains('button-quiet')) {
    reportSiteAction('secondary_cta', placement);
  }
});
