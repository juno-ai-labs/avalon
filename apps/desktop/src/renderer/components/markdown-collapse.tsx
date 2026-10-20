import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

interface MarkdownCollapseValue {
  /** Sections the reader has closed. A missing id is open. */
  readonly collapsed: ReadonlySet<string>;
  expand: (id: string) => void;
  toggle: (id: string) => void;
}

const MarkdownCollapseContext = createContext<MarkdownCollapseValue | null>(null);
const MarkdownCollapseSectionIdContext = createContext<string | null>(null);

function useMarkdownCollapse(): MarkdownCollapseValue | null {
  return useContext(MarkdownCollapseContext);
}

/**
 * Holds which heading sections are expanded for one markdown body.
 *
 * Default is expanded: the set holds the sections the reader has closed, so a
 * missing id is open. New sections that stream in are therefore open without
 * anyone having to say so.
 */
export function MarkdownCollapseController({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expand = useCallback((id: string) => {
    setCollapsed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo<MarkdownCollapseValue>(
    () => ({ collapsed, expand, toggle }),
    [collapsed, expand, toggle],
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
  // The faded preview is part of the same affordance as the chevron: a reader
  // who clicks the three lines they cannot finish wants the rest of them. The
  // collapsed body is inert, so it is out of hit testing and the click lands
  // here on the section. Attached only while collapsed, and expanding rather
  // than toggling: a click inside an open body belongs to the text it landed
  // on, never to the accordion.
  const openFromPreview = (event: React.MouseEvent<HTMLDivElement>): void => {
    // The heading owns every click on itself, including the link and selection
    // rules that decide it should *not* toggle; opening here would overrule
    // them and swallow a link in a heading.
    if ((event.target as HTMLElement | null)?.closest?.('.markdown-collapse-heading')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    collapse?.expand(id);
  };
  return (
    <MarkdownCollapseSectionIdContext.Provider value={id}>
      <div
        className={clsx('markdown-collapse', expanded ? 'is-expanded' : 'is-collapsed')}
        onClick={expanded ? undefined : openFromPreview}
      >
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
              data-clipboard-exclude=""
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
