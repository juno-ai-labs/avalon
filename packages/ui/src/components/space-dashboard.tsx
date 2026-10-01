import type { WorkstreamAppearancePatch } from '@rally/contracts';
import { UserPlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { isComposingKeyEvent } from '../lib/ime';
import type { WorkspaceMember } from '../lib/types';
import { AppearancePicker } from './appearance-picker';
import { AvatarStack, DropdownSelect, InlineError } from './primitives';
import { SpaceIcon, type SpaceAppearance } from './space-icon';

/**
 * The Space dashboard's presentation, section by section.
 *
 * A Space has no feed, so this screen is its only surface: the name, mark and
 * audience a person edits, and the Channels in it. Each export here takes data
 * and callbacks and performs no mutation — the host owns the API and which
 * controls a viewer's role may be drawn at all (the server reauthorizes every
 * one of them).
 */

/** The two words a Space's audience is said in, everywhere it is chosen. */
export const SPACE_SCOPE_OPTIONS = [
  { label: 'Space participants', value: 'personal' },
  { label: 'Everyone in the organization', value: 'workspace' },
] as const;

/**
 * The header: mark, name, audience and participants.
 *
 * The rename interaction lives here rather than in the host because it is
 * presentation — a double-click, F2, Enter to commit, Escape to abandon, blur
 * to commit — and the host only ever learns the committed name. `onRename`
 * resolving is what retires the draft, so a rejected rename leaves the reader
 * in the field they were typing in with the error under it.
 */
export function SpaceDashboardHeader({
  actions,
  appearance,
  audience,
  editable,
  name,
  nameError,
  id,
  onAppearanceChange,
  onRename,
  participants,
}: {
  /** Archive, restore — whatever the lifecycle allows this Space. */
  actions?: ReactNode;
  appearance: SpaceAppearance;
  /**
   * The audience control, or omitted for a Space whose audience is not the
   * reader's to change. General is the only one today; its Organization-wide
   * audience is immutable, so it is drawn without the question.
   */
  audience?: { scope: 'personal' | 'workspace'; onChange: (scope: 'personal' | 'workspace') => void } | undefined;
  editable: boolean;
  name: string;
  nameError?: string | null | undefined;
  /** The Space's id; the picker keys its pending choices on it. */
  id: string;
  /**
   * Save one icon or colour choice. The header opens the same picker a Channel
   * does, which saves on every click; the promise settling is what retires the
   * choice's preview or shows its error.
   */
  onAppearanceChange: (patch: WorkstreamAppearancePatch) => Promise<void>;
  onRename: (name: string) => void;
  /**
   * The Space's people, and the control that opens their management. Omitted
   * when the viewer may not manage them.
   */
  participants?: { members: WorkspaceMember[]; onManage: () => void } | undefined;
}): React.JSX.Element {
  // The draft, while one is open. The host keys this header on the Space id, so
  // navigating to another Space unmounts the field rather than carrying a name
  // typed for one Space onto the next one's blur.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    const next = draft?.trim() ?? '';
    setDraft(null);
    if (next && next !== name) onRename(next);
  };
  return (
    <header className="space-dashboard-header window-drag">
      {editable
        ? <AppearancePicker
            appearance={{ icon: appearance.iconKey, color: appearance.colorKey }}
            id={id}
            label={`Change icon and color for ${name}`}
            onChange={onAppearanceChange}
            renderGlyph={(chosen) => <SpaceIcon size={24} space={{
              iconKey: chosen.icon ?? appearance.iconKey,
              colorKey: chosen.color ?? appearance.colorKey,
            }} />}
            triggerClassName="space-dashboard-icon"
          />
        : <span className="space-dashboard-icon"><SpaceIcon space={appearance} size={24} /></span>}
      <div className="space-dashboard-title">
        {draft === null
          ? <h1><button
              aria-keyshortcuts="Enter F2"
              className="space-name-button window-no-drag"
              onClick={(event) => {
                // `detail === 0` is the keyboard's activation of the button;
                // a pointer's first click is not a rename request.
                if (event.detail === 0 && editable) setDraft(name);
              }}
              onDoubleClick={() => { if (editable) setDraft(name); }}
              onKeyDown={(event) => {
                if (event.key === 'F2' && editable) {
                  event.preventDefault();
                  setDraft(name);
                }
              }}
              title={editable ? 'Double-click to rename' : undefined}
              type="button"
            >{name}</button></h1>
          : <input
              aria-label="Space name"
              autoFocus
              className="space-name-input window-no-drag"
              maxLength={180}
              onBlur={commit}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (isComposingKeyEvent(event.nativeEvent)) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(null);
                }
              }}
              size={Math.max(6, Math.min(40, draft.length + 1))}
              value={draft}
            />}
        {audience && (
          <p className="space-dashboard-audience">
            <span className="window-no-drag">
              <DropdownSelect
                ariaLabel="Space audience"
                disabled={!editable}
                onValueChange={(value) => audience.onChange(value as 'personal' | 'workspace')}
                options={[...SPACE_SCOPE_OPTIONS]}
                value={audience.scope}
                variant="secondary"
              />
            </span>
          </p>
        )}
        {nameError && <InlineError>{nameError}</InlineError>}
      </div>
      <div className="space-dashboard-header-actions window-no-drag">
        {participants && (
          <button
            className="participant-header-button"
            disabled={!editable}
            onClick={participants.onManage}
            type="button"
          >
            <AvatarStack members={participants.members} />
            <UserPlus aria-hidden="true" size={13} />
            <span className="sr-only">Manage participants</span>
          </button>
        )}
        {actions}
      </div>
    </header>
  );
}

/** One titled band around the Space dashboard's Channel list. */
export function SpaceDashboardSection({ children, heading, headingId }: {
  children: ReactNode;
  heading: string;
  headingId: string;
}): React.JSX.Element {
  return (
    <section aria-labelledby={headingId} className="space-dashboard-section">
      <div className="space-dashboard-section-heading">
        <div className="space-dashboard-section-copy">
          <h2 id={headingId}>{heading}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}
