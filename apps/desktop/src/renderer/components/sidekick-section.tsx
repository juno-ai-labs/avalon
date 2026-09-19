import type { SidekickAttachment, SidekickRecommendationOptions } from '@rally/contracts';
import type { WorkstreamAutomationSummary } from '../lib/types';
import type { SidekickRow } from '@rally/ui/components/sidekick-section';
export type { SidekickRow } from '@rally/ui/components/sidekick-section';
import { SidekickSection as SharedSidekickSection } from '@rally/ui/components/sidekick-section';

export type { SidekickSectionFailure } from '@rally/ui/components/sidekick-section';
import { desktopBridge } from '../lib/platform';
export function SidekickSection(props: React.ComponentProps<typeof SharedSidekickSection>): React.JSX.Element | null {
  return <SharedSidekickSection {...props} onOpen={(id) => { void desktopBridge().openSidekicks(id); }} />;
}
/**
 * The Sidekicks of one work stream: the ones it owns, then the ones its
 * conversation has loaded.
 *
 * Owned first because those are the room's — created here, managed by its
 * participants, and listed nowhere else in the product. The union is keyed by
 * id rather than concatenated: a room's own loadable Sidekick that has been
 * loaded in the main conversation is in both answers, and it is one Sidekick.
 * Where it is in both, the owned summary supplies the row — it carries the
 * chosen appearance and the live lifecycle, which an attachment does not — and
 * the attachment supplies the removal, which is the one thing only it can say.
 *
 * `undefined` until all three answers are in, for the reason `SidekickSection`
 * separates the two states: a half-answered union rendered as `[]` is a claim
 * that the room has no Sidekicks.
 */
export function workstreamSidekickRows({ owned, attached, recommended, onRemoveAttachment, recommendationOptions, managementOptionsPending = !recommendationOptions, onChangeRecommendation }: {
  owned: WorkstreamAutomationSummary[] | undefined;
  attached: SidekickAttachment[] | undefined;
  recommended: SidekickAttachment[] | undefined;
  onRemoveAttachment?: ((id: string) => void) | undefined;
  recommendationOptions?: SidekickRecommendationOptions | undefined;
  managementOptionsPending?: boolean;
  onChangeRecommendation?: ((id: string, attached: boolean) => void) | undefined;
}): SidekickRow[] | undefined {
  if (!owned || !attached || !recommended) return undefined;
  const attachments = new Map(attached.map((attachment) => [attachment.id, attachment]));
  const rows: SidekickRow[] = owned.map((sidekick) => {
    const attachment = attachments.get(sidekick.id);
    // Lifecycle first, because that is the owned summary's to state; then the
    // attachment's own answer, which is the other direction of the rule above.
    // An `active` Sidekick can still be an unavailable attachment — publishing
    // a triggered revision over an instruction-only one clears `loadable`
    // while the room's conversation keeps the attachment — and the row would
    // otherwise say nothing about a Sidekick its next run will not load.
    const note = ownedNote(sidekick.status) ?? (attachment && !attachment.available ? 'Unavailable' : undefined);
    return {
      id: sidekick.id,
      recommended: true,
      name: sidekick.name,
      description: sidekick.description,
      ...(sidekick.appearance ? { appearance: sidekick.appearance } : {}),
      ...(note ? { note } : {}),
      ...(attachment && onRemoveAttachment
        ? { onRemove: () => onRemoveAttachment(sidekick.id) }
        : {}),
    };
  });
  const ownedIds = new Set(owned.map((sidekick) => sidekick.id));
  for (const attachment of attached) {
    if (ownedIds.has(attachment.id)) continue;
    rows.push({
      id: attachment.id,
      name: attachment.name,
      description: attachment.description,
      ...(attachment.available ? {} : { note: 'Unavailable' }),
      ...(onRemoveAttachment ? { onRemove: () => onRemoveAttachment(attachment.id) } : {}),
    });
  }
  for (const recommendation of recommended) {
    const existing = rows.find((row) => row.id === recommendation.id);
    if (existing) {
      existing.recommended = true;
    }
    else rows.push({ id: recommendation.id, name: recommendation.name, description: recommendation.description,
      recommended: true, ...(recommendation.available ? {} : { note: 'Unavailable' }),
    });
  }
  if (managementOptionsPending && onChangeRecommendation) {
    for (const row of rows) row.managementPending = !ownedIds.has(row.id);
  }
  if (recommendationOptions?.canManage && onChangeRecommendation) {
    for (const row of rows) {
      const option = recommendationOptions.items.find((item) => item.id === row.id);
      if (!option || ownedIds.has(row.id)) continue;
      if (option.attached) row.onRemoveRecommendation = () => onChangeRecommendation(row.id, false);
      else row.onRecommend = () => onChangeRecommendation(row.id, true);
    }
  }
  return rows;
}
/** A lifecycle worth saying out loud; an active Sidekick needs no note. */
function ownedNote(status: WorkstreamAutomationSummary['status']): string | undefined {
  return status === 'draft' ? 'Draft' : status === 'paused' ? 'Paused' : undefined;
}
