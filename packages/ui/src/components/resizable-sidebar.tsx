import clsx from 'clsx';
import { GripVertical } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type Ref,
  type ReactNode,
  type RefObject,
} from 'react';

import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '../lib/sidebar-geometry';
import { DragHint } from './primitives';

const EDGE_REVEAL_DISTANCE = 20;
const KEYBOARD_STEP = 16;

type ClassNameResolver = (...args: unknown[]) => string | undefined;

type SidebarRowProps<Component extends ElementType> = {
  as?: Component;
  /** A trailing count in expanded rows and an icon-corner badge in compact rows. */
  badge?: { count: number; label: string };
} & ComponentPropsWithoutRef<Component>;

type SidebarScrollProps<Component extends ElementType> = {
  as?: Component;
  scrollRef?: Ref<HTMLElement>;
} & ComponentPropsWithoutRef<Component>;

type SidebarListProps<Component extends ElementType> = {
  as?: Component;
} & ComponentPropsWithoutRef<Component>;

type SidebarFooterProps<Component extends ElementType> = {
  as?: Component;
  leading?: ReactNode;
} & ComponentPropsWithoutRef<Component>;

/** One interactive or presentational row in any hierarchy sidebar. */
export function SidebarRow<Component extends ElementType = 'button'>(
  props: SidebarRowProps<Component>,
): React.JSX.Element {
  const { as, badge, children, ...rest } = props;
  const rowProps = rest as typeof rest & {
    'aria-describedby'?: string;
    className?: string | ClassNameResolver;
  };
  const className = rowProps.className;
  const badgeVisible = Boolean(badge && badge.count > 0);
  const badgeDescriptionId = useId();
  const describedBy = [rowProps['aria-describedby'], badgeVisible ? badgeDescriptionId : undefined]
    .filter(Boolean)
    .join(' ') || undefined;
  const mergedClassName = typeof className === 'function'
    ? (...args: unknown[]): string => clsx('sidebar-row', className(...args))
    : clsx('sidebar-row', className);
  const Row: ElementType = as ?? 'button';
  return <Row {...rest} aria-describedby={describedBy} className={mergedClassName}>
    {children}
    {badgeVisible && <>
      <span aria-hidden="true" className="sidebar-row-badge">{badge!.count}</span>
      <span className="sr-only" id={badgeDescriptionId}>{badge!.label}</span>
    </>}
  </Row>;
}

/** The shared scrolling body below a hierarchy sidebar's header divider. */
export function SidebarScroll<Component extends ElementType = 'div'>(
  props: SidebarScrollProps<Component>,
): React.JSX.Element {
  const { as, className, scrollRef, ...rest } = props;
  const Scroll: ElementType = as ?? 'div';
  return <Scroll {...rest} className={clsx('sidebar-scroll', className)} ref={scrollRef} />;
}

/** One vertical list rhythm shared by every hierarchy sidebar. */
export function SidebarList<Component extends ElementType = 'div'>(
  props: SidebarListProps<Component>,
): React.JSX.Element {
  const { as, ...rest } = props;
  const listProps = rest as typeof rest & { className?: string | ClassNameResolver };
  const className = listProps.className;
  const mergedClassName = typeof className === 'function'
    ? (...args: unknown[]): string => clsx('sidebar-list', className(...args))
    : clsx('sidebar-list', className);
  const List: ElementType = as ?? 'div';
  return <List {...rest} className={mergedClassName} />;
}

/** The shared title row and divider at the top of a hierarchy sidebar. */
export function SidebarHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return <>
    <SidebarRow as="div" className={clsx('sidebar-header', className)} {...props} />
    <SidebarHorizontalLine className="sidebar-header-line" />
  </>;
}

/** A hierarchy titlebar that keeps its icon beside the title, then hides only the title when compact. */
export function SidebarTitleHeader({ children, className, icon, title, titleClassName, ...props }: Omit<ComponentPropsWithoutRef<'div'>, 'title'> & {
  icon: ReactNode;
  title: ReactNode;
  titleClassName?: string;
}): React.JSX.Element {
  return <SidebarHeader className={className} {...props}>
    <span aria-hidden="true" className="sidebar-title-header-icon">{icon}</span>
    <SidebarTitle className={titleClassName}>{title}</SidebarTitle>
    {children}
  </SidebarHeader>;
}

/** A sidebar header title that truncates and travels with the shared motion. */
export function SidebarTitle({ className, ...props }: ComponentPropsWithoutRef<'h2'>): React.JSX.Element {
  return <h2 className={clsx('sidebar-title', className)} {...props} />;
}

/** A divider whose appearance can travel between expanded and compact layouts. */
export function SidebarHorizontalLine({ className, ...props }: ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return <div aria-hidden="true" className={clsx('sidebar-horizontal-line', className)} {...props} />;
}

/**
 * Rows at the bottom of a sidebar, above the line over its footer:
 * always on screen, never scrolled away with the list. The host decides what
 * goes here and the sidebar owns only where it sits. Each child is a `SidebarRow`, so a
 * compact rail collapses it to the same lone tile a Space row becomes.
 */
export function SidebarFooterItems({ className, ...props }: ComponentPropsWithoutRef<'div'>): React.JSX.Element {
  return <div className={clsx('sidebar-footer-items', className)} {...props} />;
}

/** The shared bottom row for every hierarchy sidebar. */
export function SidebarFooter<Component extends ElementType = 'div'>({
  as,
  children,
  className,
  leading,
  ...props
}: SidebarFooterProps<Component>): React.JSX.Element {
  const Footer: ElementType = as ?? 'div';
  return <Footer
    {...props}
    className={clsx('sidebar-footer', leading ? 'has-leading-content' : 'is-toggle-only', className)}
  >
    {leading}
    {children}
  </Footer>;
}

type ResizableSidebarProps = Omit<ComponentPropsWithoutRef<'aside'>, 'children'> & {
  children: ReactNode;
  resizeLabel: string;
  onResize: (width: number) => void;
  sidebarRef: RefObject<HTMLElement | null>;
  width: number;
};

/**
 * The navigation sidebar's shell: it resizes and never collapses.
 *
 * The owner supplies its content and persistence policy. The shell owns the
 * resizing state that drives motion and the complete trailing-edge
 * interaction: the grip, the hint, the drag and the keyboard steps, which stop
 * at the minimum width.
 */
export function ResizableSidebar({
  children,
  className,
  resizeLabel,
  onResize,
  sidebarRef,
  width,
  ...props
}: ResizableSidebarProps): React.JSX.Element {
  const [pointerNearEdge, setPointerNearEdge] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [keyResizing, setKeyResizing] = useState(false);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const resizeActive = resizing || keyResizing;

  useEffect(() => {
    const track = (event: PointerEvent): void => {
      const measuredEdge = sidebarRef.current?.getBoundingClientRect().right ?? 0;
      const edge = measuredEdge > 0 ? measuredEdge : width;
      const near = Math.abs(event.clientX - edge) <= EDGE_REVEAL_DISTANCE;
      setPointerNearEdge((current) => current === near ? current : near);
    };
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, [sidebarRef, width]);

  useEffect(() => {
    if (!resizing) return undefined;
    const move = (event: PointerEvent): void => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const bounds = sidebarRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const requested = event.clientX - drag.current.offset - bounds.left;
      setDragWidth(Math.max(0, requested));
      onResize(requested);
    };
    const stop = (event: PointerEvent): void => {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setResizing(false);
      setDragWidth(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [onResize, resizing, sidebarRef]);

  return <aside
    {...props}
    className={clsx('resizable-sidebar', className, resizeActive && 'is-resizing')}
    ref={sidebarRef}
  >
    {children}
    {resizing && dragWidth !== null && <div aria-hidden="true" className="sidebar-drag-guide" style={{ left: dragWidth }} />}
    <DragHint
      action="Drag to resize"
      suppressed={resizing}
    >
      <div
        aria-label={resizeLabel}
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={width}
        className={clsx('sidebar-resizer', (pointerNearEdge || resizing) && 'is-near', resizeActive && 'is-resizing')}
        onBlur={() => setKeyResizing(false)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setKeyResizing(true);
          if (event.key === 'ArrowLeft') onResize(Math.max(MIN_SIDEBAR_WIDTH, width - KEYBOARD_STEP));
          if (event.key === 'ArrowRight') onResize(width + KEYBOARD_STEP);
        }}
        onKeyUp={() => setKeyResizing(false)}
        onLostPointerCapture={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          drag.current = null;
          setResizing(false);
          setDragWidth(null);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          const bounds = sidebarRef.current?.getBoundingClientRect();
          if (!bounds) return;
          drag.current = { pointerId: event.pointerId, offset: event.clientX - bounds.right };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setResizing(true);
        }}
        role="separator"
        tabIndex={0}
      >
        <span aria-hidden="true" className="sidebar-resizer-handle">
          <GripVertical size={11} strokeWidth={2} />
        </span>
      </div>
    </DragHint>
  </aside>;
}
