import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { MarkBridge } from '@rally/ui/components/mark-bridge';
import { TitlePillLeadingContext } from '@rally/ui/components/title-pill';
import { useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/** One history cursor for the shell, shared by whichever pane owns its header. */
export function NavigationHistoryProvider({ children, enabled }: PropsWithChildren<{ enabled: boolean }>): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const action = useNavigationType();
  // HashRouter owns idx; using its cursor keeps POP and replace navigations in
  // the same history as in-app links and desktop deep links.
  const state: unknown = window.history.state;
  const stamped = state && typeof state === 'object' && 'idx' in state && typeof state.idx === 'number' ? state.idx : null;
  // A navigation that bypassed the router (a raw `#/…` link, as a plain
  // anchor in rendered Markdown is) pushes an entry without one. It is the
  // entry after the one it left, so it reads as that one's successor, and is
  // stamped so the router's next push counts on from it rather than from 0.
  const previous = useRef(stamped ?? 0);
  const index = stamped ?? previous.current + 1;
  const [lastIndex, setLastIndex] = useState(index);
  useLayoutEffect(() => {
    if (stamped === null) window.history.replaceState({ ...(window.history.state as object | null), idx: index }, '');
    previous.current = index;
    setLastIndex((last) => action === 'PUSH' || stamped === null ? index : Math.max(last, index));
  }, [action, index, location.key, stamped]);
  const mark = {
    shape: 'circle' as const,
    tint: 'var(--av-sys-color-surface-raised)',
    ink: 'var(--av-sys-color-text-default)',
  };
  return <TitlePillLeadingContext value={enabled ? <MarkBridge className="navigation-history" items={[
    { key: 'back', name: 'Back', mark: { ...mark, icon: IconChevronLeft }, disabled: index <= 0, onSelect: () => void navigate(-1) },
    { key: 'forward', name: 'Forward', mark: { ...mark, icon: IconChevronRight }, disabled: index >= lastIndex, onSelect: () => void navigate(1) },
  ]} /> : null}>{children}</TitlePillLeadingContext>;
}
