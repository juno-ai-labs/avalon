import { Search } from 'lucide-react';
import clsx from 'clsx';
import type { ComponentProps } from 'react';

type SidebarSearchProps =
  | ({ mode: 'button' } & Omit<ComponentProps<'button'>, 'children'>)
  | ({ mode: 'input' } & Omit<ComponentProps<'input'>, 'type'>);

/** Shared sidebar search chrome; each host owns its search behavior. */
export function SidebarSearch(props: SidebarSearchProps): React.JSX.Element {
  if (props.mode === 'button') {
    const { mode: _mode, className, ...buttonProps } = props;
    void _mode;
    return <button {...buttonProps} className={clsx('sidebar-search', className)} type="button">
      <Search aria-hidden="true" size={14} />
      <span>Search</span>
    </button>;
  }

  const { mode: _mode, ...inputProps } = props;
  void _mode;
  return <label className="sidebar-search">
    <Search aria-hidden="true" size={14} />
    <input placeholder="Search" {...inputProps} type="search" />
  </label>;
}
