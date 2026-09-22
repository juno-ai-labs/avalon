import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidebarNavigationRowContent } from '@rally/ui/components/navigation';

describe('SidebarNavigationRowContent', () => {
  it('does not reserve an activity line for React empty nodes', () => {
    const view = render(<SidebarNavigationRowContent activity={null} icon="icon" title="Channel" />);

    for (const activity of [undefined, false, true, '']) {
      view.rerender(<SidebarNavigationRowContent activity={activity} icon="icon" title="Channel" />);
      expect(view.container.querySelector('.sidebar-row-activity')).toBeNull();
    }

    view.rerender(<SidebarNavigationRowContent activity={0} icon="icon" title="Channel" />);
    expect(view.container.querySelector('.sidebar-row-activity')).toHaveTextContent('0');
  });
});
