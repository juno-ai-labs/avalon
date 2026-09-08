import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { PROJECT_COLOR_KEYS, WORKSTREAM_ICON_KEYS, type WorkstreamAppearance, type WorkstreamAppearancePatch } from '@rally/contracts';
import { useRef, useState } from 'react';
import { WORKSTREAM_ICON_COMPONENTS, WorkstreamGlyph, workstreamAppearance } from './workstream-glyph';

function label(key: string): string {
  return key === 'orange' ? 'Neon yellow' : key.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

export function WorkstreamAppearancePicker({ id, appearance, size, onChange }: {
  id: string;
  appearance?: WorkstreamAppearance;
  size: number;
  onChange: (patch: WorkstreamAppearancePatch) => Promise<void>;
}): React.JSX.Element {
  const [pending, setPending] = useState<{ patch: WorkstreamAppearancePatch; baseline: WorkstreamAppearance | undefined; saved: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const generated = workstreamAppearance(id);
  const preview = pending && (!pending.saved || pending.baseline === appearance) ? pending.patch : {};
  const selected = { icon: appearance?.icon ?? WORKSTREAM_ICON_KEYS[generated.iconIndex]!, color: appearance?.color ?? generated.color, ...preview };
  const change = (patch: WorkstreamAppearancePatch): void => {
    const revision = ++sequence.current;
    setPending({ patch: { ...preview, ...patch }, baseline: appearance, saved: false });
    setError(null);
    // The connection owns ordering, including when this picker unmounts.
    void onChange(patch).then(() => {
      if (sequence.current === revision) setPending((current) => current ? { ...current, saved: true } : null);
    }).catch(() => {
      if (sequence.current === revision) {
        setPending(null);
      }
      setError('Couldn’t update the appearance. Please choose again.');
    });
  };
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label="Change work-stream icon and color" className="workstream-appearance-trigger window-no-drag">
        <WorkstreamGlyph id={id} appearance={selected} size={size} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content workstream-appearance-popup" align="start" sideOffset={8} collisionPadding={12} aria-label="Work-stream appearance">
        <DropdownMenu.Label className="workstream-appearance-label">Color</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={selected.color ?? ''} className="workstream-appearance-colors" aria-label="Color">
          {PROJECT_COLOR_KEYS.map((color) => <DropdownMenu.RadioItem key={color} value={color} aria-label={label(color)} title={label(color)} className="workstream-appearance-choice" onSelect={(event) => { event.preventDefault(); change({ color }); }}>
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
