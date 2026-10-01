import { APPEARANCE_ICON_SECTIONS, type AppearanceIconSectionId, type PickableAppearanceIconKey } from '@rally/contracts';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { APPEARANCE_ICON_COMPONENTS } from './appearance-icons';

/**
 * The glyph each section's tab shows. A tab is a jump, not a filter, so its mark
 * only has to say which part of the grid it lands on.
 */
const SECTION_TAB_ICON: Record<AppearanceIconSectionId, PickableAppearanceIconKey> = {
  planning: 'target',
  docs: 'file-text',
  learning: 'lightbulb',
  people: 'users',
  data: 'chart-column',
  build: 'code',
  places: 'map-pin',
  life: 'palette',
};

/**
 * The icon catalog laid out to be chosen from: a row of section tabs over one
 * scrolling grid, with a heading per section, the way Slack lays out emoji.
 *
 * Presentational. It owns only the layout and the jump between sections; each
 * cell is the caller's, through {@link renderIcon} — in `AppearancePicker`, a
 * menu radio item that saves on click, for a Channel, a Breakout, a Space and a
 * Sidekick alike.
 *
 * The whole catalog is rendered at once rather than a section at a time, so
 * scrolling is the browser's and a tab is a scroll offset. 253 small SVGs is
 * well within what the grid paints without help.
 */
export function IconCatalog({ renderIcon, className }: {
  renderIcon: (key: PickableAppearanceIconKey) => React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  // Where the last jump left the grid. The last sections cannot reach the top
  // edge, so the scroll a jump causes would otherwise name the section above.
  const landed = useRef<number | null>(null);
  const [active, setActive] = useState<AppearanceIconSectionId>(APPEARANCE_ICON_SECTIONS[0].id);
  const sections = (): HTMLElement[] => [...(scroller.current?.querySelectorAll<HTMLElement>('[data-icon-section]') ?? [])];
  const jump = (id: AppearanceIconSectionId): void => {
    const target = sections().find((element) => element.dataset.iconSection === id);
    if (!target || !scroller.current) return;
    // The scroller is each section's offset parent, so offsetTop is already a
    // scroll position. Sections rather than their headings, which are sticky
    // and report where they are stuck rather than where they start.
    scroller.current.scrollTop = target.offsetTop;
    landed.current = scroller.current.scrollTop;
    setActive(id);
  };
  const follow = (): void => {
    const view = scroller.current;
    if (!view || view.scrollTop === landed.current) return;
    landed.current = null;
    // The last section starting at or above the top edge is the one being read.
    const top = view.scrollTop + 1;
    const current = sections().filter((element) => element.offsetTop <= top).at(-1);
    const id = current?.dataset.iconSection as AppearanceIconSectionId | undefined;
    if (id && id !== active) setActive(id);
  };
  return <div className={clsx('icon-catalog', className)}>
    <div className="icon-catalog-tabs">
      {APPEARANCE_ICON_SECTIONS.map((section) => {
        const Icon = APPEARANCE_ICON_COMPONENTS[SECTION_TAB_ICON[section.id]];
        return <button
          key={section.id}
          type="button"
          className="icon-catalog-tab"
          aria-label={section.label}
          aria-pressed={active === section.id}
          title={section.label}
          onClick={() => jump(section.id)}
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>;
      })}
    </div>
    <div ref={scroller} className="icon-catalog-scroll" onScroll={follow}>
      {APPEARANCE_ICON_SECTIONS.map((section) => <section key={section.id} aria-label={section.label} data-icon-section={section.id}>
        <h4 className="icon-catalog-heading">{section.label}</h4>
        <div className="icon-catalog-grid">{section.keys.map((key) => renderIcon(key))}</div>
      </section>)}
    </div>
  </div>;
}
