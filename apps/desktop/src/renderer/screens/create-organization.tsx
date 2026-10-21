import { Building2, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Button, ErrorNotice, RallyMark } from '../components/primitives';
import { isComposingKeyEvent } from '../lib/ime';
import { reportTelemetryProductIntent, uuidV7 } from '../lib/telemetry';

/**
 * The organization-name step, shared by the Mac app's first run and the
 * browser's signed-in screen. Each host supplies how the organization is
 * created: the Mac app through its bridge, the browser through its cookie.
 * Organizations are created on Global, so no deployment is offered.
 */
export type CreateOrganizationOperation = { fingerprint: string; id: string } | null;

export function CreateOrganizationCard({ initialName = '', suggestedName = null, onCreate, operation, children }: {
  initialName?: string;
  /**
   * A name read from the email domain's homepage. It arrives after the card
   * opens, so it fills the field only while the field is still empty and
   * untouched: it never replaces what the person typed or a remembered name.
   */
  suggestedName?: string | null;
  /**
   * Where the pending operation id lives. A host that can unmount the card
   * mid-create passes its own, so a retry after coming back reuses the id and
   * returns the same organization rather than a second one.
   */
  operation?: MutableRefObject<CreateOrganizationOperation>;
  /** Resolves once the organization is open, or rejects with what to show. */
  onCreate: (name: string, operationId: string) => Promise<void>;
  /** Below the button: who is signed in, and the way out. */
  children?: ReactNode;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(false);
  const ownOperation = useRef<CreateOrganizationOperation>(null);
  const createOperation = operation ?? ownOperation;

  useEffect(() => {
    if (suggestedName && !edited.current && !initialName.trim()) setName(suggestedName);
  }, [initialName, suggestedName]);

  const continueSetup = async (): Promise<void> => {
    // Holding Enter repeats it, and the button stays reachable while the first
    // create is in flight: without this each repeat mints a fresh operation id,
    // so the server answers the second one with a conflict on the reservation
    // the first one took, and the funnel counts a workspace_create_requested
    // per keystroke. The button's own `disabled` covers only the pointer.
    if (working) return;
    if (name.trim().length < 2) return;
    const fingerprint = JSON.stringify({ name: name.trim(), region: 'global' });
    const operation = createOperation.current?.fingerprint === fingerprint
      ? createOperation.current
      : { fingerprint, id: uuidV7() };
    createOperation.current = operation;
    const operationId = operation.id;
    reportTelemetryProductIntent({
      kind: 'workspace_create_requested',
      selectedRegion: 'global',
      entrypoint: 'first_run',
      operationId,
    });
    setWorking(true);
    setError(null);
    try {
      await onCreate(name, operationId);
      createOperation.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Rally could not create this organization.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="onboarding-card workspace-setup-card window-no-drag" aria-labelledby="workspace-heading">
      <RallyMark className="signin-mark" />
      <div className="onboarding-copy">
        <h1 id="workspace-heading">Create your organization</h1>
        <p>A shared home for your team and Rally.</p>
      </div>

      <label className="onboarding-field">
        <span>Organization name</span>
        <span className="onboarding-input-wrap">
          <Building2 aria-hidden="true" size={16} />
          <input
            autoComplete="organization"
            autoFocus
            maxLength={120}
            onChange={(event) => {
              edited.current = true;
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              // A plain input rather than a ComposerInput, so this field
              // keeps its own copy of the guard. See `../lib/ime.ts`.
              if (isComposingKeyEvent(event.nativeEvent)) return;
              if (event.key === 'Enter') void continueSetup();
            }}
            placeholder="Acme"
            value={name}
          />
        </span>
      </label>

      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Button className="button-primary onboarding-continue" disabled={working || name.trim().length < 2} onClick={() => void continueSetup()}>
        {working && <LoaderCircle aria-hidden="true" className="spin" size={16} />}
        Create organization
      </Button>
      {children}
    </section>
  );
}
