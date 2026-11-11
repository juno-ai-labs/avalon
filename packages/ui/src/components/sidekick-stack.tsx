import { Tip, TipGroup } from './primitives';
import { AutomationGlyph, HexagonGlyph } from './workstream-glyph';

/** A Sidekick as a stack draws it: its mark and its name. */
export interface StackedSidekick {
  id: string;
  name: string;
  appearance?: Parameters<typeof AutomationGlyph>[0]['appearance'];
}

/**
 * Sidekicks as a row of overlapping hexagons, the way `AvatarStack` draws
 * people: the first `limit` marks, then how many more there are. The stack is
 * named as a whole (`Sidekicks: Launch tracker; Weekly digest`), so a surface
 * that already describes itself can point at it rather than each mark.
 * `limit` is `AvatarStack`'s own, so a card's two stacks cut off alike.
 */
export function SidekickStack({ sidekicks, limit = 4, id }: {
  sidekicks: readonly StackedSidekick[];
  limit?: number;
  id?: string;
}): React.JSX.Element | null {
  if (sidekicks.length === 0) return null;
  const visible = sidekicks.slice(0, limit);
  const overflow = sidekicks.length - visible.length;
  const names = sidekicks.slice(0, limit).map((sidekick) => sidekick.name);
  if (overflow > 0) names.push(`and ${overflow} more`);
  const label = `Sidekicks: ${names.join('; ')}`;
  // The label is also text, hidden from sight: an `aria-describedby` that
  // points here reads content, and an `aria-label` alone describes nothing.
  return <span aria-label={label} className="sidekick-stack" id={id} role="img">
    <span className="sr-only">{label}</span>
    <TipGroup>
      {visible.map((sidekick) => <Tip describesTrigger={false} key={sidekick.id} label={sidekick.name}>
        <span aria-hidden="true" className="sidekick-stack-item">
          <AutomationGlyph {...(sidekick.appearance ? { appearance: sidekick.appearance } : {})} id={sidekick.id} />
        </span>
      </Tip>)}
      {overflow > 0 && <Tip describesTrigger={false} label={sidekicks.slice(visible.length).map((sidekick) => sidekick.name).join('; ')}>
        <span aria-hidden="true" className="sidekick-stack-item sidekick-stack-overflow">
          <HexagonGlyph fill="var(--av-ref-color-neutral-4)" ink="var(--av-sys-color-text-muted)" symbol={`+${overflow}`} />
        </span>
      </Tip>}
    </TipGroup>
  </span>;
}
