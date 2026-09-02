import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { collapsibleSectionIds } from '../lib/markdown-collapse';

interface MarkdownCollapseValue {
  /** Sections the reader has closed. A missing id is open. */
  readonly collapsed: ReadonlySet<string>;
  readonly sectionIds: readonly string[];
  readonly allExpanded: boolean;
  toggle: (id: string) => void;
  setAll: (expanded: boolean) => void;
}

const MarkdownCollapseContext = createContext<MarkdownCollapseValue | null>(null);
const MarkdownCollapseSectionIdContext = createContext<string | null>(null);

export function useMarkdownCollapse(): MarkdownCollapseValue | null {
  return useContext(MarkdownCollapseContext);
}

/**
 * Holds which heading sections are expanded for one markdown body (or for
 * the agent turn that hosts the collapse-all control next to **Worked for**).
 *
 * Default is expanded: the set holds the sections the reader has closed, so a
 * missing id is open. New sections that stream in are therefore open without
 * anyone having to say so.
 */
export function MarkdownCollapseController({
  children,
  markdown,
  sectionIds: sectionIdsProp,
}: {
  children: ReactNode;
  markdown?: string;
  sectionIds?: readonly string[];
}): React.JSX.Element {
  const computedIds = useMemo(
    () => sectionIdsProp ?? (markdown === undefined ? [] : collapsibleSectionIds(markdown)),
    [markdown, sectionIdsProp],
  );
  // Keep the same array identity while the heading set is unchanged so a
  // streaming tail append does not rebuild the collapse context (and with
  // it every heading chevron) on every paced-reveal commit. setState during
  // render is the supported way to snap to a new snapshot; a ref write
  // during render is not.
  const [sectionIds, setSectionIds] = useState(computedIds);
  if (computedIds.join('\0') !== sectionIds.join('\0')) {
    setSectionIds(computedIds);
  }
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setAll = useCallback((nextExpanded: boolean) => {
    setCollapsed(nextExpanded ? new Set() : new Set(sectionIds));
  }, [sectionIds]);
  const allExpanded = sectionIds.length > 0 && sectionIds.every((id) => !collapsed.has(id));
  const value = useMemo<MarkdownCollapseValue>(
    () => ({ allExpanded, collapsed, sectionIds, setAll, toggle }),
    [allExpanded, collapsed, sectionIds, setAll, toggle],
  );
  return (
    <MarkdownCollapseContext.Provider value={value}>
      {children}
    </MarkdownCollapseContext.Provider>
  );
}

export function MarkdownCollapseSection({
  children,
  heading,
  id,
}: {
  children: ReactNode;
  heading: ReactNode;
  id: string;
}): React.JSX.Element {
  const collapse = useMarkdownCollapse();
  const expanded = !(collapse?.collapsed.has(id) ?? false);
  return (
    <MarkdownCollapseSectionIdContext.Provider value={id}>
      <div className={clsx('markdown-collapse', expanded ? 'is-expanded' : 'is-collapsed')}>
        {heading}
        <div
          aria-hidden={expanded ? undefined : true}
          className="markdown-collapse-body"
          {...(expanded ? {} : { inert: true })}
        >
          {children}
        </div>
      </div>
    </MarkdownCollapseSectionIdContext.Provider>
  );
}

type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

function CollapseHeading({
  Tag,
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<HeadingTag> & { Tag: HeadingTag; node?: unknown }): React.JSX.Element {
  void node;
  const id = useContext(MarkdownCollapseSectionIdContext);
  const collapse = useMarkdownCollapse();
  if (!id || !collapse) return <Tag {...props}>{children}</Tag>;
  const expanded = !collapse.collapsed.has(id);
  const label = expanded ? 'Collapse section' : 'Expand section';
  return (
    <Tag
      {...props}
      className={clsx('markdown-collapse-heading', props.className)}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented) return;
        if ((event.target as HTMLElement | null)?.closest?.('a')) return;
        if (window.getSelection()?.isCollapsed === false) return;
        collapse.toggle(id);
      }}
    >
      <Tooltip.Provider>
        <Tooltip.Root delayDuration={450}>
          <Tooltip.Trigger asChild>
            <button
              aria-expanded={expanded}
              aria-label={label}
              className="markdown-collapse-chevron"
              onClick={(event) => {
                event.stopPropagation();
                collapse.toggle(id);
              }}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip" side="top" sideOffset={6}>
              {label}
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      {children}
    </Tag>
  );
}

export function MarkdownCollapseH2(props: ComponentPropsWithoutRef<'h2'> & { node?: unknown }): React.JSX.Element {
  return <CollapseHeading Tag="h2" {...props} />;
}
export function MarkdownCollapseH3(props: ComponentPropsWithoutRef<'h3'> & { node?: unknown }): React.JSX.Element {
  return <CollapseHeading Tag="h3" {...props} />;
}
export function MarkdownCollapseH4(props: ComponentPropsWithoutRef<'h4'> & { node?: unknown }): React.JSX.Element {
  return <CollapseHeading Tag="h4" {...props} />;
}
export function MarkdownCollapseH5(props: ComponentPropsWithoutRef<'h5'> & { node?: unknown }): React.JSX.Element {
  return <CollapseHeading Tag="h5" {...props} />;
}
export function MarkdownCollapseH6(props: ComponentPropsWithoutRef<'h6'> & { node?: unknown }): React.JSX.Element {
  return <CollapseHeading Tag="h6" {...props} />;
}

/**
 * Expand or collapse every heading section in this turn. Lives in the
 * message header, to the right of **Worked for**, and is absent when the
 * body has no collapsible headings.
 */
export function MarkdownCollapseAllButton(): React.JSX.Element | null {
  const collapse = useMarkdownCollapse();
  if (!collapse || collapse.sectionIds.length === 0) return null;
  const label = collapse.allExpanded ? 'Collapse all sections' : 'Expand all sections';
  const Icon = collapse.allExpanded ? ChevronsDownUp : ChevronsUpDown;
  return (
    <Tooltip.Provider>
      <Tooltip.Root delayDuration={450}>
        <Tooltip.Trigger asChild>
          <button
            aria-expanded={collapse.allExpanded}
            aria-label={label}
            className="message-collapse-all"
            onClick={() => collapse.setAll(!collapse.allExpanded)}
            type="button"
          >
            <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" side="top" sideOffset={6}>
            {label}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
