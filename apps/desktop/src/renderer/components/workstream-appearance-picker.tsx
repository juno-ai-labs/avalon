import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { PROJECT_COLOR_CHOICES, WORKSTREAM_ICON_KEYS, paintProjectColor, type WorkstreamAppearance, type WorkstreamAppearancePatch } from '@rally/contracts';
import { useEffect, useRef, useState } from 'react';
import { WORKSTREAM_ICON_COMPONENTS, WorkstreamGlyph, workstreamAppearance } from './workstream-glyph';

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

export function WorkstreamAppearancePicker({ id, appearance, size, onChange }: {
  id: string;
  appearance?: WorkstreamAppearance;
  size: number;
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
      <button type="button" aria-label="Change work-stream icon and color" className="workstream-appearance-trigger window-no-drag">
        <WorkstreamGlyph id={id} appearance={selected} size={size} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content workstream-appearance-popup" align="start" sideOffset={8} collisionPadding={12} aria-label="Work-stream appearance">
        <DropdownMenu.Label className="workstream-appearance-label">Color</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={paintProjectColor(selected.color ?? generated.color)} className="workstream-appearance-colors" aria-label="Color">
          {PROJECT_COLOR_CHOICES.map((color) => <DropdownMenu.RadioItem key={color} value={color} aria-label={label(color)} title={label(color)} className="workstream-appearance-choice" onSelect={(event) => { event.preventDefault(); change({ color }); }}>
            <span className="workstream-appearance-swatch" style={{ background: `var(--av-sys-color-project-${color})` }} />
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
        <DropdownMenu.Separator className="workstream-appearance-divider" />
        <DropdownMenu.Label className="workstream-appearance-label">Icon</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={selected.icon ?? ''} className="workstream-appearance-icons" aria-label="Icon">
          {WORKSTREAM_ICON_KEYS.map((icon) => {
            const Icon = WORKSTREAM_ICON_COMPONENTS[icon];
            return <DropdownMenu.RadioItem key={icon} value={icon} aria-label={label(icon)} title={label(icon)} className="workstream-appearance-choice" onSelect={(event) => { event.preventDefault(); change({ icon }); }}>
              <Icon size={20} strokeWidth={1.8}  />
            </DropdownMenu.RadioItem>;
          })}
        </DropdownMenu.RadioGroup>
        {error && <p role="alert" className="workstream-appearance-error">{error}</p>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
