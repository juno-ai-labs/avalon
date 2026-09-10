import { projectColorCells } from '../lib/project-palette';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { WORKSTREAM_ICON_KEYS, type WorkstreamAppearance, type WorkstreamAppearancePatch } from '@rally/contracts';
import { useEffect, useRef, useState } from 'react';
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
export function AppearancePicker({ id, appearance, label: triggerLabel, renderGlyph, onChange }: {
  id: string;
  appearance?: WorkstreamAppearance;
  /** The trigger's accessible name, and the popup's: "Change X icon and color". */
  label: string;
  /** The glyph, drawn from the appearance *including* choices not yet committed. */
  renderGlyph: (appearance: WorkstreamAppearance) => React.ReactNode;
  onChange: (patch: WorkstreamAppearancePatch) => Promise<void>;
}): React.JSX.Element {
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
  const selected = { icon: appearance?.icon ?? WORKSTREAM_ICON_KEYS[generated.iconIndex]!, color: appearance?.color ?? generated.color, ...preview };
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
  return <DropdownMenu.Root onOpenChange={(value) => { open.current = value; setError(null); }}>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={triggerLabel} className="appearance-picker-trigger window-no-drag">
        {renderGlyph(selected)}
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content appearance-picker-popup" align="start" sideOffset={8} collisionPadding={12} aria-label={triggerLabel}>
        <DropdownMenu.Label className="appearance-picker-label">Color</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={selected.color ?? ''} className="appearance-picker-colors" aria-label="Color">
          {projectColorCells().map((color, cell) => (color === null
            ? <span aria-hidden="true" className="appearance-picker-gap" key={`gap-${cell}`} />
            : <DropdownMenu.RadioItem key={color} value={color} aria-label={label(color)} title={label(color)} className="appearance-picker-choice" onSelect={(event) => { event.preventDefault(); change({ color }); }}>
              <span className="appearance-picker-swatch" style={{ background: `var(--av-sys-color-project-${color})` }} />
            </DropdownMenu.RadioItem>))}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="appearance-picker-divider" />
        <DropdownMenu.Label className="appearance-picker-label">Icon</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={selected.icon ?? ''} className="appearance-picker-icons" aria-label="Icon">
          {WORKSTREAM_ICON_KEYS.map((icon) => {
            const Icon = WORKSTREAM_ICON_COMPONENTS[icon];
            return <DropdownMenu.RadioItem key={icon} value={icon} aria-label={label(icon)} title={label(icon)} className="appearance-picker-choice" onSelect={(event) => { event.preventDefault(); change({ icon }); }}>
              <Icon size={20} strokeWidth={1.8}  />
            </DropdownMenu.RadioItem>;
          })}
        </DropdownMenu.RadioGroup>
        {error && <p role="alert" className="appearance-picker-error">{error}</p>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
