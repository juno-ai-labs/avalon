import './help.css';
import './site-entry';
import { searchEntries, words, type SearchEntry } from './help-search';

// Everything here is an enhancement: each page is complete static HTML, and a
// reader without this script still has the chapters, the outline, and the
// previous/next links.

const body = document.body;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function setupMenu(): void {
  const button = document.querySelector<HTMLButtonElement>('.menu');
  const chapters = document.getElementById('chapters');
  if (!button || !chapters) return;
  const toggle = (open: boolean): void => {
    body.classList.toggle('nav-open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', () => toggle(!body.classList.contains('nav-open')));
  chapters.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a')) toggle(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && body.classList.contains('nav-open')) toggle(false);
  });
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
  for (const block of document.querySelectorAll<HTMLElement>('.prose .code')) {
    const code = block.querySelector('code');
    if (!code) continue;
    const button = element('button', { type: 'button', class: 'copy' }, 'Copy');
    button.addEventListener('click', () => void copy(button, () => code.textContent ?? ''));
    block.prepend(button);
  }
  const pageButton = document.querySelector<HTMLButtonElement>('[data-copy-page]');
  const url = document.querySelector<HTMLElement>('[data-md]')?.dataset.md;
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
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.toc a[href^="#"]')) {
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

// The index is built with the site and fetched the first time search opens.
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
    if (position % 2 === 1) fragment.append(element('mark', {}, part));
    else if (part) fragment.append(part);
  }
  return fragment;
}

function searchDialog(): { dialog: HTMLDialogElement; input: HTMLInputElement } {
  const input = element('input', { type: 'search', placeholder: 'Search the manual', 'aria-label': 'Search the manual', autocomplete: 'off', spellcheck: 'false' });
  const close = element('button', { type: 'submit', 'aria-label': 'Close search' }, 'Esc');
  const list = element('ol', { role: 'listbox', 'aria-label': 'Results' });
  const empty = element('p', { class: 'empty', hidden: '' });
  const dialog = element('dialog', { class: 'search', 'aria-label': 'Search the manual' },
    element('form', { method: 'dialog', role: 'search' }, input, close), list, empty);
  body.append(dialog);
  let selected = 0;

  const options = (): HTMLAnchorElement[] => [...list.querySelectorAll<HTMLAnchorElement>('[role="option"]')];
  const select = (next: number): void => {
    const all = options();
    if (all.length === 0) return;
    selected = (next + all.length) % all.length;
    all.forEach((option, position) => option.setAttribute('aria-selected', String(position === selected)));
    all[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const render = async (): Promise<void> => {
    const query = input.value;
    let entries: SearchEntry[];
    try {
      entries = await loadIndex();
    } catch {
      list.replaceChildren();
      empty.textContent = 'Search could not load. The chapters still work.';
      empty.hidden = false;
      return;
    }
    if (query !== input.value) return;
    const terms = words(query);
    const hits = searchEntries(entries, query);
    list.replaceChildren(...hits.map((hit) => {
      const title = element('strong', {}, highlighted(hit.entry.t, terms));
      if (hit.heading) title.append(element('span', {}, ' › ', highlighted(hit.heading[1], terms)));
      const link = element('a', { role: 'option', href: hit.heading ? `${hit.entry.u}#${hit.heading[0]}` : hit.entry.u },
        element('small', {}, hit.entry.c || 'Help Center'), title, element('span', { class: 'snippet' }, highlighted(hit.snippet, terms)));
      return element('li', {}, link);
    }));
    empty.textContent = 'Nothing matched. Try fewer words, or a different one.';
    empty.hidden = hits.length > 0 || terms.length === 0;
    selected = 0;
    select(0);
  };

  input.addEventListener('input', () => void render());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
    if (event.key === 'Enter') {
      const target = options()[selected];
      if (target) { event.preventDefault(); dialog.close(); location.href = target.href; }
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || (event.target as Element).closest('a')) dialog.close();
  });
  return { dialog, input };
}

function setupSearch(): void {
  let search: ReturnType<typeof searchDialog> | undefined;
  const open = (): void => {
    search ??= searchDialog();
    if (search.dialog.open) return;
    search.dialog.showModal();
    search.input.select();
    void loadIndex().catch(() => undefined);
  };
  for (const button of document.querySelectorAll('[data-search]')) button.addEventListener('click', open);
  document.addEventListener('keydown', (event) => {
    const typing = (event.target as Element | null)?.closest('input, textarea, [contenteditable="true"]');
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
      event.preventDefault();
      open();
    }
  });
}

setupMenu();
setupCopy();
setupOutline();
setupSearch();
