import { ErrorNotice } from './primitives';
import { markColors, projectColorCells } from '../lib/project-palette';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { GENERATED_WORKSTREAM_ICON_KEYS, type WorkstreamAppearance, type WorkstreamAppearancePatch } from '@rally/contracts';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCatalog } from './icon-catalog';
import { WORKSTREAM_ICON_COMPONENTS, workstreamAppearance } from './workstream-glyph';

function label(key: string): string {
  return key.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

type PendingChoice = {
  revision: number;
  patch: WorkstreamAppearancePatch;
  baseline: WorkstreamAppearance | undefined;
  saved: boolean;
};

function settled(choice: PendingChoice, appearance: WorkstreamAppearance | undefined): boolean {
  if (!choice.saved) return false;
  const matches = (choice.patch.icon === undefined || choice.patch.icon === appearance?.icon)
    && (choice.patch.color === undefined || choice.patch.color === appearance?.color);
  const changed = (choice.patch.icon !== undefined && choice.baseline?.icon !== appearance?.icon)
    || (choice.patch.color !== undefined && choice.baseline?.color !== appearance?.color);
  return matches || changed;
}

/**
 * The one icon-and-colour palette, for anything that has an appearance.
 *
 * A work stream and a Sidekick pick from the same catalog and store the same
 * two keys, and the part that is genuinely hard — a click that saves without a
 * Save button, several of them in flight at once, retiring each preview only
 * when *its own* field moves, and an error that belongs to the newest choice —
 * is the same problem in both. It lives here once. What differs between the two
 * is only the mark the trigger draws, which is why {@link renderGlyph} is a
 * prop rather than a component this file picks: the caller owns its own
 * treatment, and this owns the choosing.
 */
/**
 * The choosing itself, shared by the picker's own popup and by a menu that
 * offers the same palette as a submenu: the selection with its pending
 * previews, the save that needs no Save button, and the newest choice's error.
 */
function useAppearanceChoice(id: string, appearance: WorkstreamAppearance | undefined, onChange: (patch: WorkstreamAppearancePatch) => Promise<void>, defaults?: WorkstreamAppearance) {
  const [pending, setPending] = useState<PendingChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const open = useRef(false);
  const generated = workstreamAppearance(id);
  // A title or viewer broadcast rebuilds appearance without changing its values.
  // Retire only the fields whose authoritative values have actually moved.
  const preview = pending.filter((choice) => !settled(choice, appearance))
    .reduce<WorkstreamAppearancePatch>((patch, choice) => ({ ...patch, ...choice.patch }), {});
  useEffect(() => {
    if (pending.some((choice) => settled(choice, appearance))) {
      setPending(pending.filter((choice) => !settled(choice, appearance)));
    }
  }, [appearance, pending]);
  // What an unchosen field shows: the caller's own default when it draws one
  // (a Canvas's kind sketch, which is no catalog icon, and its id's hue), else
  // the id-derived mark a Sidekick wears.
  const fallback = defaults ?? { icon: GENERATED_WORKSTREAM_ICON_KEYS[generated.iconIndex]!, color: generated.color };
  const selected = { icon: appearance?.icon ?? fallback.icon, color: appearance?.color ?? fallback.color, ...preview };
  const change = (patch: WorkstreamAppearancePatch): void => {
    const revision = ++sequence.current;
    setPending((current) => [...current, { revision, patch, baseline: appearance, saved: false }]);
    setError(null);
    // The connection owns ordering, including when this picker unmounts.
    void onChange(patch).then(() => {
      setPending((current) => current.map((choice) => choice.revision === revision ? { ...choice, saved: true } : choice));
      if (sequence.current === revision) setError(null);
    }).catch(() => {
      setPending((current) => current.filter((choice) => choice.revision !== revision));
      if (sequence.current === revision && open.current) {
        setError('Couldn’t update the appearance. Please choose again.');
      }
    });
  };
  const onOpenChange = useCallback((value: boolean): void => { open.current = value; setError(null); }, []);
  return { selected, change, error, onOpenChange };
}

function AppearanceChoices({ selected, change, error, colors = true }: Pick<ReturnType<typeof useAppearanceChoice>, 'selected' | 'change' | 'error'> & {
  colors?: boolean | undefined;
}): React.JSX.Element {
  return <>
    {colors && <>
      <DropdownMenu.Label className="appearance-picker-label">Color</DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={selected.color ?? ''} className="appearance-picker-colors" aria-label="Color">
        {projectColorCells().map((color, cell) => (color === null
          ? <span aria-hidden="true" className="appearance-picker-gap" key={`gap-${cell}`} />
          : <DropdownMenu.RadioItem key={color} value={color} aria-label={label(color)} title={label(color)} className="appearance-picker-choice" onSelect={(event) => { event.preventDefault(); change({ color }); }}>
            {/* The pastel a mark of this colour gets, with its ink as a dot, so
                the swatch previews the mark rather than the bare hue. */}
            <span className="appearance-picker-swatch" style={{ background: markColors(color).tint, '--swatch-ink': markColors(color).ink } as React.CSSProperties} />
          </DropdownMenu.RadioItem>))}
      </DropdownMenu.RadioGroup>
      <DropdownMenu.Separator className="appearance-picker-divider" />
    </>}
    <DropdownMenu.Label className="appearance-picker-label">Icon</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={selected.icon ?? ''} className="appearance-picker-icons" aria-label="Icon">
      <IconCatalog renderIcon={(icon) => {
        const Icon = WORKSTREAM_ICON_COMPONENTS[icon];
        return <DropdownMenu.RadioItem key={icon} value={icon} aria-label={label(icon)} title={label(icon)} className="appearance-picker-choice" onSelect={(event) => { event.preventDefault(); change({ icon }); }}>
          <Icon size={20} strokeWidth={1.8} stroke={selected.color ? markColors(selected.color).bare : undefined} />
        </DropdownMenu.RadioItem>;
      }} />
    </DropdownMenu.RadioGroup>
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </>;
}

/**
 * The same palette as a submenu of a menu that is already open, such as a title
 * pill's menu, alongside or in place of the pill's own picker.
 */
export function AppearanceSubmenu({ id, appearance, label: itemLabel, icon, onChange, colors }: {
  id: string;
  appearance?: WorkstreamAppearance;
  label: string;
  icon?: React.ReactNode;
  onChange: (patch: WorkstreamAppearancePatch) => Promise<void>;
  /** False for a thread or a Breakout, whose colour is its Channel's and set by the server. */
  colors?: boolean;
}): React.JSX.Element {
  const { selected, change, error, onOpenChange } = useAppearanceChoice(id, appearance, onChange);
  return <DropdownMenu.Sub onOpenChange={onOpenChange}>
    <DropdownMenu.SubTrigger className="menu-item title-menu-item">{icon}{itemLabel}</DropdownMenu.SubTrigger>
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent className="menu-content appearance-picker-popup" sideOffset={8} collisionPadding={12} aria-label={itemLabel}>
        <AppearanceChoices change={change} colors={colors} error={error} selected={selected} />
      </DropdownMenu.SubContent>
    </DropdownMenu.Portal>
  </DropdownMenu.Sub>;
}

export function AppearancePicker({ id, appearance, defaults, label: triggerLabel, renderGlyph, onChange, triggerClassName, colors, open, onOpenChange: setOpen }: {
  id: string;
  appearance?: WorkstreamAppearance;
  /** The trigger's accessible name, and the popup's: "Change X icon and color". */
  label: string;
  /** The glyph, drawn from the appearance *including* choices not yet committed. */
  renderGlyph: (appearance: WorkstreamAppearance) => React.ReactNode;
  onChange: (patch: WorkstreamAppearancePatch) => Promise<void>;
  /** The trigger's frame, for a surface that draws its mark in a tile of its own. */
  triggerClassName?: string;
  /** False for a thread or a Breakout, whose colour is its Channel's and set by the server. */
  colors?: boolean;
  /**
   * What an unchosen field is drawn and selected as, for a surface whose
   * default is not the id-derived mark: a null icon selects nothing.
   */
  defaults?: WorkstreamAppearance;
  /**
   * Opened from elsewhere too, such as a menu's **Change appearance**: the
   * caller holds whether it is open. That menu hands focus back to its own
   * trigger as it closes, after this has opened, so a controlled palette is
   * closed by a press outside or Escape, not by focus leaving it.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const { selected, change, error, onOpenChange } = useAppearanceChoice(id, appearance, onChange, defaults);
  const controlled = open !== undefined;
  useEffect(() => { if (controlled) onOpenChange(open); }, [controlled, onOpenChange, open]);
  return <DropdownMenu.Root {...(controlled ? { open } : {})} onOpenChange={(value) => { onOpenChange(value); setOpen?.(value); }}>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={triggerLabel} className={clsx('appearance-picker-trigger window-no-drag', triggerClassName)}>
        {renderGlyph(selected)}
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content appearance-picker-popup" align="start" sideOffset={8} collisionPadding={12} aria-label={triggerLabel}
        {...(controlled ? { onFocusOutside: (event: Event) => event.preventDefault() } : {})}>
        <AppearanceChoices change={change} colors={colors} error={error} selected={selected} />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

