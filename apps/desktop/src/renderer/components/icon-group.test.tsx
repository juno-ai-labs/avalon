import { IconGroup } from '@rally/ui/components/icon-group';
import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('IconGroup', () => {
  it('keeps unavailable actions focusable and prevents their callbacks', () => {
    const onSelect=vi.fn();
    render(<Tooltip.Provider><IconGroup actions={[{key:'comment',label:'Comment mode',icon:null,disabledReason:'Website comments require the Rally Mac app.',alwaysVisible:true,onSelect}]} /></Tooltip.Provider>);
    const button=screen.getByRole('button',{name:'Comment mode'});
    expect(button).toHaveAttribute('aria-disabled','true');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('offers each action as a button and again in the "More" dropdown, leaving its children in place', async () => {
    const onExpand = vi.fn();
    render(<Tooltip.Provider>
      <IconGroup actions={[{ key: 'expand', label: 'Expand', icon: null, onSelect: onExpand }]}>
        <button type="button">Close</button>
      </IconGroup>
    </Tooltip.Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(onExpand).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Expand' }));
    expect(onExpand).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('runs a folded action with focus on the "More" button, which outlives the menu', async () => {
    let focused: Element | null = null;
    render(<Tooltip.Provider>
      <IconGroup actions={[{ key: 'expand', label: 'Expand', icon: null, onSelect: () => { focused = document.activeElement; } }]} />
    </Tooltip.Provider>);

    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Expand' }));
    expect(focused).toBe(more);
  });

  it('shows a toggle\'s state on its button and on its folded row', async () => {
    const onToggle = vi.fn();
    render(<Tooltip.Provider>
      <IconGroup actions={[{ key: 'data', label: 'Stored data', icon: null, pressed: true, onSelect: onToggle }]} />
    </Tooltip.Provider>);

    expect(screen.getByRole('button', { name: 'Stored data' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
    const row = await screen.findByRole('menuitemcheckbox', { name: 'Stored data' });
    expect(row).toHaveAttribute('aria-checked', 'true');
    // Radix draws the indicator only while checked, so this is the visible check.
    expect(row.querySelector('.icon-group-menu-check svg')).not.toBeNull();
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('draws no check on a toggle that is off', async () => {
    render(<Tooltip.Provider>
      <IconGroup actions={[{ key: 'data', label: 'Stored data', icon: null, pressed: false, onSelect: () => undefined }]} />
    </Tooltip.Provider>);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
    const row = await screen.findByRole('menuitemcheckbox', { name: 'Stored data' });
    expect(row.querySelector('.icon-group-menu-check')).toBeNull();
  });

  it('keeps Comment mode directly before Expand outside the folded menu',async()=>{
    render(<Tooltip.Provider><IconGroup folded actions={[
      {key:'link',label:'Copy link',icon:null,onSelect:()=>{}},
      {key:'comment',label:'Comment mode',icon:null,pressed:false,alwaysVisible:true,onSelect:()=>{}},
      {key:'expand',label:'Expand',icon:null,alwaysVisible:true,onSelect:()=>{}},
    ]} /></Tooltip.Provider>);
    const comment=screen.getByRole('button',{name:'Comment mode'});
    expect(comment.nextElementSibling).toBe(screen.getByRole('button',{name:'Expand'}));
    fireEvent.pointerDown(screen.getByRole('button',{name:'More actions'}),{button:0,ctrlKey:false});
    expect(await screen.findByRole('menuitem',{name:'Copy link'})).toBeVisible();
    expect(screen.queryByRole('menuitemcheckbox',{name:'Comment mode'})).toBeNull();
  });
  it('draws no "More" button when it has no actions to fold', () => {
    render(<Tooltip.Provider><IconGroup><button type="button">Close</button></IconGroup></Tooltip.Provider>);
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});
