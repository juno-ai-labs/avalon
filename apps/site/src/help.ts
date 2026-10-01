import './help.css';
import './site-entry';
import { searchEntries, words, type SearchEntry } from './help-search';

// Everything here is an enhancement: each page is complete static HTML, and a
// reader without this script still has the chapters, the outline, and the
// previous/next links.

const body = document.body;

function setupMenu(): void {
  const button = document.querySelector<HTMLButtonElement>('.help-menu-button');
  const sidebar = document.getElementById('help-sidebar');
  if (!button || !sidebar) return;
  const toggle = (open: boolean): void => {
    body.classList.toggle('help-nav-open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => toggle(!body.classList.contains('help-nav-open')));
  sidebar.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) toggle(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && body.classList.contains('help-nav-open')) toggle(false);
  });
  sidebar.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'center' });
}

function flash(button: HTMLButtonElement, label: string): void {
  const original = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = original;
  button.textContent = label;
  window.setTimeout(() => { button.textContent = original; }, 1600);
}

async function copy(button: HTMLButtonElement, text: () => Promise<string> | string): Promise<void> {
  try {
    await navigator.clipboard.writeText(await text());
    flash(button, 'Copied');
  } catch {
    flash(button, 'Copy failed');
  }
}

function setupCopy(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.code-copy')) {
    const code = button.closest('.code-block')?.querySelector('code');
    if (!code) continue;
    button.hidden = false;
    button.addEventListener('click', () => void copy(button, () => code.textContent ?? ''));
  }
  const pageButton = document.querySelector<HTMLButtonElement>('[data-copy-markdown]');
  const url = document.querySelector<HTMLElement>('[data-markdown-url]')?.dataset.markdownUrl;
  if (!pageButton || !url) return;
  pageButton.hidden = false;
  pageButton.addEventListener('click', () => void copy(pageButton, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    return response.text();
  }));
}

/** Marks the outline entry for the section the reader is in. */
function setupOutline(): void {
  const links = new Map<string, HTMLAnchorElement>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.help-toc a[href^="#"]')) {
    links.set(decodeURIComponent(link.hash.slice(1)), link);
  }
  const headings = [...links.keys()]
    .map((id) => document.getElementById(id))
    .filter((heading): heading is HTMLElement => heading !== null);
  if (headings.length === 0) return;
  let active: HTMLAnchorElement | undefined;
  const update = (): void => {
    // The current section is the last heading above a line a quarter of the way down.
    const line = window.innerHeight * 0.25;
    let current = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= line) current = heading;
      else break;
    }
    const next = current && links.get(current.id);
    if (next === active) return;
    active?.removeAttribute('aria-current');
    next?.setAttribute('aria-current', 'location');
    active = next;
  };
  let queued = false;
  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  update();
}

let index: Promise<SearchEntry[]> | undefined;
const loadIndex = (): Promise<SearchEntry[]> => {
  index ??= fetch('/help/search-index.json').then((response) => {
    if (!response.ok) throw new Error(String(response.status));
    return response.json() as Promise<SearchEntry[]>;
  }).catch((error: unknown) => {
    index = undefined;
    throw error;
  });
  return index;
};

function highlighted(text: string, terms: string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (terms.length === 0) {
    fragment.append(text);
    return fragment;
  }
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'giu');
  for (const [position, part] of text.split(pattern).entries()) {
    if (position % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = part;
      fragment.append(mark);
    } else if (part) fragment.append(part);
  }
  return fragment;
}

function setupSearch(): void {
  const dialog = document.querySelector<HTMLDialogElement>('.help-search');
  const input = dialog?.querySelector<HTMLInputElement>('.help-search-input');
  const list = dialog?.querySelector<HTMLOListElement>('.help-search-results');
  const empty = dialog?.querySelector<HTMLElement>('.help-search-empty');
  if (!dialog || !input || !list || !empty) return;
  let selected = 0;

  const select = (next: number): void => {
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    if (options.length === 0) return;
    selected = (next + options.length) % options.length;
    options.forEach((option, position) => option.setAttribute('aria-selected', String(position === selected)));
    options[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const render = async (): Promise<void> => {
    const query = input.value;
    let entries: SearchEntry[];
    try {
      entries = await loadIndex();
    } catch {
      list.replaceChildren();
      empty.textContent = 'Search could not load. The chapters on the left still work.';
      empty.hidden = false;
      return;
    }
    if (query !== input.value) return;
    const terms = words(query);
    const hits = searchEntries(entries, query);
    list.replaceChildren(...hits.map((hit) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.setAttribute('role', 'option');
      link.href = hit.heading ? `${hit.entry.u}#${hit.heading[0]}` : hit.entry.u;
      const meta = document.createElement('span');
      meta.className = 'help-search-meta';
      meta.textContent = hit.entry.c || 'Help Center';
      const title = document.createElement('strong');
      title.append(highlighted(hit.entry.t, terms));
      if (hit.heading) {
        const section = document.createElement('span');
        section.className = 'help-search-section';
        section.append(' › ', highlighted(hit.heading[1], terms));
        title.append(section);
      }
      const text = document.createElement('span');
      text.className = 'help-search-snippet';
      text.append(highlighted(hit.snippet, terms));
      link.append(meta, title, text);
      item.append(link);
      return item;
    }));
    empty.textContent = 'Nothing matched. Try fewer words, or a different one.';
    empty.hidden = hits.length > 0 || terms.length === 0;
    selected = 0;
    select(0);
  };

  const open = (): void => {
    if (dialog.open) return;
    dialog.showModal();
    input.select();
    void loadIndex().catch(() => undefined);
  };

  for (const button of document.querySelectorAll('[data-help-search-open]')) button.addEventListener('click', open);
  input.addEventListener('input', () => void render());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
    if (event.key === 'Enter') {
      const target = list.querySelectorAll<HTMLAnchorElement>('[role="option"]')[selected];
      if (target) { event.preventDefault(); dialog.close(); location.href = target.href; }
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  list.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) dialog.close();
  });
  document.addEventListener('keydown', (event) => {
    const typing = (event.target as Element | null)?.closest('input, textarea, [contenteditable="true"]');
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
      event.preventDefault();
      open();
    }
  });
}

if (typeof document !== 'undefined' && document.body?.classList.contains('help')) {
  setupMenu();
  setupCopy();
  setupOutline();
  setupSearch();
}
