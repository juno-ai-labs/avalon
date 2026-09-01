import * as Tooltip from '@radix-ui/react-tooltip';
import clsx from 'clsx';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { collapsibleSectionIds } from '../lib/markdown-collapse';
import { CLAMP_ROUNDING_TOLERANCE_PX } from '../lib/use-text-clamped';

interface MarkdownCollapseValue {
  readonly expanded: ReadonlySet<string>;
  readonly sectionIds: readonly string[];
  readonly collapsibleIds: ReadonlySet<string>;
  readonly allExpanded: boolean;
  reportCollapsible: (id: string, collapsible: boolean) => void;
  toggle: (id: string) => void;
  setAll: (expanded: boolean) => void;
}

const MarkdownCollapseContext = createContext<MarkdownCollapseValue | null>(null);

interface MarkdownCollapseSectionState {
  readonly id: string;
  readonly collapsible: boolean;
}

const MarkdownCollapseSectionIdContext = createContext<MarkdownCollapseSectionState | null>(null);

function mergeCollapsibleIds(
  current: ReadonlySet<string>,
  previousIds: readonly string[],
  nextIds: readonly string[],
): ReadonlySet<string> {
  const previous = new Set(previousIds);
  const next = new Set<string>();
  for (const id of nextIds) {
    if (!previous.has(id) || current.has(id)) next.add(id);
  }
  return next;
}

/**
 * Whether this collapsed body still has content behind the 3-line preview.
 *
 * Default is yes — a missing measurement is closed — so a section that has
 * only just arrived stays collapsed until layout proves the preview already
 * shows everything. jsdom reports 0×0, which is treated as not yet laid out
 * rather than as a perfect fit, or every accordion would vanish in tests.
 *
 * Measurement pauses while the clamp is lifted, same as `useTextClamped`:
 * an expanded box no longer overflows, and a hook that kept measuring would
 * retract the chevron the reader just used.
 */
function usePreviewOverflows(
  node: HTMLElement | null,
  contentKey: string,
  clampApplied: boolean,
): boolean {
  const [overflows, setOverflows] = useState(true);
  useLayoutEffect(() => {
    if (!node || !clampApplied) return undefined;
    const measure = (): void => {
      const { clientHeight, scrollHeight } = node;
      if (clientHeight === 0 && scrollHeight === 0) {
        setOverflows(true);
        return;
      }
      setOverflows(scrollHeight - clientHeight > CLAMP_ROUNDING_TOLERANCE_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [clampApplied, contentKey, node]);
  return overflows;
}

export function useMarkdownCollapse(): MarkdownCollapseValue | null {
  return useContext(MarkdownCollapseContext);
}

/**
 * Holds which heading sections are expanded for one markdown body (or for
 * the agent turn that hosts the collapse-all control next to **Worked for**).
 *
 * Default is collapsed for a section whose body still hides something: a
 * missing id is closed. New sections that stream in are therefore closed
 * without anyone having to say so. A body that already fits the 3-line
 * preview is not an accordion — expanding it would reveal nothing.
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
  const [collapsibleIds, setCollapsibleIds] = useState<ReadonlySet<string>>(() => new Set(computedIds));
  if (computedIds.join('\0') !== sectionIds.join('\0')) {
    setSectionIds(computedIds);
    setCollapsibleIds((current) => mergeCollapsibleIds(current, sectionIds, computedIds));
  }
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const reportCollapsible = useCallback((id: string, collapsible: boolean) => {
    setCollapsibleIds((current) => {
      if (current.has(id) === collapsible) return current;
      const next = new Set(current);
      if (collapsible) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const setAll = useCallback((nextExpanded: boolean) => {
    setExpanded(nextExpanded ? new Set(collapsibleIds) : new Set());
  }, [collapsibleIds]);
  const allExpanded = collapsibleIds.size > 0 && [...collapsibleIds].every((id) => expanded.has(id));
  const value = useMemo<MarkdownCollapseValue>(
    () => ({ allExpanded, collapsibleIds, expanded, reportCollapsible, sectionIds, setAll, toggle }),
    [allExpanded, collapsibleIds, expanded, reportCollapsible, sectionIds, setAll, toggle],
  );
  return (
    <MarkdownCollapseContext.Provider value={value}>
      {children}
    </MarkdownCollapseContext.Provider>
  );
}

export function MarkdownCollapseSection({
  bodyKey = '',
  children,
  heading,
  id,
  streamingTail = false,
}: {
  bodyKey?: string;
  children: ReactNode;
  heading: ReactNode;
  id: string;
  streamingTail?: boolean;
}): React.JSX.Element {
  const collapse = useMarkdownCollapse();
  const userExpanded = collapse?.expanded.has(id) ?? false;
  const [bodyNode, setBodyNode] = useState<HTMLElement | null>(null);
  const overflowsPreview = usePreviewOverflows(bodyNode, bodyKey, !userExpanded);
  // An empty body has nothing to hide. A streaming tail stays collapsible even
  // while it still fits, so a heading that has only just arrived does not open
  // a two-line body and then slam shut as the next tokens land.
  const collapsible = streamingTail || (bodyKey.trim() !== '' && overflowsPreview);
  // PROVE_FAIL: const collapsible = true;
  const expanded = userExpanded || !collapsible;
  useLayoutEffect(() => {
    collapse?.reportCollapsible(id, collapsible);
  }, [collapse, collapsible, id]);
  const section = useMemo<MarkdownCollapseSectionState>(() => ({ collapsible, id }), [collapsible, id]);
  return (
    <MarkdownCollapseSectionIdContext.Provider value={section}>
      <div className={clsx('markdown-collapse', expanded ? 'is-expanded' : 'is-collapsed')}>
        {heading}
        <div
          aria-hidden={expanded ? undefined : true}
          className="markdown-collapse-body"
          ref={setBodyNode}
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
  const section = useContext(MarkdownCollapseSectionIdContext);
  const collapse = useMarkdownCollapse();
  if (!section || !collapse || !section.collapsible) return <Tag {...props}>{children}</Tag>;
  const { id } = section;
  const expanded = collapse.expanded.has(id);
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
 * Expand or collapse every heading section in this turn whose body still
 * hides something. Lives in the message header, to the right of **Worked
 * for**, and is absent when no section overflows the preview.
 */
export function MarkdownCollapseAllButton(): React.JSX.Element | null {
  const collapse = useMarkdownCollapse();
  if (!collapse || collapse.collapsibleIds.size === 0) return null;
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
