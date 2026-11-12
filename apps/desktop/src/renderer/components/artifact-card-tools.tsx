import type { CanvasArtifactVisibility } from '@rally/contracts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconCheck, IconChevronDown, IconExternalLink } from '@tabler/icons-react';
import { useState } from 'react';
import { ARTIFACT_VISIBILITY_OPTIONS } from '../lib/canvas-sharing';
import { CopyButton } from './copy-button';
import { ErrorNotice, IconButton, Tip } from './primitives';

/**
 * Who can open a Canvas's artifacts, as the card offers it.
 *
 * The setting belongs to the Canvas, not the artifact: changing it from one
 * card changes it for every artifact the Canvas published, and the menu says so.
 */
export interface ArtifactAudienceControl {
  readonly value: CanvasArtifactVisibility;
  /** False for anyone who is not the Canvas's creator or an administrator. */
  readonly canChange: boolean;
  /** Settles once the Canvas has saved it; the host reports a failure. */
  readonly change: (value: Exclude<CanvasArtifactVisibility, 'participants'>) => Promise<void>;
  /** Choosing people needs a picker, which the Share panel already is. */
  readonly choosePeople: () => void;
}

/** What a card for a published artifact can do besides open its preview. */
export interface ArtifactCardControls {
  /** The artifact's stable public address. It carries no access code. */
  readonly link: () => Promise<string>;
  /** Open in the system browser, signed in as this person. */
  readonly openInBrowser: () => Promise<void>;
  /** Absent where the conversation is not a Canvas's. */
  readonly audience?: ArtifactAudienceControl | undefined;
}

const MENU_ORDER = ['editors', 'participants', 'workspace', 'public'] as const;

function AudienceMenu({ audience, title }: { audience: ArtifactAudienceControl; title: string }): React.JSX.Element {
  // Shown at once, while the Canvas saves it, so the pill answers the click.
  const [saving, setSaving] = useState<CanvasArtifactVisibility | null>(null);
  const shown = ARTIFACT_VISIBILITY_OPTIONS[saving ?? audience.value];
  const Icon = shown.icon;
  const pill = (
    <span className="artifact-audience-pill-content">
      <Icon aria-hidden="true" size={14} stroke={1.8} />
      <span>{shown.short}</span>
    </span>
  );
  if (!audience.canChange) {
    return (
      <Tip label={`${shown.label} can open this. Only the Canvas’s creator and administrators can change it.`}>
        <span aria-label={`Who can open ${title}: ${shown.label}`} className="artifact-audience-pill is-static" role="note" tabIndex={0}>{pill}</span>
      </Tip>
    );
  }
  const choose = (value: string): void => {
    // Specific people is handled by its item's own select, below: it must
    // reopen the picker even when it is already the value, which a radio
    // group's change never reports.
    if (saving || value === 'participants') return;
    const next = value as Exclude<CanvasArtifactVisibility, 'participants'>;
    setSaving(next);
    void audience.change(next).catch(() => undefined).finally(() => setSaving(null));
  };
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-busy={saving !== null}
        aria-label={`Who can open ${title}: ${shown.label}`}
        className="artifact-audience-pill"
        disabled={saving !== null}
      >
        {pill}
        <IconChevronDown aria-hidden="true" className="artifact-audience-chevron" size={12} stroke={2} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="menu-content artifact-audience-menu" collisionPadding={8} sideOffset={4}>
          <DropdownMenu.Label className="menu-label">
            Who can open artifacts
            <small>Applies to every artifact in this Canvas.</small>
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup onValueChange={choose} value={audience.value}>
            {MENU_ORDER.map((value) => {
              const option = ARTIFACT_VISIBILITY_OPTIONS[value];
              const OptionIcon = option.icon;
              return (
                <DropdownMenu.RadioItem
                  className="menu-item"
                  key={value}
                  onSelect={value === 'participants' ? () => audience.choosePeople() : undefined}
                  value={value}
                >
                  <OptionIcon aria-hidden="true" size={15} stroke={1.8} />
                  <span className="artifact-audience-option">{value === 'participants' ? `${option.label}…` : option.label}</span>
                  <DropdownMenu.ItemIndicator className="artifact-audience-check">
                    <IconCheck aria-hidden="true" size={14} stroke={2} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The controls at the end of a published artifact's card: who can open it,
 * copy its link, open it in the browser. They sit beside the card's own button
 * rather than inside it, since a button cannot hold buttons.
 */
export function ArtifactCardTools({ controls, title }: { controls: ArtifactCardControls; title: string }): React.JSX.Element {
  const [openFailure, setOpenFailure] = useState<{ message: string } | undefined>();
  return (
    <span className="artifact-card-tools">
      {controls.audience && <AudienceMenu audience={controls.audience} title={title} />}
      <CopyButton label="Copy link" size={15} tooltipSide="top" value={controls.link} />
      <IconButton
        label="Open in browser"
        onClick={() => void controls.openInBrowser().then(() => setOpenFailure(undefined), (cause: unknown) => setOpenFailure({ message: cause instanceof Error && cause.message ? cause.message : 'Try again.' }))}
        tooltipSide="top"
      >
        <IconExternalLink aria-hidden="true" size={15} stroke={1.8} />
      </IconButton>
      {openFailure && <ErrorNotice occurrence={openFailure} title="The artifact could not be opened">{openFailure.message}</ErrorNotice>}
    </span>
  );
}
