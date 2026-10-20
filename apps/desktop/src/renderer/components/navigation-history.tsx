import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { MarkBridge } from '@rally/ui/components/mark-bridge';
import { TitlePillLeadingContext } from '@rally/ui/components/title-pill';
import { useLayoutEffect, useState, type PropsWithChildren } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/** One history cursor for the shell, shared by whichever pane owns its header. */
export function NavigationHistoryProvider({ children, enabled }: PropsWithChildren<{ enabled: boolean }>): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const action = useNavigationType();
  // HashRouter owns idx; using its cursor keeps POP and replace navigations in
  // the same history as in-app links and desktop deep links.
  const state: unknown = window.history.state;
  const index = state && typeof state === 'object' && 'idx' in state && typeof state.idx === 'number' ? state.idx : 0;
  const [lastIndex, setLastIndex] = useState(index);
  useLayoutEffect(() => {
    setLastIndex((last) => action === 'PUSH' ? index : Math.max(last, index));
  }, [action, index, location.key]);
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
